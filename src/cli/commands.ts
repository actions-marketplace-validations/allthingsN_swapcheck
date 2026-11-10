import { readFile, stat } from "node:fs/promises";
import { applyBump, createGitHub, findEvidence, planBump, publishBump, resolveRepo, type BumpPlan, type PublishedPr } from "../bump/index.ts";
import { acceptCases } from "../cases/accept.ts";
import { importCases, type ImportKind } from "../cases/import/index.ts";
import { initCases } from "../cases/init.ts";
import { loadCases } from "../cases/load.ts";
import { findReplacements } from "../find.ts";
import { lockFromExposure, readLock, writeLock } from "../lock.ts";
import { exitCodeFor, renderMarkdown, renderSarifExposure, renderSarifReport } from "../report/index.ts";
import { inferRequirements } from "../scan/requirements.ts";
import { scanProject } from "../scan/scan.ts";
import { estimateMaxCost } from "../testing/budget.ts";
import { EXIT, type FindResult, type ScanResult, type SwapReport } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { computeExposure, watchLock } from "../watch.ts";
import { boolFlag, intFlag, parseUsd, splitList, stringFlag, type Format, type ParsedArgs } from "./args.ts";
import { describePlan, planComparison, runPlan, type ComparisonPlan } from "./compare.ts";
import { helpFor } from "./help.ts";
import { clean, emit, emitJson, note, plural, type Styler } from "./output.ts";
import { openProject, resolveInsideProject, resolveRoot, type OpenOptions, type Project } from "./project.ts";
import { renderExposureMarkdown, renderFindMarkdown, renderFindText, renderReportText, renderScanText, renderWatchText } from "./render.ts";
import { confirmSpend } from "./spend.ts";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const FREE_COMMAND_REGISTRY_DEADLINE_MS = 700;
const IMPORT_KINDS: readonly ImportKind[] = ["modelbump", "modelpin", "otel", "litellm", "langfuse"];

export interface Env {
  args: ParsedArgs;
  style: Styler;
  isTty: boolean;
  env: NodeJS.ProcessEnv;
}

function openOptions(args: ParsedArgs, env: NodeJS.ProcessEnv, registryDeadlineMs?: number): OpenOptions {
  const options: OpenOptions = { offline: boolFlag(args, "offline"), env };
  const cwd = stringFlag(args, "cwd");
  const configPath = stringFlag(args, "config");
  const registryUrl = stringFlag(args, "registry-url");
  if (cwd) options.cwd = cwd;
  if (configPath) options.configPath = configPath;
  if (registryUrl) options.registryUrl = registryUrl;
  if (registryDeadlineMs) options.registryDeadlineMs = registryDeadlineMs;
  return options;
}

function refuseFormat(format: Format, command: string, supported: readonly Format[]): void {
  if (!supported.includes(format)) throw new SwapcheckError(`--format ${format} is not available for ${command}. Use one of: ${supported.join(", ")}.`);
}

function registryInfo(project: Project): { generated_at: string; age_days: number; source: string } {
  return { generated_at: project.registry.snapshot.generated_at, age_days: project.registry.age_days, source: project.registry.source };
}

export async function runScan({ args, style, env }: Env): Promise<number> {
  const project = await openProject(openOptions(args, env, FREE_COMMAND_REGISTRY_DEADLINE_MS));
  const scan = await scanProject(project.root, project.registry.snapshot, { exclude: project.config.exclude });
  const items = computeExposure(scan, project.registry.snapshot);
  const lockWritten = !boolFlag(args, "no-lock");
  if (lockWritten) await writeLock(project.root, lockFromExposure(items, project.registry.snapshot, await readLock(project.root)));

  if (args.format === "json") {
    emitJson({ schema: "swapcheck.scan/v1", root: scan.root, registry: registryInfo(project), files_scanned: scan.files_scanned, items, findings: scan.findings, unresolved: scan.unresolved, lock_written: lockWritten });
  } else if (args.format === "sarif") {
    emitJson(renderSarifExposure(items));
  } else if (args.format === "markdown") {
    emit(renderExposureMarkdown("Models in this repo", items, project.registry.snapshot.generated_at));
  } else {
    emit(renderScanText(scan, items, project.registry, lockWritten, style));
  }
  return EXIT.OK;
}

export async function runWatch({ args, style, env }: Env): Promise<number> {
  const project = await openProject(openOptions(args, env, FREE_COMMAND_REGISTRY_DEADLINE_MS));
  const lock = await readLock(project.root);
  if (!lock) throw new SwapcheckError("There is no models.lock here yet. Run swapcheck once to create it.");
  const failWithinDays = intFlag(args, "fail-within-days", { min: 0, max: 3650 }) ?? project.config.watch.fail_within_days;
  const result = watchLock(lock, project.registry, { failWithinDays });

  if (args.format === "json") emitJson({ schema: "swapcheck.watch/v1", fail_within_days: failWithinDays, ...result });
  else if (args.format === "sarif") emitJson(renderSarifExposure(result.items));
  else if (args.format === "markdown") emit(renderExposureMarkdown("Model changes", result.items, result.registry_generated_at));
  else emit(renderWatchText(result, failWithinDays, style));
  return result.due.length > 0 ? EXIT.FAIL : EXIT.OK;
}

/** Picks the model under test, refusing to guess when the repo uses more than one. */
async function currentModel(project: Project, explicit: string | undefined, flag: string): Promise<string> {
  if (explicit) return explicit;
  const configured = project.config.models;
  if (configured.length === 1 && configured[0]) return configured[0].id;
  const lock = await readLock(project.root);
  const ids = configured.length > 0 ? configured.map((m) => m.id) : (lock?.models.map((m) => m.id) ?? []);
  if (ids.length === 1 && ids[0]) return ids[0];
  if (ids.length === 0) throw new SwapcheckError(`Swapcheck does not know the current model yet. Pass ${flag} <model>, or run swapcheck first to create models.lock.`);
  throw new SwapcheckError(`More than one model is in use (${ids.map((id) => clean(id, 80)).join(", ")}). Pick one with ${flag} <model>.`);
}

async function spendAndRun(context: Env, project: Project, plan: ComparisonPlan): Promise<{ report: SwapReport; reportPath: string }> {
  for (const line of describePlan(plan)) note(line);
  await confirmSpend(plan.maxUsd, { yes: boolFlag(context.args, "yes"), isTty: context.isTty });
  return runPlan(project, plan, (message) => note(context.style.dim(clean(message, 300))));
}

function paidOptions(args: ParsedArgs): { runs?: number; maxUsd?: number; judge?: string; route?: string; allowUnknownPrices: boolean } {
  const out: ReturnType<typeof paidOptions> = { allowUnknownPrices: boolFlag(args, "allow-unknown-prices") };
  const runs = intFlag(args, "runs", { min: 1, max: 200 });
  const maxUsd = stringFlag(args, "max-usd");
  const judge = stringFlag(args, "judge");
  const route = stringFlag(args, "route");
  if (runs !== undefined) out.runs = runs;
  if (maxUsd !== undefined) out.maxUsd = parseUsd("--max-usd", maxUsd);
  if (judge) out.judge = judge;
  if (route) out.route = route;
  return out;
}

function renderReportOutput(context: Env, report: SwapReport, reportPath: string | undefined): void {
  const { format } = context.args;
  if (format === "json") emitJson(reportPath ? { ...report, report_path: reportPath } : report);
  else if (format === "markdown") emit(renderMarkdown(report));
  else if (format === "sarif") emitJson(renderSarifReport(report));
  else emit(renderReportText(report, reportPath, context.style));
}

export async function runTest(context: Env): Promise<number> {
  const { args, env } = context;
  const to = stringFlag(args, "to");
  if (!to) throw new SwapcheckError("test needs candidates. For example: swapcheck test --to model-a,model-b");
  const candidates = splitList(to);
  if (candidates.length === 0) throw new SwapcheckError("--to did not name any model.");
  const project = await openProject(openOptions(args, env));
  const baseline = await currentModel(project, stringFlag(args, "from"), "--from");
  const plan = await planComparison(project, { baseline, candidates, ...paidOptions(args), env });
  const { report, reportPath } = await spendAndRun(context, project, plan);
  renderReportOutput(context, report, reportPath);
  return exitCodeFor(report);
}

export async function runBaseline(context: Env): Promise<number> {
  const { args, env } = context;
  const project = await openProject(openOptions(args, env));
  const baseline = await currentModel(project, stringFlag(args, "model"), "--model");
  const plan = await planComparison(project, { baseline, candidates: [], ...paidOptions(args), env });
  const { report, reportPath } = await spendAndRun(context, project, plan);
  renderReportOutput(context, report, reportPath);
  return exitCodeFor(report);
}

async function maxCostToTest(project: Project, result: FindResult, runs: number): Promise<number | undefined> {
  const accepted = (await loadCases(project.root, project.config.cases).catch(() => [])).filter((c) => c.accepted);
  if (accepted.length === 0 || result.shortlist.length === 0) return undefined;
  const estimate = estimateMaxCost({ cases: accepted, models: [result.model, ...result.shortlist.map((e) => e.model)], runs, snapshot: project.registry.snapshot, includeNoise: true });
  return estimate.unknown_prices.length > 0 ? undefined : estimate.max_usd;
}

export async function runFind(context: Env): Promise<number> {
  const { args, env, style } = context;
  const model = args.positionals[0];
  if (!model) throw new SwapcheckError("find needs a model. For example: swapcheck find gpt-4o");
  const testing = boolFlag(args, "test");
  refuseFormat(args.format, "find", testing ? ["text", "json", "markdown", "sarif"] : ["text", "json", "markdown"]);
  const project = await openProject(openOptions(args, env, testing ? undefined : FREE_COMMAND_REGISTRY_DEADLINE_MS));
  const scan = await scanProject(project.root, project.registry.snapshot, { exclude: project.config.exclude });
  const requirements = await inferRequirements(project.root, model, scan);
  const route = stringFlag(args, "route");
  const limit = intFlag(args, "limit", { min: 1, max: 50 }) ?? 5;
  const result = findReplacements(model, requirements, project.registry.snapshot, project.config.policy, { limit, ...(route ? { route } : {}) });

  if (!testing) {
    const max = await maxCostToTest(project, result, intFlag(args, "runs", { min: 1, max: 200 }) ?? project.config.runs);
    if (max !== undefined) result.max_usd_to_test = max;
    if (args.format === "json") emitJson({ schema: "swapcheck.find/v1", ...result });
    else if (args.format === "markdown") emit(renderFindMarkdown(result));
    else emit(renderFindText(result, style));
    return EXIT.OK;
  }

  if (result.shortlist.length === 0) throw new SwapcheckError(`Nothing in the registry meets what ${model} is used for under your policy, so there is nothing to test.`, EXIT.UNMEASURED);
  const plan = await planComparison(project, { baseline: model, candidates: result.shortlist.map((e) => e.model), ...paidOptions(args), env });
  if (args.format === "text") emit(renderFindText(result, style));
  const { report, reportPath } = await spendAndRun(context, project, plan);
  if (args.format === "json") emitJson({ schema: "swapcheck.find/v1", ...result, tested: true, max_usd_to_test: plan.maxUsd, report, report_path: reportPath });
  else renderReportOutput(context, report, reportPath);
  return exitCodeFor(report);
}

export async function runCases(context: Env): Promise<number> {
  const { args, env } = context;
  refuseFormat(args.format, "cases", ["text", "json"]);
  const [action, ...rest] = args.positionals;
  const project = await openProject(openOptions(args, env, FREE_COMMAND_REGISTRY_DEADLINE_MS));
  const dir = project.config.cases;
  let result: Record<string, unknown>;
  let summary: string;

  if (action === "init") {
    const scan = await scanProject(project.root, project.registry.snapshot, { exclude: project.config.exclude });
    const out = await initCases(project.root, scan, project.config);
    result = { ...out };
    summary = `Wrote ${plural(out.cases, "case")} to ${plural(out.written.length, "file")}.${out.contract_only ? " These are contract checks only." : ""} Generated drafts do not run until you accept them.`;
  } else if (action === "import") {
    const [kind, source] = rest;
    if (!kind || !IMPORT_KINDS.includes(kind as ImportKind)) throw new SwapcheckError(`cases import needs a source type, one of: ${IMPORT_KINDS.join(", ")}.`);
    if (!source) throw new SwapcheckError("cases import needs a path. For example: swapcheck cases import otel traces.jsonl");
    const safeSource = await resolveInsideProject(project.root, source);
    const out = await importCases(kind as ImportKind, safeSource, project.root, dir, { allowUnredacted: boolFlag(args, "allow-unredacted") });
    result = { ...out };
    summary = `Imported ${plural(out.imported, "case")} into ${clean(out.written)}, with ${plural(out.redactions, "redaction")}.`;
  } else if (action === "accept") {
    const all = boolFlag(args, "all");
    if (!all && rest.length === 0) throw new SwapcheckError("cases accept needs case IDs, or --all.");
    const accepted = await acceptCases(project.root, dir, all ? "all" : rest);
    result = { accepted };
    summary = `Accepted ${plural(accepted, "case")}.`;
  } else {
    throw new SwapcheckError("cases needs one of: init, import, accept. Run swapcheck cases --help for examples.");
  }

  if (args.format === "json") emitJson({ schema: "swapcheck.cases/v1", action, ...result });
  else emit(summary);
  return EXIT.OK;
}

function renderBumpText(plan: BumpPlan, pr: PublishedPr | null, dryRun: boolean, style: Styler): string {
  const verb = dryRun ? "Would change" : "Changed";
  const lines = [`${verb} ${clean(plan.from, 120)} to ${clean(plan.to, 120)} in ${plural(plan.changes.length, "file")}.`, ""];
  for (const change of plan.changes) {
    const removed = change.removed_params.length > 0 ? `  removed ${change.removed_params.map((p) => clean(p, 60)).join(", ")}` : "";
    lines.push(`  ${clean(change.file)}  ${plural(change.replacements, "ID")}${removed}`);
  }
  if (plan.skipped.length > 0) {
    lines.push("", `Skipped ${plural(plan.skipped.length, "place")}:`);
    for (const skip of plan.skipped.slice(0, 50)) lines.push(style.dim(`  ${clean(skip.file)}${skip.line ? `:${skip.line}` : ""}  ${clean(skip.reason, 200)}`));
    if (plan.skipped.length > 50) lines.push(style.dim(`  +${plan.skipped.length - 50} more`));
  }
  if (!dryRun) lines.push("", style.dim("Updated models.lock."));
  if (pr) lines.push("", `${pr.created ? "Opened" : "Updated"} pull request #${pr.number}: ${clean(pr.url)}`);
  return lines.join("\n");
}

export async function runBump(context: Env): Promise<number> {
  const { args, env, style } = context;
  refuseFormat(args.format, "bump", ["text", "json"]);
  const from = args.positionals[0];
  const to = stringFlag(args, "to");
  if (!from || !to) throw new SwapcheckError("bump needs both models. For example: swapcheck bump gpt-4o --to gpt-5");
  if (from === to) throw new SwapcheckError("The current model and the target are the same, so there is nothing to change.");
  const dryRun = boolFlag(args, "dry-run");
  const openPr = boolFlag(args, "open-pr");
  if (dryRun && openPr) throw new SwapcheckError("--dry-run and --open-pr cannot be used together.");
  const token = env.GITHUB_TOKEN;
  if (openPr && !token) throw new SwapcheckError("--open-pr needs a GITHUB_TOKEN in the environment.");

  const project = await openProject(openOptions(args, env));
  const { snapshot } = project.registry;
  const target = snapshot.models.find((model) => model.id === to);
  if (target?.status === "retired") throw new SwapcheckError(`${to} is retired according to the registry. Pick another target with swapcheck find ${from}.`);
  if (!target) note(style.yellow(`${clean(to, 120)} is not in the registry, so Swapcheck cannot check which parameters it rejects.`));

  // includeDocs surfaces comments and docs too, so they appear in the skipped list.
  const scan: ScanResult = await scanProject(project.root, snapshot, { exclude: project.config.exclude, includeDocs: true });
  const plan = await planBump({ root: project.root, from, to, snapshot, scan });
  let pr: PublishedPr | null = null;
  if (!dryRun) {
    if (plan.changes.length === 0) {
      emitBump(context, plan, null, dryRun);
      throw new SwapcheckError(`Nothing could be edited for ${from}. See the skipped list above.`);
    }
    if (openPr && token) {
      const evidence = await findEvidence(project.root, from, to, stringFlag(args, "evidence"));
      const gh = createGitHub({ token, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
      const repo = await resolveRepo(project.root, env);
      // Publish first: if GitHub refuses, the working copy has not moved.
      pr = await publishBump({ gh, repo, root: project.root, plan, snapshot, evidence });
    }
    await applyBump(project.root, plan);
  }
  emitBump(context, plan, pr, dryRun);
  return EXIT.OK;
}

function emitBump(context: Env, plan: BumpPlan, pr: PublishedPr | null, dryRun: boolean): void {
  if (context.args.format === "json") {
    emitJson({
      schema: "swapcheck.bump/v1",
      from: plan.from,
      to: plan.to,
      dry_run: dryRun,
      rejected_params: plan.rejected_params,
      changes: plan.changes.map(({ file, replacements, removed_params }) => ({ file, replacements, removed_params })),
      skipped: plan.skipped,
      pull_request: pr,
    });
  } else {
    emit(renderBumpText(plan, pr, dryRun, context.style));
  }
}

export async function runReport(context: Env): Promise<number> {
  const { args } = context;
  const file = args.positionals[0];
  if (!file) throw new SwapcheckError("report needs a file. For example: swapcheck report swapcheck/reports/abc.json");
  const options = openOptions(args, context.env);
  const root = await resolveRoot(options.cwd);
  const absolute = await resolveInsideProject(root, file);
  const info = await stat(absolute);
  if (info.size > MAX_REPORT_BYTES) throw new SwapcheckError(`${file} is larger than 64 MB, so Swapcheck will not read it.`);
  let report: SwapReport;
  try {
    report = JSON.parse(await readFile(absolute, "utf8")) as SwapReport;
  } catch {
    throw new SwapcheckError(`${file} is not valid JSON, so it is not a Swapcheck report.`);
  }
  if (report?.schema !== "swapcheck.report/v1" || !Array.isArray(report.candidates) || !Array.isArray(report.limits)) {
    throw new SwapcheckError(`${file} is not a Swapcheck report. Expected schema swapcheck.report/v1.`);
  }
  renderReportOutput(context, report, undefined);
  return exitCodeFor(report);
}

export function printHelp(command: string | undefined): void {
  emit(helpFor(command));
}
