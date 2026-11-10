import { lstat } from "node:fs/promises";
import type { ExposureItem, LockEntry, LockFile, ModelCapabilities, RegistryEvent, RegistrySnapshot } from "./types.ts";
import { SwapcheckError } from "./util/errors.ts";
import { insideRoot, writeInsideRoot } from "./util/paths.ts";
import { redactSecrets } from "./util/redact.ts";
import { readTextFile } from "./scan/scan.ts";

const LOCK_NAME = "models.lock";
const MAX_LOCK_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

const STATUSES = new Set(["ok", "unknown", "retiring", "retired", "reroute_scheduled", "rerouted", "repricing", "parameter_change"]);
const CAPABILITY_KEYS: Array<keyof ModelCapabilities> = ["tools", "structured_output", "reasoning", "vision", "audio", "pdf"];

function invalid(detail: string): SwapcheckError {
  return new SwapcheckError(`The file ${LOCK_NAME} is not valid: ${detail}. Fix it, or delete it and run swapcheck scan to create a new one.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown, position: number): LockEntry {
  const where = `models[${position}]`;
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  if (typeof value.id !== "string" || !value.id) throw invalid(`${where}.id must be a non-empty string`);
  if (typeof value.route !== "string" || !value.route) throw invalid(`${where}.route must be a non-empty string`);
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) throw invalid(`${where}.status is not a known status`);
  if (value.verified_at !== null && typeof value.verified_at !== "string") throw invalid(`${where}.verified_at must be a string or null`);
  if (value.baseline !== null && typeof value.baseline !== "string") throw invalid(`${where}.baseline must be a string or null`);
  for (const field of ["reroute_to", "effective", "registry_event"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw invalid(`${where}.${field} must be a string`);
  }
  if (value.cost !== undefined && !(isRecord(value.cost) && typeof value.cost.input === "number" && typeof value.cost.output === "number")) {
    throw invalid(`${where}.cost must have numeric input and output`);
  }
  const { capabilities } = value;
  if (capabilities !== undefined && !(isRecord(capabilities) && CAPABILITY_KEYS.every((key) => typeof capabilities[key] === "boolean"))) {
    throw invalid(`${where}.capabilities must list every capability as true or false`);
  }
  return value as unknown as LockEntry;
}

function validateLock(value: unknown): LockFile {
  if (!isRecord(value)) throw invalid("the top level must be an object");
  if (value.version !== 1) throw invalid("version must be 1");
  if (!Array.isArray(value.models)) throw invalid("models must be a list");
  if (value.models.length > MAX_ENTRIES) throw invalid(`it lists more than ${MAX_ENTRIES} models`);
  return { version: 1, models: value.models.map(validateEntry) };
}

export async function readLock(root: string): Promise<LockFile | null> {
  const target = insideRoot(root, LOCK_NAME);
  try {
    await lstat(target);
  } catch {
    return null;
  }
  const text = await readTextFile(target, MAX_LOCK_BYTES);
  if (text === null) throw new SwapcheckError(`The file ${LOCK_NAME} could not be read. It may be too large or a symbolic link. Replace it with a regular file.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("it is not JSON");
  }
  return validateLock(parsed);
}

function compareEntries(a: LockEntry, b: LockEntry): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
}

/** Fixed key order keeps the file stable, so diffs show only real changes. */
function orderedEntry(entry: LockEntry): LockEntry {
  const out: LockEntry = { id: entry.id, route: entry.route, status: entry.status, verified_at: entry.verified_at, baseline: entry.baseline };
  if (entry.reroute_to !== undefined) out.reroute_to = entry.reroute_to;
  if (entry.effective !== undefined) out.effective = entry.effective;
  if (entry.registry_event !== undefined) out.registry_event = entry.registry_event;
  if (entry.cost !== undefined) out.cost = { input: entry.cost.input, output: entry.cost.output };
  if (entry.capabilities !== undefined) out.capabilities = entry.capabilities;
  return out;
}

export async function writeLock(root: string, lock: LockFile): Promise<void> {
  const target = insideRoot(root, LOCK_NAME);
  const models = [...lock.models].sort(compareEntries).map(orderedEntry);
  try {
    await writeInsideRoot(root, target, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, { mode: 0o644 });
  } catch (error) {
    if (error instanceof SwapcheckError) throw error;
    throw new SwapcheckError(`Could not write ${LOCK_NAME}: ${redactSecrets((error as Error).message)}. Check that the project folder is writable.`);
  }
}

const EVENT_TYPES_BY_STATUS: Partial<Record<ExposureItem["status"], RegistryEvent["type"][]>> = {
  retiring: ["retirement"],
  retired: ["retirement"],
  reroute_scheduled: ["reroute", "alias_move"],
  rerouted: ["reroute", "alias_move"],
  repricing: ["price_change"],
  parameter_change: ["parameter_change"],
};

/** Items list events most urgent first, so the first of the right type explains the status. */
function primaryEvent(item: ExposureItem): RegistryEvent | undefined {
  const types = EVENT_TYPES_BY_STATUS[item.status];
  return types ? item.events.find((event) => types.includes(event.type)) : undefined;
}

export function lockFromExposure(items: ExposureItem[], snapshot: RegistrySnapshot, previous?: LockFile | null): LockFile {
  const models = items.map((item): LockEntry => {
    const prior = previous?.models.find((entry) => entry.id === item.model && entry.route === item.route);
    const row = snapshot.models.find((model) => model.id === item.model && model.route === item.route);
    const event = primaryEvent(item);
    const entry: LockEntry = {
      id: item.model,
      route: item.route,
      status: item.status,
      verified_at: prior?.verified_at ?? null,
      baseline: prior?.baseline ?? null,
    };
    if (event) {
      entry.registry_event = event.id;
      if (event.effective !== undefined) entry.effective = event.effective;
      if ((event.type === "reroute" || event.type === "alias_move") && event.to !== undefined) entry.reroute_to = event.to;
    }
    if (row) {
      entry.cost = { input: row.cost.input, output: row.cost.output };
      entry.capabilities = row.capabilities;
    }
    return entry;
  });
  return { version: 1, models: models.sort(compareEntries) };
}
