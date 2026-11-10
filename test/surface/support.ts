import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ModelCapabilities, RegistryEvent, RegistryModel, RegistrySnapshot } from "../../src/types.ts";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = path.join(REPO_ROOT, "dist/cli.mjs");
export const ACTION = path.join(REPO_ROOT, "action-dist/index.mjs");

export function tempDir(prefix = "swapcheck-test-"): string {
  // realpath so the macOS /var -> /private/var link does not make paths look like they escaped.
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export async function ensureBuilt(): Promise<void> {
  await execFileAsync(process.execPath, ["build.mjs"], { cwd: REPO_ROOT, timeout: 120_000 });
}

/** A bare environment: no inherited keys, and a private cache so runs never see the developer's. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const windows = Object.fromEntries(["SystemRoot", "SYSTEMROOT", "PATHEXT", "TEMP", "TMP", "ComSpec"].flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])));
  return { ...windows, PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, ".cache"), LOCALAPPDATA: path.join(home, "AppData"), NO_COLOR: "1", ...extra };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a node script to completion. stdin is closed, so isTTY is false, exactly as under CI. */
export function runNode(script: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return runProcess(process.execPath, [script, ...args], options);
}

function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, ms: performance.now() - started }));
  });
}

/** Set SWAPCHECK_E2E_BINARY to run the CLI suites against a `bun build --compile` binary instead of Node. */
export const BINARY = process.env.SWAPCHECK_E2E_BINARY;

export function cliCommand(args: string[]): { command: string; args: string[] } {
  return BINARY ? { command: BINARY, args } : { command: process.execPath, args: [CLI, ...args] };
}

export function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  const { command, args: full } = cliCommand(args);
  return runProcess(command, full, options);
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, timeout: 30_000 });
  return stdout.trim();
}

export function bundledSnapshot(): RegistrySnapshot {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "data/registry.snapshot.json"), "utf8")) as RegistrySnapshot;
}

const CAPS: ModelCapabilities = { tools: true, structured_output: true, reasoning: false, vision: false, audio: false, pdf: false };

export function testModel(id: string, provider: string, route: string, overrides: Partial<RegistryModel> = {}): RegistryModel {
  return { id, provider, route, name: id, status: "active", capabilities: CAPS, limit: { context: 200_000, output: 8_000 }, cost: { input: 1, output: 5 }, source: "https://example.com/models", ...overrides };
}

export function testEvent(overrides: Partial<RegistryEvent> & Pick<RegistryEvent, "id" | "type" | "model">): RegistryEvent {
  return { provider: "openai", route: "openai-api", source: "https://example.com/changelog", confidence: "high", first_seen: "2026-01-01", last_verified: "2026-11-01", ...overrides };
}

/** A small registry where gpt-4o retires and gpt-4.1 rejects temperature. */
export function testSnapshot(): RegistrySnapshot {
  return {
    version: 1,
    generated_at: "2026-11-01T00:00:00Z",
    models: [testModel("gpt-4o", "openai", "openai-api", { status: "deprecated" }), testModel("gpt-4.1", "openai", "openai-api")],
    events: [
      testEvent({ id: "evt-retire", type: "retirement", model: "gpt-4o", to: "gpt-4.1", effective: "2026-12-01", date_precision: "exact", successor_basis: "provider_named" }),
      testEvent({ id: "evt-param", type: "parameter_change", model: "gpt-4.1", params: ["temperature", "top_p"] }),
    ],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export interface ProviderCall {
  vendor: "openai" | "anthropic" | "gemini";
  model: string;
  auth: string;
  body: Record<string, any>;
}

export type Replier = (call: ProviderCall) => string;

export interface FakeProviders {
  url: string;
  calls: ProviderCall[];
  close(): Promise<void>;
}

/** One local server speaking the three vendors' wire formats. */
export async function startFakeProviders(reply: Replier): Promise<FakeProviders> {
  const calls: ProviderCall[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
      const url = new URL(req.url ?? "/", "http://local");
      const usage = { in: 10, out: 5 };
      if (url.pathname.endsWith("/chat/completions")) {
        const call: ProviderCall = { vendor: "openai", model: body.model, auth: req.headers.authorization ?? "", body };
        calls.push(call);
        sendJson(res, 200, { id: "c", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply(call) } }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } });
      } else if (url.pathname === "/v1/messages") {
        const call: ProviderCall = { vendor: "anthropic", model: body.model, auth: String(req.headers["x-api-key"] ?? ""), body };
        calls.push(call);
        sendJson(res, 200, { id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply(call) }], stop_reason: "end_turn", usage: { input_tokens: usage.in, output_tokens: usage.out } });
      } else if (url.pathname.includes(":generateContent")) {
        const model = decodeURIComponent(url.pathname.slice(url.pathname.indexOf("/models/") + 8).replace(":generateContent", ""));
        const call: ProviderCall = { vendor: "gemini", model, auth: String(req.headers["x-goog-api-key"] ?? url.searchParams.get("key") ?? ""), body };
        calls.push(call);
        sendJson(res, 200, { modelVersion: model, candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: reply(call) }] } }], usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out } });
      } else {
        sendJson(res, 404, { error: { message: `unexpected ${url.pathname}` } });
      }
    })().catch((error: unknown) => sendJson(res, 500, { error: { message: String(error) } }));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export function blobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { type: string; login: string };
}

export interface FakeGitHub {
  url: string;
  files: Map<string, string>;
  blobs: Map<string, string>;
  trees: Array<Array<{ path: string; sha: string; mode: string }>>;
  commits: Array<{ message: string; tree: string; parents: string[] }>;
  refs: Map<string, string>;
  pulls: Array<{ number: number; title: string; head: string; base: string; body: string; html_url: string }>;
  comments: GitHubComment[];
  requests: Array<{ method: string; path: string; auth: string }>;
  close(): Promise<void>;
}

const BASE_SHA = "b".repeat(40);

/** Enough of the REST API for branches, commits, pull requests and comments, with real state. */
export async function startFakeGitHub(repo: string, files: Record<string, string>, comments: GitHubComment[] = []): Promise<FakeGitHub> {
  const state: Omit<FakeGitHub, "url" | "close"> = { files: new Map(Object.entries(files)), blobs: new Map(), trees: [], commits: [], refs: new Map([["heads/main", BASE_SHA]]), pulls: [], comments: [...comments], requests: [] };
  const prefix = `/repos/${repo}`;
  let counter = 1;
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
      const url = new URL(req.url ?? "/", "http://local");
      const method = req.method ?? "GET";
      state.requests.push({ method, path: `${url.pathname}${url.search}`, auth: req.headers.authorization ?? "" });
      if (req.headers.authorization !== "Bearer test-github-token") return sendJson(res, 401, { message: "Bad credentials" });
      if (!url.pathname.startsWith(prefix)) return sendJson(res, 404, { message: "Not Found" });
      const route = url.pathname.slice(prefix.length);
      if (method === "GET" && route === "") return sendJson(res, 200, { default_branch: "main" });
      if (route.startsWith("/contents/") && method === "GET") {
        const file = state.files.get(route.slice("/contents/".length).split("/").map(decodeURIComponent).join("/"));
        return file === undefined ? sendJson(res, 404, { message: "Not Found" }) : sendJson(res, 200, { sha: blobSha(file) });
      }
      if (route === "/git/blobs" && method === "POST") {
        const content = Buffer.from(body.content, body.encoding).toString("utf8");
        const sha = blobSha(content);
        state.blobs.set(sha, content);
        return sendJson(res, 201, { sha });
      }
      if (route.startsWith("/git/commits/") && method === "GET") return sendJson(res, 200, { tree: { sha: "t".repeat(40) } });
      if (route === "/git/trees" && method === "POST") {
        state.trees.push(body.tree);
        return sendJson(res, 201, { sha: `tree${counter++}` });
      }
      if (route === "/git/commits" && method === "POST") {
        state.commits.push({ message: body.message, tree: body.tree, parents: body.parents });
        return sendJson(res, 201, { sha: `commit${counter++}` });
      }
      if (route.startsWith("/git/ref/") && method === "GET") {
        const sha = state.refs.get(route.slice("/git/ref/".length));
        return sha ? sendJson(res, 200, { object: { sha } }) : sendJson(res, 404, { message: "Not Found" });
      }
      if (route === "/git/refs" && method === "POST") {
        state.refs.set(body.ref.replace(/^refs\//, ""), body.sha);
        return sendJson(res, 201, {});
      }
      if (route.startsWith("/git/refs/") && method === "PATCH") {
        state.refs.set(route.slice("/git/refs/".length), body.sha);
        return sendJson(res, 200, {});
      }
      if (route === "/pulls" && method === "GET") {
        const head = url.searchParams.get("head")?.split(":")[1];
        return sendJson(res, 200, state.pulls.filter((pull) => pull.head === head));
      }
      if (route === "/pulls" && method === "POST") {
        const number = state.pulls.length + 100;
        const pull = { number, title: body.title, head: body.head, base: body.base, body: body.body, html_url: `https://github.example/${repo}/pull/${number}` };
        state.pulls.push(pull);
        return sendJson(res, 201, pull);
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(route);
      if (pullMatch && method === "PATCH") {
        const pull = state.pulls.find((p) => p.number === Number(pullMatch[1]));
        if (!pull) return sendJson(res, 404, { message: "Not Found" });
        Object.assign(pull, { title: body.title, body: body.body });
        return sendJson(res, 200, pull);
      }
      const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(route);
      if (commentsMatch && method === "GET") return sendJson(res, 200, state.comments);
      if (commentsMatch && method === "POST") {
        const comment: GitHubComment = { id: 1000 + state.comments.length, body: body.body, user: { type: "Bot", login: "github-actions[bot]" } };
        state.comments.push(comment);
        return sendJson(res, 201, comment);
      }
      const commentMatch = /^\/issues\/comments\/(\d+)$/.exec(route);
      if (commentMatch && method === "PATCH") {
        const comment = state.comments.find((c) => c.id === Number(commentMatch[1]));
        if (!comment) return sendJson(res, 404, { message: "Not Found" });
        comment.body = body.body;
        return sendJson(res, 200, comment);
      }
      return sendJson(res, 404, { message: `unhandled ${method} ${route}` });
    })().catch((error: unknown) => sendJson(res, 500, { message: String(error) }));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, ...state, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface PickedModels {
  retiring: string;
  retiringEvent: RegistryEvent;
  openai: string;
  anthropic: string;
  gemini: string;
}

const FIRST_PARTY: Record<string, string> = { openai: "openai-api", anthropic: "anthropic-api", google: "google-ai-studio" };
const CHAT_NAME: Record<string, RegExp> = { openai: /^gpt-\d/, anthropic: /^claude-/, google: /^gemini-/ };

/** Only IDs served on the vendor's own API, and only on that route, so the provider choice is unambiguous. */
function firstActive(snapshot: RegistrySnapshot, provider: string, except: string[] = []): string {
  const route = FIRST_PARTY[provider];
  const found = snapshot.models.find(
    (m) => m.provider.toLowerCase() === provider && m.route === route && (CHAT_NAME[provider]?.test(m.id) ?? true) && m.status === "active" && m.cost.output > 0 && m.capabilities.tools && !except.includes(m.id) && snapshot.models.every((other) => other.id !== m.id || other.route === route),
  );
  if (!found) throw new Error(`The bundled snapshot has no active ${provider} model.`);
  return found.id;
}

/** Fixture repos use real IDs from the bundled snapshot, so tests follow the data as it changes. */
export function pickModels(snapshot: RegistrySnapshot = bundledSnapshot()): PickedModels {
  // An OpenAI chat model on the first-party API, because fixtures call it through the OpenAI client.
  const event = snapshot.events.find((e) => e.type === "retirement" && e.to && e.effective && e.route === "openai-api" && /^gpt-\d/.test(e.model));
  if (!event) throw new Error("The bundled snapshot has no first-party retirement event with a successor.");
  return { retiring: event.model, retiringEvent: event, openai: firstActive(snapshot, "openai", [event.model]), anthropic: firstActive(snapshot, "anthropic", [event.model]), gemini: firstActive(snapshot, "google", [event.model]) };
}

export function openaiCall(model: string): string {
  return `import OpenAI from "openai";\nconst client = new OpenAI();\nexport const reply = await client.chat.completions.create({ model: "${model}", messages: [] });\n`;
}
