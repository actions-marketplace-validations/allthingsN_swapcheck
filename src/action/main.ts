import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyBump, createGitHub, findEvidence, planBump, publishBump, upsertComment, type GitHub } from "../bump/index.ts";
import { parseBoundedInt, parseUsd, splitList } from "../cli/args.ts";
import { describePlan, planComparison, runPlan } from "../cli/compare.ts";
import { mdEscape } from "../cli/output.ts";
import { openProject, type Project } from "../cli/project.ts";
import { itemHeadline, renderExposureMarkdown, renderFindMarkdown } from "../cli/render.ts";
import { findReplacements } from "../find.ts";
import { readLock } from "../lock.ts";
import { exitCodeFor, renderMarkdown } from "../report/index.ts";
import { inferRequirements } from "../scan/requirements.ts";
import { scanProject } from "../scan/scan.ts";
import { EXIT, type ExposureItem, type ScanResult, type SwapReport } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { insideRoot, neutralCwd, realInsideRoot } from "../util/paths.ts";
import { redactSecrets } from "../util/redact.ts";
import { computeExposure, dueItems, watchLock } from "../watch.ts";

const execFileAsync = promisify(execFile);
const MAX_EVENT_BYTES = 25 * 1024 * 1024;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 1000 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_ANNOTATIONS = 10;
const SHA = /^[0-9a-f]{40,64}$/;
const MODES = ["watch", "check", "find", "bump"] as const;
type Mode = (typeof MODES)[number];
const PRIVILEGED_MODES: readonly Mode[] = ["check", "bump"];
// An allowlist, because any other trigger can run on behalf of a fork without looking like one.
const TRUSTED_EVENTS: readonly string[] = ["pull_request", "push", "schedule", "workflow_dispatch", "merge_group", "release"];
const STALE_REGISTRY_DAYS = 7;

export interface Inputs {
  mode: Mode;
  models: string[];
  candidates: string[];
  cases?: string;
  runs?: number;
  maxUsd?: number;
  failWithinDays?: number;
  openPrs: boolean;
  registryUrl?: string;
  workingDirectory: string;
}

function rawInput(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export function readInputs(env: NodeJS.ProcessEnv): Inputs {
  const mode = rawInput(env, "mode") || "watch";
  if (!MODES.includes(mode as Mode)) throw new SwapcheckError(`The mode input must be one of ${MODES.join(", ")}, but got ${mode.slice(0, 40)}.`);
  const list = (name: string): string[] => splitList(rawInput(env, name).replace(/[\r\n]+/g, ","));
  const inputs: Inputs = {
    mode: mode as Mode,
    models: list("models"),
    candidates: list("candidates"),
    openPrs: /^(true|1|yes)$/i.test(rawInput(env, "open-prs")),
    workingDirectory: rawInput(env, "working-directory") || ".",
  };
  const cases = rawInput(env, "cases");
  const runs = rawInput(env, "runs");
  const maxUsd = rawInput(env, "max-usd");
  const days = rawInput(env, "fail-within-days");
  const registryUrl = rawInput(env, "registry-url");
  if (cases) inputs.cases = cases;
  if (runs) inputs.runs = parseBoundedInt("The runs input", runs, { min: 1, max: 200 });
  if (maxUsd) inputs.maxUsd = parseUsd("The max-usd input", maxUsd);
  if (days) inputs.failWithinDays = parseBoundedInt("The fail-within-days input", days, { min: 0, max: 3650 });
  if (registryUrl) inputs.registryUrl = registryUrl;
  return inputs;
}

/** A workflow command is recognised at the start of a line, and ##[ anywhere, so both are defused in every log line. */
export function neutralizeCommands(line: string): string {
  return line.replace(/^(\s*)::/, "$1: :").replace(/##\[/g, "#\u200b#[");
}

export function log(text: string): void {
  for (const line of redactSecrets(text).split(/\r\n|\r|\n/)) process.stdout.write(`${neutralizeCommands(line)}\n`);
}

export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function annotate(level: "error" | "warning" | "notice", message: string, props: { title?: string; file?: string; line?: number } = {}): void {
  const parts: string[] = [];
  if (props.title) parts.push(`title=${escapeProperty(redactSecrets(props.title))}`);
  if (props.file) parts.push(`file=${escapeProperty(redactSecrets(props.file))}`);
  if (props.line) parts.push(`line=${props.line}`);
  const head = parts.length > 0 ? `${level} ${parts.join(",")}` : level;
  process.stdout.write(`::${head}::${escapeData(redactSecrets(message))}\n`);
}

function outputDelimiter(value: string): string {
  for (;;) {
    const delimiter = `swapcheck_${randomBytes(16).toString("hex")}`;
    if (!value.includes(delimiter)) return delimiter;
  }
}

export function setOutput(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  // eslint-disable-next-line no-control-regex
  const cleaned = redactSecrets(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").slice(0, MAX_OUTPUT_CHARS);
  const delimiter = outputDelimiter(cleaned);
  appendFileSync(file, `${name}<<${delimiter}\n${cleaned}\n${delimiter}\n`);
}

/** Text bound for GitHub Markdown: no mentions, no hidden comments that could forge our marker. */
export function sanitizeMarkdown(text: string): string {
  return redactSecrets(text).replace(/<!--/g, "&lt;!--").replace(/@(?=[A-Za-z0-9])/g, "&#64;\u200b").replace(/(?<![&\w])#(?=\d)/g, "#\u200b");
}

function appendSummary(env: NodeJS.ProcessEnv, markdown: string): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  let body = sanitizeMarkdown(markdown);
  if (Buffer.byteLength(body) > MAX_SUMMARY_BYTES) body = `${Buffer.from(body).subarray(0, MAX_SUMMARY_BYTES).toString("utf8")}\n\n(truncated)`;
  appendFileSync(file, `${body}\n`);
}

interface EventInfo {
  name: string;
  payload: Record<string, any>;
  isFork: boolean;
  pullNumber?: number;
  baseSha?: string;
  headSha?: string;
}

export function readEvent(env: NodeJS.ProcessEnv): EventInfo {
  const name = env.GITHUB_EVENT_NAME ?? "";
  let payload: Record<string, any> = {};
  const file = env.GITHUB_EVENT_PATH;
  if (file) {
    try {
      if (statSync(file).size <= MAX_EVENT_BYTES) payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    } catch {
      payload = {};
    }
  }
  const pr = payload.pull_request as Record<string, any> | undefined;
  const info: EventInfo = { name, payload, isFork: false };
  if (pr) {
    // A deleted fork arrives with a null head.repo, and it is treated as untrusted too.
    const headRepo = pr.head?.repo;
    info.isFork = !headRepo || headRepo.fork === true || headRepo.full_name !== pr.base?.repo?.full_name;
    if (Number.isInteger(pr.number)) info.pullNumber = pr.number as number;
    if (typeof pr.base?.sha === "string") info.baseSha = pr.base.sha;
    if (typeof pr.head?.sha === "string") info.headSha = pr.head.sha;
  } else if (name === "push") {
    if (typeof payload.before === "string") info.baseSha = payload.before;
    if (typeof payload.after === "string") info.headSha = payload.after;
  }
  return info;
}

interface ActionState {
  env: NodeJS.ProcessEnv;
  inputs: Inputs;
  event: EventInfo;
  workspace: string;
  root: string;
}

interface Result {
  verdict: string;
  changesDue?: number;
  reportPath?: string;
  spentUsd?: number;
  recommendedModel?: string;
  summary: string;
  exitCode: number;
}

async function resolveWorkingRoot(env: NodeJS.ProcessEnv, inputs: Inputs): Promise<{ workspace: string; root: string }> {
  const workspace = realpathSync(env.GITHUB_WORKSPACE || process.cwd());
  const root = insideRoot(workspace, inputs.workingDirectory);
  let inside = false;
  try {
    inside = await realInsideRoot(workspace, root);
  } catch {
    throw new SwapcheckError(`The working-directory ${inputs.workingDirectory} does not exist.`);
  }
  if (!inside) throw new SwapcheckError("The working-directory leads outside the workspace through a symlink, so Swapcheck will not use it.");
  return { workspace, root: realpathSync(root) };
}

/** A warning for the job log when the registry data is older than the staleness limit. */
export function staleRegistryWarning(generatedAt: string, now: Date = new Date()): string | undefined {
  const days = (now.getTime() - Date.parse(generatedAt)) / 86_400_000;
  if (!(days > STALE_REGISTRY_DAYS)) return undefined;
  return `The registry snapshot from ${generatedAt} is ${Math.floor(days)} days old, so recent model changes may be missing.`;
}

async function open(state: ActionState): Promise<Project> {
  const { inputs, root, env } = state;
  const project = await openProject({ cwd: root, env, ...(inputs.registryUrl ? { registryUrl: inputs.registryUrl } : {}) });
  const stale = staleRegistryWarning(project.registry.snapshot.generated_at);
  if (stale) annotate("warning", stale, { title: "Registry data" });
  if (inputs.cases) {
    insideRoot(project.root, inputs.cases);
    project.config.cases = inputs.cases;
  }
  return project;
}

function repoPath(state: ActionState, file: string): string {
  return path.relative(state.workspace, path.join(state.root, file)).split(path.sep).join("/");
}

function annotateDue(state: ActionState, due: ExposureItem[]): void {
  for (const item of due.slice(0, MAX_ANNOTATIONS)) {
    const event = item.events[0];
    const where = item.locations[0];
    annotate("warning", `${item.model} ${itemHeadline(item)}. Source: ${event?.source ?? "registry"}`, {
      title: "Model change",
      ...(where ? { file: repoPath(state, where.file), line: where.line } : {}),
    });
  }
  if (due.length > MAX_ANNOTATIONS) annotate("notice", `${due.length - MAX_ANNOTATIONS} more model changes are listed in the summary.`);
}

interface Exposure {
  project: Project;
  scan: ScanResult;
  items: ExposureItem[];
  due: ExposureItem[];
  failWithinDays: number;
}

async function exposure(state: ActionState): Promise<Exposure> {
  const project = await open(state);
  const scan = await scanProject(project.root, project.registry.snapshot, { exclude: project.config.exclude });
  const items = computeExposure(scan, project.registry.snapshot);
  const failWithinDays = state.inputs.failWithinDays ?? project.config.watch.fail_within_days;
  return { project, scan, items, due: dueItems(items, failWithinDays), failWithinDays };
}

function restrict(items: ExposureItem[], models: string[]): ExposureItem[] {
  return models.length === 0 ? items : items.filter((item) => models.includes(item.model));
}

async function runForkScan(state: ActionState): Promise<Result> {
  const { due, items, project } = await exposure(state);
  annotateDue(state, due);
  log(`Pull request from a fork: ran the free scan only. ${items.length} models found, ${due.length} with a change due.`);
  return {
    verdict: "FORK_SCAN_ONLY",
    changesDue: due.length,
    summary: `${renderExposureMarkdown("Models in this repo", items, project.registry.snapshot.generated_at)}\nThis pull request comes from a fork, so only the free scan ran.`,
    exitCode: EXIT.OK,
  };
}

async function runWatchMode(state: ActionState): Promise<Result> {
  const base = await exposure(state);
  const lock = await readLock(base.project.root);
  const watched = lock ? watchLock(lock, base.project.registry, { failWithinDays: base.failWithinDays }) : null;
  // The lock knows models but not where they are, so annotations borrow the scan's locations.
  const withLocations = (item: ExposureItem): ExposureItem => ({ ...item, locations: base.items.find((found) => found.model === item.model && found.route === item.route)?.locations ?? item.locations });
  const due = restrict(watched ? watched.due : base.due, state.inputs.models).map(withLocations);
  const items = restrict(watched ? watched.items : base.items, state.inputs.models).map(withLocations);
  annotateDue(state, due);
  log(`${items.length} models watched, ${due.length} changing within ${base.failWithinDays} days.`);
  return {
    verdict: due.length > 0 ? "CHANGES_DUE" : "NO_CHANGES_DUE",
    changesDue: due.length,
    summary: renderExposureMarkdown("Model changes", items, base.project.registry.snapshot.generated_at),
    exitCode: due.length > 0 ? EXIT.FAIL : EXIT.OK,
  };
}

async function runFindMode(state: ActionState): Promise<Result> {
  const { project, scan, items, due } = await exposure(state);
  const targets = state.inputs.models.length > 0 ? state.inputs.models : due.map((item) => item.model);
  if (targets.length === 0) return { verdict: "NO_CHANGES_DUE", changesDue: 0, summary: "No model has a change due, and no models input was given.", exitCode: EXIT.OK };
  let recommended: string | undefined;
  const sections: string[] = [];
  for (const model of targets.slice(0, 10)) {
    const reqs = await inferRequirements(project.root, model, scan);
    const result = findReplacements(model, reqs, project.registry.snapshot, project.config.policy, { limit: 5 });
    recommended ??= result.shortlist[0]?.model;
    sections.push(renderFindMarkdown(result));
  }
  log(`Shortlisted replacements for ${targets.length} models from ${items.length} found.`);
  return { verdict: "SHORTLISTED", changesDue: due.length, ...(recommended ? { recommendedModel: recommended } : {}), summary: sections.join("\n"), exitCode: EXIT.OK };
}

export interface DiffFacts {
  known: boolean;
  relevant: boolean;
  reasons: string[];
  removedModels: string[];
  addedModels: string[];
}

const PROMPT_PATH = /(^|\/)prompts?([/._-]|$)|\.prompt$|\.(j2|jinja2?|mustache|tmpl)$/i;
const PROMPT_LINE = /prompt|system|instruction|messages|"role"|'role'|role:/i;
const MODEL_TOKEN = /[A-Za-z0-9][A-Za-z0-9._:/-]{2,120}/g;

export function analyzeDiff(diff: string, knownModels: Set<string>, filesWithModels: Set<string>, casesDir: string, prefix: string): Omit<DiffFacts, "known"> {
  const reasons = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();
  const casesPrefix = `${prefix}${casesDir.replace(/^\.\//, "").replace(/\/+$/, "")}/`;
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const name = line.slice(4).trim();
      if (name !== "/dev/null") {
        file = name.replace(/^"?[ab]\//, "").replace(/"$/, "");
        if (file.startsWith(casesPrefix)) reasons.add(`case changed: ${file}`);
        if (file === `${prefix}swapcheck.yaml` || file === `${prefix}swapcheck.yml`) reasons.add("config changed");
        if (PROMPT_PATH.test(file)) reasons.add(`prompt file changed: ${file}`);
      }
      continue;
    }
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const content = line.slice(1);
    for (const token of content.match(MODEL_TOKEN) ?? []) {
      if (knownModels.has(token)) (sign === "+" ? added : removed).add(token);
    }
    if (filesWithModels.has(file) && PROMPT_LINE.test(content)) reasons.add(`prompt changed near a model call: ${file}`);
  }
  const addedModels = [...added].filter((m) => !removed.has(m));
  const removedModels = [...removed].filter((m) => !added.has(m));
  if (addedModels.length + removedModels.length > 0) reasons.add("model ID changed");
  return { relevant: reasons.size > 0, reasons: [...reasons], addedModels, removedModels };
}

export async function gitDiff(workspace: string, base: string, head: string): Promise<string | null> {
  const attempt = async (range: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", workspace, "diff", "--no-color", "--no-ext-diff", "--no-renames", "--unified=0", ...range, "--"], { cwd: neutralCwd(), maxBuffer: MAX_DIFF_BYTES, timeout: 60_000 });
      return stdout;
    } catch {
      return null;
    }
  };
  const direct = await attempt([`${base}...${head}`]);
  if (direct !== null) return direct;
  // actions/checkout is shallow by default, so try once to bring in the two commits.
  try {
    await execFileAsync("git", ["-C", workspace, "fetch", "--no-tags", "--depth=1", "origin", base, head], { cwd: neutralCwd(), timeout: 60_000 });
  } catch {
    return null;
  }
  return attempt([base, head]);
}

async function detectChanges(state: ActionState, project: Project, scan: ScanResult): Promise<DiffFacts> {
  const { event, workspace, root } = state;
  const manual = { known: true, relevant: true, reasons: ["run requested"], removedModels: [], addedModels: [] };
  const hasRange = event.baseSha !== undefined && event.headSha !== undefined;
  if (!hasRange) return event.name === "pull_request" || event.name === "push" ? { ...manual, known: false, relevant: false, reasons: [] } : manual;
  const { baseSha, headSha } = event as { baseSha: string; headSha: string };
  if (/^0+$/.test(baseSha)) return manual;
  if (!SHA.test(baseSha) || !SHA.test(headSha)) return { ...manual, known: false, relevant: false, reasons: [] };
  const diff = await gitDiff(workspace, baseSha, headSha);
  if (diff === null) return { ...manual, known: false, relevant: false, reasons: [] };
  const relative = path.relative(workspace, root).split(path.sep).join("/");
  const prefix = relative ? `${relative}/` : "";
  const known = new Set([...project.registry.snapshot.models.map((m) => m.id), ...scan.findings.map((f) => f.model)]);
  const files = new Set(scan.findings.map((f) => `${prefix}${f.file}`));
  return { known: true, ...analyzeDiff(diff, known, files, project.config.cases, prefix) };
}

async function chooseBaseline(state: ActionState, project: Project, facts: DiffFacts): Promise<string | undefined> {
  if (state.inputs.models[0]) return state.inputs.models[0];
  if (project.config.models[0]) return project.config.models[0].id;
  if (facts.removedModels[0]) return facts.removedModels[0];
  const lock = await readLock(project.root);
  return lock?.models.length === 1 ? lock.models[0]?.id : undefined;
}

function recommend(report: SwapReport): string | undefined {
  return [...report.candidates]
    .filter((c) => c.verdict === "NO_CHANGE_DETECTED")
    .sort((a, b) => a.cost_usd_per_case.candidate - b.cost_usd_per_case.candidate)[0]?.model;
}

async function runCheckMode(state: ActionState): Promise<Result> {
  const { inputs } = state;
  const { project, scan, due } = await exposure(state);
  if (inputs.maxUsd === undefined) throw new SwapcheckError("check mode spends money, so it needs the max-usd input. Set it to the most this job may spend.");
  const facts = await detectChanges(state, project, scan);
  if (!facts.known) {
    annotate("error", "Could not read the diff for this change, so nothing was spent. Set fetch-depth: 0 on actions/checkout.");
    return { verdict: "NOT_ENOUGH_EVIDENCE", changesDue: due.length, summary: "Could not read the diff for this change, so nothing was spent.", exitCode: EXIT.UNMEASURED };
  }
  if (!facts.relevant) {
    log("No model ID, prompt or case changed, so nothing was spent.");
    return { verdict: "SKIPPED", changesDue: due.length, summary: "No model ID, prompt or case changed, so nothing was spent.", exitCode: EXIT.OK };
  }
  log(`Measuring because: ${facts.reasons.join("; ")}`);
  const baseline = await chooseBaseline(state, project, facts);
  const candidates = (inputs.candidates.length > 0 ? inputs.candidates : facts.addedModels).filter((m) => m !== baseline);
  if (!baseline || candidates.length === 0) {
    const missing = baseline ? "no candidate" : "no current model";
    annotate("notice", `Swapcheck could not tell what to compare (${missing}), so nothing was spent. Set the models and candidates inputs.`);
    return { verdict: "SKIPPED", changesDue: due.length, summary: `There was ${missing} to compare, so nothing was spent. Set the models and candidates inputs.`, exitCode: EXIT.OK };
  }

  const plan = await planComparison(project, { baseline, candidates, maxUsd: inputs.maxUsd, env: state.env, ...(inputs.runs ? { runs: inputs.runs } : {}) });
  for (const line of describePlan(plan)) log(line);
  const { report, reportPath } = await runPlan(project, plan, (message) => log(message));

  const exitCode = exitCodeFor(report);
  for (const candidate of report.candidates) {
    if (candidate.verdict === "NO_CHANGE_DETECTED") continue;
    annotate(candidate.verdict === "REGRESSED" ? "error" : "warning", `${candidate.model}: ${candidate.verdict}. ${candidate.reason}`, { title: "Model comparison" });
  }
  const worst = report.candidates.some((c) => c.verdict === "REGRESSED") ? "REGRESSED" : (report.candidates.find((c) => c.verdict !== "NO_CHANGE_DETECTED")?.verdict ?? "NO_CHANGE_DETECTED");
  const recommendedModel = recommend(report);
  return {
    verdict: worst,
    changesDue: due.length,
    reportPath: path.relative(state.workspace, path.resolve(state.root, reportPath)).split(path.sep).join("/"),
    spentUsd: report.spent_usd,
    ...(recommendedModel ? { recommendedModel } : {}),
    summary: renderMarkdown(report),
    exitCode,
  };
}

function targetFor(item: ExposureItem, inputs: Inputs, index: number): string | undefined {
  return inputs.candidates[index] ?? inputs.candidates[0] ?? item.events.find((event) => event.to)?.to;
}

async function runBumpMode(state: ActionState): Promise<Result> {
  const { inputs, env } = state;
  const initial = await exposure(state);
  const items = inputs.models.length > 0 ? restrict(initial.items, inputs.models) : initial.due;
  const moved: string[] = [];
  const failed: string[] = [];
  const token = env.GITHUB_TOKEN;
  if (inputs.openPrs && !token) throw new SwapcheckError("open-prs needs GITHUB_TOKEN in the step's env. Add env: GITHUB_TOKEN: secrets.GITHUB_TOKEN to the step.");
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (inputs.openPrs && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SwapcheckError("open-prs needs GITHUB_REPOSITORY set to owner/name.");
  const gh: GitHub | null = inputs.openPrs && token ? createGitHub({ token, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) }) : null;

  let index = -1;
  for (const item of items.slice(0, 20)) {
    index++;
    const to = targetFor(item, inputs, index);
    if (!to) {
      failed.push(`${mdEscape(item.model, 120)}: no target named by the registry; set the candidates input`);
      continue;
    }
    try {
      // Rescan for each model: applying an earlier bump moves the positions of later ones.
      const scan = await scanProject(initial.project.root, initial.project.registry.snapshot, { exclude: initial.project.config.exclude, includeDocs: true });
      const plan = await planBump({ root: initial.project.root, from: item.model, to, snapshot: initial.project.registry.snapshot, scan });
      if (plan.changes.length === 0) {
        failed.push(`${mdEscape(item.model, 120)}: nothing could be edited`);
        continue;
      }
      if (gh) {
        const evidence = await findEvidence(initial.project.root, item.model, to);
        const pr = await publishBump({ gh, repo, root: initial.project.root, plan, snapshot: initial.project.registry.snapshot, evidence });
        moved.push(`${mdEscape(item.model, 120)} to ${mdEscape(to, 120)}: pull request #${pr.number}`);
      } else {
        await applyBump(initial.project.root, plan);
        moved.push(`${mdEscape(item.model, 120)} to ${mdEscape(to, 120)}: edited in the working copy`);
      }
    } catch (error) {
      if (!(error instanceof SwapcheckError)) throw error;
      failed.push(`${mdEscape(item.model, 120)}: ${mdEscape(error.message, 300)}`);
    }
  }
  for (const line of failed) annotate("warning", line, { title: "Bump skipped" });
  const summary = ["## Model bumps", "", ...moved.map((line) => `- ${line}`), ...failed.map((line) => `- Skipped ${line}`), ...(moved.length + failed.length === 0 ? ["No model has a change due."] : [])].join("\n");
  return {
    verdict: moved.length > 0 ? "BUMPED" : "NOTHING_BUMPED",
    changesDue: initial.due.length,
    summary,
    exitCode: failed.length > 0 && moved.length === 0 ? EXIT.UNMEASURED : EXIT.OK,
  };
}

async function publishComment(state: ActionState, result: Result): Promise<void> {
  const { env, event, inputs } = state;
  if (event.isFork || event.pullNumber === undefined || event.name !== "pull_request" || inputs.mode === "bump") return;
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    log("Set GITHUB_TOKEN in the step's env to get a pull request comment.");
    return;
  }
  try {
    const gh = createGitHub({ token, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
    await upsertComment(gh, repo, event.pullNumber, `<!-- swapcheck:${inputs.mode} -->`, sanitizeMarkdown(result.summary).slice(0, 60_000), env.GITHUB_ACTOR);
  } catch (error) {
    annotate("warning", `Could not write the pull request comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeOutputs(env: NodeJS.ProcessEnv, result: Result): void {
  setOutput(env, "verdict", result.verdict);
  setOutput(env, "changes-due", String(result.changesDue ?? 0));
  setOutput(env, "report-path", result.reportPath ?? "");
  setOutput(env, "spent-usd", (result.spentUsd ?? 0).toFixed(6));
  setOutput(env, "recommended-model", result.recommendedModel ?? "");
}

export async function runAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const inputs = readInputs(env);
    const event = readEvent(env);
    if (PRIVILEGED_MODES.includes(inputs.mode) && !TRUSTED_EVENTS.includes(event.name)) {
      throw new SwapcheckError(`${inputs.mode} mode refuses to run under ${event.name.slice(0, 40) || "an unnamed event"}, because that trigger could give untrusted code access to your keys. Use one of: ${TRUSTED_EVENTS.join(", ")}.`);
    }
    const { workspace, root } = await resolveWorkingRoot(env, inputs);
    const state: ActionState = { env, inputs, event, workspace, root };
    const handlers: Record<Mode, (s: ActionState) => Promise<Result>> = { watch: runWatchMode, check: runCheckMode, find: runFindMode, bump: runBumpMode };
    const result = event.isFork ? await runForkScan(state) : await handlers[inputs.mode](state);
    writeOutputs(env, result);
    appendSummary(env, result.summary);
    await publishComment(state, result);
    return result.exitCode;
  } catch (error) {
    if (error instanceof SwapcheckError) {
      annotate("error", error.message);
      writeOutputs(env, { verdict: "ERROR", summary: "", exitCode: error.exitCode });
      return error.exitCode;
    }
    annotate("error", `Swapcheck stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    writeOutputs(env, { verdict: "ERROR", summary: "", exitCode: EXIT.UNMEASURED });
    return EXIT.UNMEASURED;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = await runAction();
