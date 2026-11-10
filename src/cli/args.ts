import { SwapcheckError } from "../util/errors.ts";

export type Format = "text" | "json" | "markdown" | "sarif";
export const FORMATS: readonly Format[] = ["text", "json", "markdown", "sarif"];

type FlagKind = "boolean" | "string";
type FlagSpecs = Record<string, FlagKind>;

const GLOBAL_FLAGS: FlagSpecs = {
  format: "string",
  config: "string",
  cwd: "string",
  "registry-url": "string",
  offline: "boolean",
  yes: "boolean",
  debug: "boolean",
  "no-color": "boolean",
  help: "boolean",
  version: "boolean",
};

const PAID_FLAGS: FlagSpecs = { runs: "string", "max-usd": "string", judge: "string", route: "string", "allow-unknown-prices": "boolean" };

export const COMMAND_FLAGS: Record<string, FlagSpecs> = {
  scan: { "no-lock": "boolean" },
  watch: { "fail-within-days": "string" },
  find: { test: "boolean", limit: "string", ...PAID_FLAGS },
  cases: { "allow-unredacted": "boolean", all: "boolean" },
  baseline: { model: "string", ...PAID_FLAGS },
  test: { to: "string", from: "string", ...PAID_FLAGS },
  bump: { to: "string", "open-pr": "boolean", evidence: "string", "dry-run": "boolean" },
  report: {},
  mcp: {},
  help: {},
};

export const COMMANDS = Object.keys(COMMAND_FLAGS).filter((name) => name !== "help");

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  format: Format;
}

function isFlag(token: string): boolean {
  return token.length > 1 && token.startsWith("-");
}

function flagName(token: string): string {
  if (token === "-h") return "help";
  if (token === "-V") return "version";
  const body = token.replace(/^--?/, "");
  const eq = body.indexOf("=");
  return eq === -1 ? body : body.slice(0, eq);
}

/** Finds the command word, stepping over any global flag that takes a value. */
function findCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") return undefined;
    if (!isFlag(token)) return token;
    if (!token.includes("=") && GLOBAL_FLAGS[flagName(token)] === "string") i++;
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min((row[j] as number) + 1, (next[j - 1] as number) + 1, (row[j - 1] as number) + cost);
    }
    row = next;
  }
  return row[b.length] as number;
}

function suggest(word: string, options: string[]): string {
  const best = options
    .map((option) => ({ option, distance: editDistance(word, option) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return best && best.distance <= 2 ? ` Did you mean ${best.option}?` : "";
}

export function parseArgs(argv: string[]): ParsedArgs {
  const found = findCommand(argv);
  if (found !== undefined && !(found in COMMAND_FLAGS)) {
    throw new SwapcheckError(`${found} is not a Swapcheck command.${suggest(found, COMMANDS)} Run swapcheck --help to see them all.`);
  }
  const command = found ?? "scan";
  const specs: FlagSpecs = { ...GLOBAL_FLAGS, ...COMMAND_FLAGS[command] };
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];
  let commandSeen = found === undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      if (!commandSeen && token === found) commandSeen = true;
      else positionals.push(token);
      continue;
    }
    const name = flagName(token);
    const kind = specs[name];
    if (!kind) {
      const hint = suggest(name, Object.keys(specs));
      throw new SwapcheckError(`--${name} is not an option for ${command}.${hint} Run swapcheck ${command} --help to see the options.`);
    }
    const eq = token.indexOf("=");
    if (kind === "boolean") {
      if (eq !== -1) throw new SwapcheckError(`--${name} does not take a value. Use it on its own.`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") throw new SwapcheckError(`--${name} needs a value. Run swapcheck ${command} --help for an example.`);
    flags[name] = value;
  }

  const rawFormat = flags.format ?? "text";
  if (typeof rawFormat !== "string" || !FORMATS.includes(rawFormat as Format)) {
    throw new SwapcheckError(`--format must be one of ${FORMATS.join(", ")}.`);
  }
  return { command, positionals, flags, format: rawFormat as Format };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function intFlag(args: ParsedArgs, name: string, limits: { min: number; max: number }): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  return parseBoundedInt(`--${name}`, raw, limits);
}

export function parseBoundedInt(label: string, raw: string, limits: { min: number; max: number }): number {
  if (!/^\d{1,9}$/.test(raw.trim())) throw new SwapcheckError(`${label} must be a whole number, but got ${raw}.`);
  const value = Number(raw.trim());
  if (value < limits.min || value > limits.max) {
    throw new SwapcheckError(`${label} must be between ${limits.min} and ${limits.max}, but got ${value}.`);
  }
  return value;
}

export function parseUsd(label: string, raw: string): number {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(raw.trim())) throw new SwapcheckError(`${label} must be a dollar amount such as 5 or 2.50, but got ${raw}.`);
  const value = Number(raw.trim());
  if (!(value > 0)) throw new SwapcheckError(`${label} must be more than zero.`);
  return value;
}

export function splitList(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
