import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ModelCapabilities, RegistryEvent, RegistryModel, RegistrySnapshot } from "../types.ts";
import { EXIT } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { sha256 } from "../util/hash.ts";
import { MAX_RESPONSE_BYTES, readLimited, requireHttps } from "../util/http.ts";
import { isSafeModelId } from "../scan/ids.ts";
import { verifySnapshot } from "./verify.ts";

export const DEFAULT_REGISTRY_URL = "https://allthingsn.github.io/swapcheck-registry/snapshot.json";

export interface LoadedRegistry {
  snapshot: RegistrySnapshot;
  source: "remote" | "cache" | "bundled";
  age_days: number;
}

export interface LoadRegistryOptions {
  url?: string;
  offline?: boolean;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Test seam: replaces the pinned key. The CLI never sets this. */
  publicKeyPem?: string;
  /** Test seam: replaces the import of data/registry.snapshot.json. */
  loadBundled?: () => Promise<unknown>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FRESH_SNAPSHOT_MS = 7 * DAY_MS;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_ROWS = 100_000;
const MAX_STRING = 2048;

const EVENT_TYPES = new Set(["retirement", "reroute", "alias_move", "price_change", "parameter_change", "capability_change", "new_model"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const DATE_PRECISION = new Set(["exact", "earliest_possible", "estimated"]);
const BILLING = new Set(["replacement_rates", "unchanged", "unknown"]);
const SUCCESSOR_BASIS = new Set(["provider_named", "inferred", "none"]);
const MODEL_STATUS = new Set(["active", "deprecated", "retired", "unknown"]);
const CAPABILITY_KEYS: Array<keyof ModelCapabilities> = ["tools", "structured_output", "reasoning", "vision", "audio", "pdf"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCalendarDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Release dates in public catalogs are sometimes only a year or a month. */
function isLooseDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(value)) return true;
  return isCalendarDate(value);
}

function isTimestamp(value: unknown): boolean {
  return isText(value) && !Number.isNaN(Date.parse(value));
}

function inSet(value: unknown, allowed: Set<string>): boolean {
  return typeof value === "string" && allowed.has(value);
}

function isOptionalMember(value: unknown, allowed: Set<string>): boolean {
  return value === undefined || inSet(value, allowed);
}

function isValidEvent(row: unknown): row is RegistryEvent {
  if (!isRecord(row)) return false;
  if (!isText(row.id) || !inSet(row.type, EVENT_TYPES) || !isText(row.provider) || !isText(row.route) || !isSafeModelId(row.model)) return false;
  if (row.to !== undefined && !isSafeModelId(row.to)) return false;
  if (!isText(row.source) || !inSet(row.confidence, CONFIDENCE)) return false;
  if (!isTimestamp(row.first_seen) || !isTimestamp(row.last_verified)) return false;
  if (!isOptionalText(row.to) || !isOptionalText(row.report_url) || !isOptionalText(row.notes)) return false;
  if (row.effective !== undefined && !isCalendarDate(row.effective)) return false;
  if (!isOptionalMember(row.date_precision, DATE_PRECISION)) return false;
  if (!isOptionalMember(row.billing, BILLING) || !isOptionalMember(row.successor_basis, SUCCESSOR_BASIS)) return false;
  if (row.params !== undefined && !(Array.isArray(row.params) && row.params.every(isText))) return false;
  if (row.region_schedule !== undefined && !isRegionSchedule(row.region_schedule)) return false;
  return true;
}

const MAX_REGION_ROWS = 64;

function isRegionSchedule(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REGION_ROWS) return false;
  return value.every((row) => isRecord(row) && isCalendarDate(row.effective) && Array.isArray(row.regions) && row.regions.length > 0 && row.regions.length <= MAX_REGION_ROWS && row.regions.every(isText));
}

function isValidModel(row: unknown): row is RegistryModel {
  if (!isRecord(row)) return false;
  if (!isSafeModelId(row.id) || !isText(row.provider) || !isText(row.route) || !isText(row.name) || !isText(row.source)) return false;
  if (!inSet(row.status, MODEL_STATUS) || !isOptionalText(row.family) || !isOptionalText(row.license)) return false;
  if (row.release_date !== undefined && !isLooseDate(row.release_date)) return false;
  if (row.open_weights !== undefined && typeof row.open_weights !== "boolean") return false;
  if (row.region !== undefined && !(Array.isArray(row.region) && row.region.every(isText))) return false;
  const { capabilities, limit, cost } = row;
  if (!isRecord(capabilities) || !CAPABILITY_KEYS.every((key) => typeof capabilities[key] === "boolean")) return false;
  if (!isRecord(limit) || !isCount(limit.context) || !isCount(limit.output)) return false;
  return isRecord(cost) && isCount(cost.input) && isCount(cost.output);
}

/** Returns the snapshot only if every row is valid; one bad row rejects all of it. */
export function validateSnapshot(value: unknown): RegistrySnapshot | null {
  if (!isRecord(value) || value.version !== 1 || !isTimestamp(value.generated_at)) return null;
  const { events, models } = value;
  if (!Array.isArray(events) || !Array.isArray(models)) return null;
  if (events.length > MAX_ROWS || models.length > MAX_ROWS) return null;
  if (!events.every(isValidEvent) || !models.every(isValidModel)) return null;
  return value as unknown as RegistrySnapshot;
}

/** Signature first: unverified bytes are never decoded or parsed. */
function openSigned(bytes: Uint8Array, signature: string, publicKeyPem: string | undefined): RegistrySnapshot | null {
  if (!verifySnapshot(bytes, signature, publicKeyPem)) return null;
  try {
    return validateSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return path.join(homedir(), "Library", "Caches", "swapcheck");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "swapcheck", "Cache");
  const xdg = env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".cache"), "swapcheck");
}

async function readCapped(file: string, limit: number): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    return new Uint8Array(await handle.readFile());
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface CacheHit {
  snapshot: RegistrySnapshot;
  fresh: boolean;
}

/** The cache directory is writable by other local programs, so it is verified like remote data. */
async function readCache(dir: string, now: Date, publicKeyPem: string | undefined): Promise<CacheHit | null> {
  const [bytes, sig, meta] = await Promise.all([
    readCapped(path.join(dir, "snapshot.json"), MAX_RESPONSE_BYTES),
    readCapped(path.join(dir, "snapshot.json.sig"), MAX_SIGNATURE_BYTES),
    readCapped(path.join(dir, "meta.json"), MAX_SIGNATURE_BYTES),
  ]);
  if (!bytes || !sig) return null;
  const snapshot = openSigned(bytes, Buffer.from(sig).toString("utf8"), publicKeyPem);
  if (!snapshot) return null;
  // meta.json is unsigned, so the signed date also has to be recent or a planted file could pin old data.
  return { snapshot, fresh: isFresh(meta, now) && now.getTime() - generatedAt(snapshot) < MAX_FRESH_SNAPSHOT_MS };
}

function generatedAt(snapshot: RegistrySnapshot): number {
  return Date.parse(snapshot.generated_at);
}

function isFresh(meta: Uint8Array | null, now: Date): boolean {
  if (!meta) return false;
  try {
    const fetchedAt = Date.parse((JSON.parse(Buffer.from(meta).toString("utf8")) as { fetched_at?: string }).fetched_at ?? "");
    const age = now.getTime() - fetchedAt;
    return age >= 0 && age < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

async function writeCache(dir: string, bytes: Uint8Array, signature: string, now: Date): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(path.join(dir, "snapshot.json"), bytes);
    await writeAtomic(path.join(dir, "snapshot.json.sig"), signature);
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify({ fetched_at: now.toISOString() }));
  } catch {
    // A read-only cache must not stop a scan.
  }
}

async function fetchVerified(url: string, doFetch: typeof fetch, publicKeyPem: string | undefined): Promise<{ snapshot: RegistrySnapshot; bytes: Uint8Array; signature: string } | null> {
  try {
    requireHttps(url);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const [dataRes, sigRes] = await Promise.all([doFetch(url, { signal }), doFetch(`${url}.sig`, { signal })]);
    if (!dataRes.ok || !sigRes.ok) return null;
    const [bytes, sigBytes] = await Promise.all([readLimited(dataRes, MAX_RESPONSE_BYTES), readLimited(sigRes, MAX_SIGNATURE_BYTES)]);
    const signature = Buffer.from(sigBytes).toString("utf8");
    const snapshot = openSigned(bytes, signature, publicKeyPem);
    return snapshot ? { snapshot, bytes, signature } : null;
  } catch {
    return null;
  }
}

/** Dynamic so a missing data file fails here, not at startup; the literal path lets esbuild inline it. */
async function importBundled(): Promise<unknown> {
  const mod = await import("../../data/registry.snapshot.json", { with: { type: "json" } });
  return mod.default;
}

async function loadBundledSnapshot(load: () => Promise<unknown>): Promise<RegistrySnapshot | null> {
  try {
    return validateSnapshot(await load());
  } catch {
    return null;
  }
}

function ageDays(snapshot: RegistrySnapshot, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.generated_at)) / DAY_MS));
}

export async function loadRegistry(opts: LoadRegistryOptions = {}): Promise<LoadedRegistry> {
  const url = opts.url ?? DEFAULT_REGISTRY_URL;
  const now = opts.now ?? new Date();
  // Keyed by URL so a --registry-url run cannot be answered from another registry's cache.
  const dir = path.join(opts.cacheDir ?? defaultCacheDir(), sha256(url).slice(0, 16));
  const loaded = (snapshot: RegistrySnapshot, source: LoadedRegistry["source"]): LoadedRegistry => ({ snapshot, source, age_days: ageDays(snapshot, now) });

  const cached = await readCache(dir, now, opts.publicKeyPem);
  if (cached?.fresh && !opts.offline) return loaded(cached.snapshot, "cache");
  const remote = opts.offline ? null : await fetchVerified(url, opts.fetchImpl ?? fetch, opts.publicKeyPem);
  const bundled = await loadBundledSnapshot(opts.loadBundled ?? importBundled);
  const newestLocal = Math.max(cached ? generatedAt(cached.snapshot) : -Infinity, bundled ? generatedAt(bundled) : -Infinity);
  // A correctly signed old snapshot is still old: replaying one must not hide newer retirements.
  if (remote && generatedAt(remote.snapshot) >= newestLocal) {
    await writeCache(dir, remote.bytes, remote.signature, now);
    return loaded(remote.snapshot, "remote");
  }
  if (cached && generatedAt(cached.snapshot) === newestLocal) return loaded(cached.snapshot, "cache");
  if (bundled) return loaded(bundled, "bundled");
  throw new SwapcheckError("The registry snapshot bundled with Swapcheck is missing or invalid, and no verified remote or cached copy was available. Reinstall Swapcheck, or connect to the network and try again.", EXIT.UNMEASURED);
}
