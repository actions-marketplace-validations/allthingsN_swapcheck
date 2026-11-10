import { parseUsd } from "../cli/args.ts";
import { describePlan, planComparison, runPlan, type ComparisonPlan } from "../cli/compare.ts";
import { openProject, type Project } from "../cli/project.ts";
import { findReplacements } from "../find.ts";
import { readLock } from "../lock.ts";
import type { LoadedRegistry } from "../registry/client.ts";
import { inferRequirements } from "../scan/requirements.ts";
import { scanProject } from "../scan/scan.ts";
import type { RegistryEvent } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { computeExposure, watchLock } from "../watch.ts";

export interface ToolDefinitionMcp {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  paid?: boolean;
}

export interface ToolContext {
  cwd?: string;
  registryUrl?: string;
  offline: boolean;
  env: NodeJS.ProcessEnv;
  /** Test seam: use this registry instead of loading one. */
  registry?: LoadedRegistry;
}

const MAX_ID = 256;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const FREE_TOOLS: ToolDefinitionMcp[] = [
  {
    name: "scan",
    title: "Scan for models",
    description: "Find LLM model IDs in this project and report which are retiring, rerouting, or repricing, with dates and source links. Free. Does not write models.lock.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "watch",
    title: "Compare models.lock to the registry",
    description: "Compare models.lock with the registry and list changes that fall inside a window. Free.",
    inputSchema: { type: "object", properties: { fail_within_days: { type: "integer", minimum: 0, maximum: 3650 } }, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "find",
    title: "Shortlist replacements",
    description: "Shortlist replacements for a model that meet what this project's code needs. Uses registry data only. Free.",
    inputSchema: { type: "object", properties: { model: { type: "string", minLength: 1, maxLength: MAX_ID }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["model"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "explain_event",
    title: "Explain a registry event",
    description: "Explain a registry event by id, or list the events for a model, in plain words with the source link. Free.",
    inputSchema: { type: "object", properties: { id: { type: "string", maxLength: MAX_ID }, model: { type: "string", maxLength: MAX_ID } }, additionalProperties: false },
    annotations: READ_ONLY,
  },
];

const PAID_TOOLS: ToolDefinitionMcp[] = [
  {
    name: "test",
    title: "Test candidates on saved cases",
    description: "Compare candidate models with the current one on this project's accepted cases. Sends case content to the listed vendors and spends money. Without confirm: true it only returns the maximum cost and vendors. The budget is the lowest of max_usd, the project's budget.max_usd_per_run and SWAPCHECK_MCP_MAX_USD, so max_usd can only lower it.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", minLength: 1, maxLength: MAX_ID },
        to: { type: "array", items: { type: "string", minLength: 1, maxLength: MAX_ID }, minItems: 1, maxItems: 10 },
        runs: { type: "integer", minimum: 1, maximum: 200 },
        max_usd: { type: "number", exclusiveMinimum: 0 },
        confirm: { type: "boolean" },
      },
      required: ["from", "to", "max_usd"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    paid: true,
  },
];

export function spendAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.SWAPCHECK_MCP_ALLOW_SPEND === "1";
}

export function listTools(env: NodeJS.ProcessEnv): ToolDefinitionMcp[] {
  return spendAllowed(env) ? [...FREE_TOOLS, ...PAID_TOOLS] : FREE_TOOLS;
}

export class InvalidParams extends Error {}

type Args = Record<string, unknown>;

function stringArg(args: Args, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new InvalidParams(`${name} must be a non-empty string of at most ${MAX_ID} characters.`);
  return value;
}

function intArg(args: Args, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new InvalidParams(`${name} must be a whole number between ${min} and ${max}.`);
  return value;
}

async function project(context: ToolContext, deadline?: number): Promise<Project> {
  return openProject({
    offline: context.offline,
    env: context.env,
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.registryUrl ? { registryUrl: context.registryUrl } : {}),
    ...(deadline ? { registryDeadlineMs: deadline } : {}),
    ...(context.registry ? { registry: context.registry } : {}),
  });
}

function registryInfo(p: Project): Record<string, unknown> {
  return { generated_at: p.registry.snapshot.generated_at, age_days: p.registry.age_days, source: p.registry.source };
}

async function toolScan(context: ToolContext): Promise<unknown> {
  const p = await project(context, 2000);
  const scan = await scanProject(p.root, p.registry.snapshot, { exclude: p.config.exclude });
  return { registry: registryInfo(p), files_scanned: scan.files_scanned, items: computeExposure(scan, p.registry.snapshot), unresolved: scan.unresolved };
}

async function toolWatch(context: ToolContext, args: Args): Promise<unknown> {
  const p = await project(context, 2000);
  const lock = await readLock(p.root);
  if (!lock) throw new SwapcheckError("There is no models.lock here yet. Run swapcheck once to create it.");
  return watchLock(lock, p.registry, { failWithinDays: intArg(args, "fail_within_days", 0, 3650) ?? p.config.watch.fail_within_days });
}

async function toolFind(context: ToolContext, args: Args): Promise<unknown> {
  const model = stringArg(args, "model", true) as string;
  const limit = intArg(args, "limit", 1, 50) ?? 5;
  const p = await project(context, 2000);
  const scan = await scanProject(p.root, p.registry.snapshot, { exclude: p.config.exclude });
  return findReplacements(model, await inferRequirements(p.root, model, scan), p.registry.snapshot, p.config.policy, { limit });
}

function explainOne(event: RegistryEvent): string {
  const when = event.effective ? `${event.date_precision === "earliest_possible" ? "no earlier than" : "on"} ${event.effective}` : "with no announced date";
  const to = event.to ? ` to ${event.to}` : "";
  const notes = event.notes ? ` Notes: ${event.notes}` : "";
  return `${event.provider} ${event.type.replace(/_/g, " ")} for ${event.model}${to}, ${when}, on route ${event.route}. Confidence: ${event.confidence}. Last verified ${event.last_verified}. Source: ${event.source}.${notes}`;
}

async function toolExplain(context: ToolContext, args: Args): Promise<unknown> {
  const id = stringArg(args, "id", false);
  const model = stringArg(args, "model", false);
  if (!id && !model) throw new InvalidParams("Provide id or model.");
  const p = await project(context, 2000);
  const events = p.registry.snapshot.events.filter((event) => (id ? event.id === id : event.model === model));
  if (events.length === 0) throw new SwapcheckError(`The registry has no event matching ${id ?? model}.`);
  return { events: events.slice(0, 20).map((event) => ({ event, explanation: explainOne(event) })) };
}

function planSummary(plan: ComparisonPlan): Record<string, unknown> {
  return { budget_usd: plan.budgetUsd, max_usd: plan.maxUsd, max_calls: plan.maxCalls, vendors: plan.vendors, cases: plan.cases.length, runs: plan.runs, summary: describePlan(plan) };
}

/** An agent's request can only lower what the repo and the operator allow, never raise it. */
function effectiveBudget(requested: number, configMax: number, env: NodeJS.ProcessEnv): number {
  const operator = env.SWAPCHECK_MCP_MAX_USD;
  return Math.min(requested, configMax, ...(operator ? [parseUsd("SWAPCHECK_MCP_MAX_USD", operator)] : []));
}

async function toolTest(context: ToolContext, args: Args): Promise<unknown> {
  if (!spendAllowed(context.env)) throw new InvalidParams("Unknown tool: test");
  const from = stringArg(args, "from", true) as string;
  const to = args.to;
  if (!Array.isArray(to) || to.length === 0 || to.length > 10 || !to.every((m) => typeof m === "string" && m.length > 0 && m.length <= MAX_ID)) throw new InvalidParams("to must be a list of up to 10 model IDs.");
  const maxUsd = args.max_usd;
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0) throw new InvalidParams("max_usd must be a positive number.");
  const runs = intArg(args, "runs", 1, 200);
  const p = await project(context);
  const plan = await planComparison(p, { baseline: from, candidates: to as string[], maxUsd: effectiveBudget(maxUsd, p.config.budget.max_usd_per_run, context.env), env: context.env, ...(runs ? { runs } : {}) });
  if (args.confirm !== true) return { spent: false, ...planSummary(plan), next: "Call again with confirm: true to spend." };
  const { report, reportPath } = await runPlan(p, plan);
  return { spent: true, report_path: reportPath, report };
}

export async function callTool(name: string, args: Args, context: ToolContext): Promise<unknown> {
  switch (name) {
    case "scan":
      return toolScan(context);
    case "watch":
      return toolWatch(context, args);
    case "find":
      return toolFind(context, args);
    case "explain_event":
      return toolExplain(context, args);
    case "test":
      return toolTest(context, args);
    default:
      throw new InvalidParams(`Unknown tool: ${name}`);
  }
}
