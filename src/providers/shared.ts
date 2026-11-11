import type { ChatMessage, ProviderRequest, ProviderResponse, ToolCall } from "../types.ts";
import { EXIT } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { readLimited, requireHttps } from "../util/http.ts";
import { redactSecrets } from "../util/redact.ts";

/** Sent as max_tokens when a case states none, so every call has a worst-case price. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
/** One first attempt plus at most two retries. */
export const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const BASE_BACKOFF_MS = 500;

/**
 * "none": the provider rejected the request outright, so nothing was billed.
 * "unknown": the request may have been processed, so the budget keeps its worst-case charge.
 */
export type Billing = "none" | "unknown";

export class ProviderError extends SwapcheckError {
  readonly billing: Billing;
  readonly status: number | undefined;
  constructor(message: string, billing: Billing, status?: number) {
    super(redactSecrets(message), EXIT.UNMEASURED);
    this.name = "ProviderError";
    this.billing = billing;
    this.status = status;
  }
}

export interface BudgetedRequest extends ProviderRequest {
  /** Called before each retry. Throwing stops the retry, which is how retries count toward the budget. */
  beforeRetry?: (attempt: number) => void;
}

export interface NormalizedResponse extends ProviderResponse {
  /** Parameters from the case that this provider did not send. */
  dropped_params?: string[];
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface TransportOptions {
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  timeoutMs?: number;
}

export interface ProviderConfig extends TransportOptions {
  apiKey: string;
  baseUrl?: string;
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ProviderError("The request was cancelled.", "none"));
    }, { once: true });
  });

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function excerpt(bytes: Uint8Array): string {
  return redactSecrets(new TextDecoder().decode(bytes.subarray(0, 600))).replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface PostResult {
  json: Record<string, unknown>;
  latencyMs: number;
}

type Attempt = { result: PostResult } | { retry: ProviderError; waitMs?: number };

async function attemptPost(url: string, init: RequestInit, req: BudgetedRequest, label: string, timeout: AbortSignal, timeoutMs: number, fetchImpl: typeof fetch): Promise<Attempt> {
  const started = performance.now();
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetchImpl(url, init);
    bytes = await readLimited(res);
  } catch (error) {
    if (req.signal?.aborted) throw new ProviderError(`The request to ${label} for ${req.model} was cancelled.`, "unknown");
    if (isRedirectError(error)) throw new ProviderError(`${label} answered the request for ${req.model} with a redirect. Swapcheck does not follow redirects, because they could carry your API key to another host. Check the base URL.`, "none");
    if (error instanceof SwapcheckError || !isNetworkError(error)) throw error;
    const reason = timeout.aborted ? `timed out after ${Math.round(timeoutMs / 1000)} seconds` : "could not be reached";
    return { retry: new ProviderError(`${label} ${reason} for ${req.model}.`, "unknown") };
  }
  if (res.ok) return { result: { json: parseObject(bytes, label, res.status), latencyMs: performance.now() - started } };
  const message = `${label} returned HTTP ${res.status} for ${req.model}: ${excerpt(bytes)}`;
  if (!isRetryableStatus(res.status)) throw new ProviderError(message, "none", res.status);
  const waitMs = retryAfterMs(res.headers.get("retry-after"), Date.now());
  if (waitMs !== undefined && waitMs > MAX_RETRY_WAIT_MS) {
    throw new ProviderError(`${label} asked Swapcheck to wait ${Math.ceil(waitMs / 1000)} seconds before retrying ${req.model}, which is longer than the ${MAX_RETRY_WAIT_MS / 1000} second limit. Lower the concurrency or try again later.`, "unknown", res.status);
  }
  return { retry: new ProviderError(message, "unknown", res.status), waitMs };
}

function parseObject(bytes: Uint8Array, label: string, status: number): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = undefined;
  }
  if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
  throw new ProviderError(`${label} returned a response that was not a JSON object.`, "unknown", status);
}

/** POSTs JSON with bounded retries. Only the header map carries keys, and it is never logged or echoed. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  req: BudgetedRequest,
  label: string,
  options: TransportOptions,
): Promise<PostResult> {
  requireHttps(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(body);
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) req.beforeRetry?.(attempt);
    // A referenced timer, unlike AbortSignal.timeout, keeps the process alive until the request settles.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);
    const timeout = controller.signal;
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal, redirect: "error" };
    let outcome: Attempt;
    try {
      outcome = await attemptPost(url, init, req, label, timeout, timeoutMs, fetchImpl);
    } finally {
      clearTimeout(timer);
    }
    if ("result" in outcome) return outcome.result;
    lastError = outcome.retry;
    if (attempt < MAX_ATTEMPTS - 1) await sleep(outcome.waitMs ?? BASE_BACKOFF_MS * 2 ** attempt, req.signal);
  }
  throw lastError ?? new ProviderError(`${label} did not respond for ${req.model}.`, "unknown");
}

/** With redirect: "error", Node reports the cause in `cause` and Bun in the error itself. */
function isRedirectError(error: unknown): boolean {
  const text = (value: unknown): string => (value instanceof Error ? `${value.name} ${value.message} ${(value as NodeJS.ErrnoException).code ?? ""}` : "");
  return /redirect/i.test(text(error)) || /redirect/i.test(text((error as Error | undefined)?.cause));
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

/** A tool call whose arguments are text: parsed when possible, kept raw when not. */
export function parseToolArguments(id: string, name: string, raw: unknown): ToolCall {
  if (typeof raw !== "string") return { id, name, arguments: raw ?? {} };
  try {
    return { id, name, arguments: JSON.parse(raw === "" ? "{}" : raw) };
  } catch {
    return { id, name, arguments: null, raw_arguments: raw };
  }
}

export function stringifyToolArguments(call: ToolCall): string {
  return call.raw_arguments ?? JSON.stringify(call.arguments ?? {});
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Removes a leading "vendor/" so a registry-style id can go to that vendor's own API. */
export function stripVendorPrefix(model: string, prefixes: string[]): string {
  const slash = model.indexOf("/");
  if (slash > 0 && prefixes.includes(model.slice(0, slash).toLowerCase())) return model.slice(slash + 1);
  return model;
}

/** Drops trailing slashes. A loop, not a regex, so a URL ending in many slashes stays linear. */
export function trimBaseUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

export function maxTokensOf(req: ProviderRequest): number {
  return req.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Name of the tool a tool-role message answers, found from the assistant turn that called it. */
export function toolNameFor(messages: ChatMessage[], index: number): string {
  const id = messages[index]?.tool_call_id;
  for (let i = index - 1; i >= 0; i--) {
    const match = messages[i]?.tool_calls?.find((call) => call.id === id);
    if (match) return match.name;
  }
  return id ?? "tool";
}
