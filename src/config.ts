import { lstat } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { PolicyConfig, SwapcheckConfig } from "./types.ts";
import { SwapcheckError } from "./util/errors.ts";
import { insideRoot, realInsideRoot } from "./util/paths.ts";
import { redactSecrets } from "./util/redact.ts";
import { readTextFile } from "./scan/scan.ts";

export const DEFAULT_CONFIG: SwapcheckConfig = {
  models: [],
  cases: "swapcheck/cases",
  runs: 5,
  budget: { max_usd_per_run: 5 },
  policy: {},
  watch: { fail_within_days: 30 },
  include_text_in_reports: false,
  exclude: [],
};

const DEFAULT_NAMES = ["swapcheck.yaml", "swapcheck.yml"];
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_FLOW_DEPTH = 64;
const MAX_DEPTH = 32;
const MAX_ALIASES = 50;
const MAX_LIST = 1000;
const MAX_TEXT = 512;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(file: string, detail: string): SwapcheckError {
  return new SwapcheckError(redactSecrets(`${file}: ${detail}`));
}

function checkKeys(file: string, where: string, value: Mapping, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const prefix = where ? `${where}.` : "";
      throw bad(file, `the setting "${prefix}${key.slice(0, 64)}" is not recognised. Allowed settings are: ${allowed.join(", ")}.`);
    }
  }
}

function asText(file: string, where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) {
    throw bad(file, `${where} must be text between 1 and ${MAX_TEXT} characters long.`);
  }
  return value;
}

function asTextList(file: string, where: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw bad(file, `${where} must be a list of text values.`);
  if (value.length > MAX_LIST) throw bad(file, `${where} has more than ${MAX_LIST} entries. Shorten the list.`);
  return value.map((item, i) => asText(file, `${where}[${i}]`, item));
}

function asNumber(file: string, where: string, value: unknown, min: number, max: number, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw bad(file, `${where} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

function asInsideRoot(root: string, file: string, where: string, value: string): string {
  try {
    insideRoot(root, value);
  } catch {
    throw bad(file, `${where} (${value}) must stay inside the project folder.`);
  }
  return value;
}

function parseModels(root: string, file: string, value: unknown): SwapcheckConfig["models"] {
  if (!Array.isArray(value)) throw bad(file, "models must be a list of entries with an id.");
  if (value.length > MAX_LIST) throw bad(file, `models has more than ${MAX_LIST} entries. Shorten the list.`);
  return value.map((item, i) => {
    const where = `models[${i}]`;
    if (!isMapping(item)) throw bad(file, `${where} must be a mapping with an id.`);
    checkKeys(file, where, item, ["id", "route", "paths"]);
    const entry: SwapcheckConfig["models"][number] = { id: asText(file, `${where}.id`, item.id) };
    if (item.route !== undefined) entry.route = asText(file, `${where}.route`, item.route);
    if (item.paths !== undefined) {
      entry.paths = asTextList(file, `${where}.paths`, item.paths).map((p, n) => asInsideRoot(root, file, `${where}.paths[${n}]`, p));
    }
    return entry;
  });
}

function parsePolicy(file: string, value: unknown): PolicyConfig {
  if (!isMapping(value)) throw bad(file, "policy must be a mapping.");
  checkKeys(file, "policy", value, ["providers", "regions", "licenses", "max_usd_per_million_output"]);
  const policy: PolicyConfig = {};
  if (value.providers !== undefined) policy.providers = asTextList(file, "policy.providers", value.providers);
  if (value.regions !== undefined) policy.regions = asTextList(file, "policy.regions", value.regions);
  if (value.licenses !== undefined) policy.licenses = asTextList(file, "policy.licenses", value.licenses);
  if (value.max_usd_per_million_output !== undefined) {
    policy.max_usd_per_million_output = asNumber(file, "policy.max_usd_per_million_output", value.max_usd_per_million_output, 0, 1_000_000, false);
  }
  return policy;
}

function validate(root: string, file: string, raw: Mapping): SwapcheckConfig {
  checkKeys(file, "", raw, ["models", "cases", "runs", "budget", "policy", "watch", "include_text_in_reports", "exclude"]);
  const config = defaults();
  if (raw.models !== undefined) config.models = parseModels(root, file, raw.models);
  if (raw.cases !== undefined) config.cases = asInsideRoot(root, file, "cases", asText(file, "cases", raw.cases));
  if (raw.runs !== undefined) config.runs = asNumber(file, "runs", raw.runs, 1, 1000, true);
  if (raw.budget !== undefined) {
    if (!isMapping(raw.budget)) throw bad(file, "budget must be a mapping with max_usd_per_run.");
    checkKeys(file, "budget", raw.budget, ["max_usd_per_run"]);
    if (raw.budget.max_usd_per_run !== undefined) {
      config.budget.max_usd_per_run = asNumber(file, "budget.max_usd_per_run", raw.budget.max_usd_per_run, 0, 1_000_000, false);
    }
  }
  if (raw.policy !== undefined) config.policy = parsePolicy(file, raw.policy);
  if (raw.watch !== undefined) {
    if (!isMapping(raw.watch)) throw bad(file, "watch must be a mapping with fail_within_days.");
    checkKeys(file, "watch", raw.watch, ["fail_within_days"]);
    if (raw.watch.fail_within_days !== undefined) {
      config.watch.fail_within_days = asNumber(file, "watch.fail_within_days", raw.watch.fail_within_days, 0, 36_500, true);
    }
  }
  if (raw.include_text_in_reports !== undefined) {
    if (typeof raw.include_text_in_reports !== "boolean") throw bad(file, "include_text_in_reports must be true or false.");
    config.include_text_in_reports = raw.include_text_in_reports;
  }
  if (raw.exclude !== undefined) config.exclude = asTextList(file, "exclude", raw.exclude);
  return config;
}

function defaults(): SwapcheckConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** Flow brackets are counted first because the parser recurses on them. */
function exceedsFlowDepth(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "{") {
      depth++;
      if (depth > MAX_FLOW_DEPTH) return true;
    } else if ((ch === "]" || ch === "}") && depth > 0) {
      depth--;
    }
  }
  return false;
}

function exceedsDepth(value: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (typeof node !== "object" || node === null) continue;
    if (depth > MAX_DEPTH) return true;
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

function parseYaml(file: string, text: string): unknown {
  if (exceedsFlowDepth(text)) throw bad(file, `it nests more than ${MAX_FLOW_DEPTH} levels of brackets. Simplify the file.`);
  let value: unknown;
  try {
    const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
    const first = doc.errors[0];
    if (first) throw bad(file, `it is not valid YAML: ${first.message}. Fix the syntax and try again.`);
    value = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    if (error instanceof SwapcheckError) throw error;
    throw bad(file, "it could not be parsed, usually because it is nested too deeply or expands too many aliases. Simplify the file.");
  }
  if (exceedsDepth(value)) throw bad(file, `it nests more than ${MAX_DEPTH} levels deep. Simplify the file.`);
  return value;
}

async function readConfigText(root: string, target: string, label: string): Promise<string> {
  if (!(await realInsideRoot(root, target))) throw bad(label, "it is a symbolic link that leaves the project folder. Replace it with a regular file.");
  const text = await readTextFile(target, MAX_CONFIG_BYTES);
  if (text === null) throw bad(label, `it could not be read. Check that it is a regular text file under ${MAX_CONFIG_BYTES / 1024} KB.`);
  return text;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function locate(root: string, configPath: string | undefined): Promise<{ target: string; label: string } | null> {
  if (configPath !== undefined) {
    const target = insideRoot(root, configPath);
    if (!(await exists(target))) throw new SwapcheckError(`The config file ${configPath} does not exist. Check the --config path.`);
    return { target, label: configPath };
  }
  for (const name of DEFAULT_NAMES) {
    const target = insideRoot(root, name);
    if (await exists(target)) return { target, label: name };
  }
  return null;
}

/** Returns the defaults when no config file exists. Throws a plain-sentence error on any invalid field. */
export async function loadConfig(root: string, configPath?: string): Promise<SwapcheckConfig> {
  const found = await locate(root, configPath);
  if (!found) return defaults();
  const value = parseYaml(found.label, await readConfigText(root, found.target, found.label));
  if (value === null || value === undefined) return defaults();
  if (!isMapping(value)) throw bad(found.label, "the top level must be a mapping of settings.");
  return validate(root, found.label, value);
}
