import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { mdEscape, mdLink } from "../cli/output.ts";
import type { RegistryEvent, RegistrySnapshot, SwapReport } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { readLimited, requireHttps } from "../util/http.ts";
import { insideRoot, neutralCwd, realInsideRoot } from "../util/paths.ts";
import { redactSecrets } from "../util/redact.ts";
import { renderLock, type BumpPlan } from "./plan.ts";

const execFileAsync = promisify(execFile);
const MAX_PR_BODY = 60_000;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_REPORTS_SCANNED = 200;

export interface GitHub {
  request<T>(method: string, route: string, body?: unknown): Promise<T>;
  /** Like request, but a 404 comes back as null. */
  find<T>(route: string): Promise<T | null>;
}

export interface GitHubOptions {
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

class NotFound extends Error {}

function hintFor(status: number): string {
  if (status === 401) return " Check that GITHUB_TOKEN is valid.";
  if (status === 403) return " The token may lack contents and pull-requests write permission, or the rate limit was hit.";
  if (status === 404) return " The repository or branch was not found, or the token cannot see it.";
  return "";
}

export function createGitHub(options: GitHubOptions): GitHub {
  const base = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  requireHttps(base);
  const send = options.fetchImpl ?? fetch;

  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await send(`${base}${route}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "swapcheck",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = await readLimited(res);
    if (res.status === 404) throw new NotFound(route);
    if (!res.ok) {
      let detail = "";
      try {
        detail = String((JSON.parse(Buffer.from(bytes).toString("utf8")) as { message?: unknown }).message ?? "");
      } catch {
        detail = "";
      }
      throw new SwapcheckError(redactSecrets(`GitHub answered ${res.status} to ${method} ${route}${detail ? `: ${detail.slice(0, 300)}` : "."}${hintFor(res.status)}`));
    }
    if (bytes.byteLength === 0) return undefined as T;
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  }

  return {
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      try {
        return await call<T>(method, route, body);
      } catch (error) {
        if (error instanceof NotFound) throw new SwapcheckError(`GitHub answered 404 to ${method} ${route}.${hintFor(404)}`);
        throw error;
      }
    },
    async find<T>(route: string): Promise<T | null> {
      try {
        return await call<T>("GET", route);
      } catch (error) {
        if (error instanceof NotFound) return null;
        throw error;
      }
    },
  };
}

export function repoRoute(repo: string): string {
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}

function pathRoute(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

export async function resolveRepo(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv && /^[\w.-]+\/[\w.-]+$/.test(fromEnv)) return fromEnv;
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "remote", "get-url", "origin"], { cwd: neutralCwd(), timeout: 10_000 });
    const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(stdout);
    if (match?.[1]) return match[1];
  } catch {
    // Falls through to the plain message below.
  }
  throw new SwapcheckError("Could not tell which GitHub repository this is. Set GITHUB_REPOSITORY to owner/name.");
}

/** Branch-safe slug: git refuses "..", a trailing ".lock", and leading or trailing dots. */
export function modelSlug(model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, "-lock").slice(0, 100).replace(/[-.]+$/, "");
  if (!slug) throw new SwapcheckError(`${model} cannot be turned into a branch name.`);
  return slug;
}

export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export interface Evidence {
  relativePath: string;
  content: string;
  report: SwapReport;
}

function comparesMove(report: unknown, from: string, to: string): report is SwapReport {
  const r = report as Partial<SwapReport> | null;
  return r?.schema === "swapcheck.report/v1" && r.baseline_model === from && Array.isArray(r.candidates) && r.candidates.some((c) => c.model === to);
}

async function loadEvidenceFile(root: string, relative: string): Promise<Evidence | null> {
  const absolute = insideRoot(root, relative);
  if (!(await realInsideRoot(root, absolute))) throw new SwapcheckError(`${relative} leads outside the project folder through a symlink, so it will not be attached.`);
  if ((await stat(absolute)).size > MAX_EVIDENCE_BYTES) throw new SwapcheckError(`${relative} is larger than 10 MB, so it will not be attached.`);
  const content = await readFile(absolute, "utf8");
  return { relativePath: path.relative(root, absolute).split(path.sep).join("/"), content, report: JSON.parse(content) as SwapReport };
}

/** Uses the named report, or the newest saved report that compares exactly this move. */
export async function findEvidence(root: string, from: string, to: string, explicit?: string): Promise<Evidence | null> {
  if (explicit) {
    const evidence = await loadEvidenceFile(root, explicit);
    if (!evidence || !comparesMove(evidence.report, from, to)) throw new SwapcheckError(`${explicit} is not a Swapcheck report comparing ${from} with ${to}.`);
    if (!evidence.relativePath.startsWith("swapcheck/reports/")) throw new SwapcheckError(`Evidence must be in swapcheck/reports/, but ${explicit} is not.`);
    return evidence;
  }
  const dir = "swapcheck/reports";
  const names = await readdir(insideRoot(root, dir)).catch(() => [] as string[]);
  let best: Evidence | null = null;
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, MAX_REPORTS_SCANNED)) {
    try {
      const evidence = await loadEvidenceFile(root, `${dir}/${name}`);
      if (evidence && comparesMove(evidence.report, from, to) && (!best || evidence.report.created_at > best.report.created_at)) best = evidence;
    } catch {
      // A malformed report is not evidence; carry on looking.
    }
  }
  return best;
}

export interface PrBodyInput {
  plan: BumpPlan;
  evidence: Evidence | null;
  events: RegistryEvent[];
}

export function renderPrBody({ plan, evidence, events }: PrBodyInput): string {
  const lines = [`Moves ${mdEscape(plan.from, 120)} to ${mdEscape(plan.to, 120)}.`, ""];
  if (events.length > 0) {
    lines.push("### Why", "");
    for (const event of events.slice(0, 5)) lines.push(`- ${mdEscape(event.type)}${event.effective ? ` on ${mdEscape(event.effective)}` : ""}: ${mdLink("source", event.source)}${event.notes ? ` (${mdEscape(event.notes, 300)})` : ""}`);
    lines.push("");
  }
  lines.push("### Evidence", "");
  if (evidence) {
    const candidate = evidence.report.candidates.find((c) => c.model === plan.to);
    lines.push(`Verdict: ${mdEscape(candidate?.verdict ?? "unknown")}. ${mdEscape(candidate?.reason ?? "", 400)}`);
    lines.push(`Measured on ${Number(evidence.report.case_count) || 0} cases, ${Number(evidence.report.runs_per_case) || 0} runs each. Report: ${mdEscape(evidence.relativePath, 200)}`);
    const limits = Array.isArray(evidence.report.limits) ? evidence.report.limits.slice(0, 10) : [];
    if (limits.length > 0) {
      lines.push("", "Limits of this measurement:", "");
      for (const limit of limits) lines.push(`- ${mdEscape(limit, 300)}`);
    }
  } else {
    lines.push("No saved Swapcheck report compares these two models, so this move has not been measured. Run swapcheck test before merging.");
  }
  lines.push("", "### Files changed", "", "| File | IDs replaced | Parameters removed |", "| --- | --- | --- |");
  for (const change of plan.changes) lines.push(`| ${mdEscape(change.file, 200)} | ${change.replacements} | ${change.removed_params.map((p) => mdEscape(p, 60)).join(", ")} |`);
  if (plan.skipped.length > 0) {
    lines.push("", "### Skipped", "");
    for (const skip of plan.skipped.slice(0, 50)) lines.push(`- ${mdEscape(skip.file, 200)}${skip.line ? `:${skip.line}` : ""}: ${mdEscape(skip.reason, 200)}`);
    if (plan.skipped.length > 50) lines.push(`- and ${plan.skipped.length - 50} more`);
  }
  const body = lines.join("\n");
  return body.length > MAX_PR_BODY ? `${body.slice(0, MAX_PR_BODY)}\n\n(truncated)` : body;
}

export interface PublishOptions {
  gh: GitHub;
  repo: string;
  root: string;
  plan: BumpPlan;
  snapshot: RegistrySnapshot;
  evidence: Evidence | null;
  base?: string;
}

export interface PublishedPr {
  number: number;
  url: string;
  branch: string;
  created: boolean;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob";
  sha: string;
}

async function blob(gh: GitHub, repo: string, content: string): Promise<string> {
  const made = await gh.request<{ sha: string }>("POST", `${repoRoute(repo)}/git/blobs`, { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
  return made.sha;
}

/** Commits only the planned edits, on top of the remote base, after proving the local files match it. */
async function commitPlan(options: PublishOptions, baseSha: string, baseBranch: string): Promise<string> {
  const { gh, repo, plan } = options;
  const route = repoRoute(repo);
  const entries: TreeEntry[] = [];
  for (const change of plan.changes) {
    const remote = await gh.find<{ sha: string }>(`${route}/contents/${pathRoute(change.file)}?ref=${encodeURIComponent(baseBranch)}`);
    if (!remote) throw new SwapcheckError(`${change.file} is not on ${baseBranch}. Commit and push it first, or bump without --open-pr.`);
    if (remote.sha !== gitBlobSha(change.before)) throw new SwapcheckError(`${change.file} differs from ${baseBranch}, so a pull request would carry unrelated changes. Commit and push first, or bump without --open-pr.`);
    entries.push({ path: change.file.split(path.sep).join("/"), mode: change.executable ? "100755" : "100644", type: "blob", sha: await blob(gh, repo, change.after) });
  }
  entries.push({ path: "models.lock", mode: "100644", type: "blob", sha: await blob(gh, repo, await renderLock(plan.lock)) });
  if (options.evidence) entries.push({ path: options.evidence.relativePath, mode: "100644", type: "blob", sha: await blob(gh, repo, options.evidence.content) });

  const baseCommit = await gh.request<{ tree: { sha: string } }>("GET", `${route}/git/commits/${baseSha}`);
  const tree = await gh.request<{ sha: string }>("POST", `${route}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  const commit = await gh.request<{ sha: string }>("POST", `${route}/git/commits`, {
    message: `Move ${plan.from.slice(0, 120)} to ${plan.to.slice(0, 120)}`,
    tree: tree.sha,
    parents: [baseSha],
  });
  return commit.sha;
}

/** Opens or updates the one pull request for this model. Re-running moves the same branch. */
export async function publishBump(options: PublishOptions): Promise<PublishedPr> {
  const { gh, repo, plan, snapshot } = options;
  if (plan.changes.length === 0) throw new SwapcheckError(`No edits were possible for ${plan.from}, so there is nothing to put in a pull request.`);
  const route = repoRoute(repo);
  const branch = `swapcheck/${modelSlug(plan.from)}`;
  const baseBranch = options.base ?? (await gh.request<{ default_branch: string }>("GET", route)).default_branch;
  const ref = await gh.request<{ object: { sha: string } }>("GET", `${route}/git/ref/heads/${pathRoute(baseBranch)}`);
  const commitSha = await commitPlan(options, ref.object.sha, baseBranch);

  const existingRef = await gh.find<{ object: { sha: string } }>(`${route}/git/ref/heads/${pathRoute(branch)}`);
  if (existingRef) await gh.request("PATCH", `${route}/git/refs/heads/${pathRoute(branch)}`, { sha: commitSha, force: true });
  else await gh.request("POST", `${route}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha });

  const owner = repo.split("/")[0] as string;
  const title = `Move ${plan.from.slice(0, 120)} to ${plan.to.slice(0, 120)}`.replace(/[\r\n]/g, " ");
  const body = renderPrBody({ plan, evidence: options.evidence, events: snapshot.events.filter((event) => event.model === plan.from) });
  const open = await gh.request<Array<{ number: number; html_url: string }>>("GET", `${route}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
  const existing = open[0];
  if (existing) {
    await gh.request("PATCH", `${route}/pulls/${existing.number}`, { title, body });
    return { number: existing.number, url: existing.html_url, branch, created: false };
  }
  const created = await gh.request<{ number: number; html_url: string }>("POST", `${route}/pulls`, { title, head: branch, base: baseBranch, body });
  return { number: created.number, url: created.html_url, branch, created: true };
}

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string; login?: string };
}

/** Finds our earlier comment by its marker. Only a bot's or the actor's own comment counts, so a commenter cannot plant the marker and have it overwritten. */
export async function upsertComment(gh: GitHub, repo: string, issue: number, marker: string, body: string, actor?: string): Promise<"created" | "updated"> {
  const route = `${repoRoute(repo)}/issues/${issue}/comments`;
  const full = `${marker}\n${body}`;
  for (let page = 1; page <= 10; page++) {
    const comments = await gh.request<IssueComment[]>("GET", `${route}?per_page=100&page=${page}`);
    const mine = comments.find((comment) => comment.body?.startsWith(marker) && (comment.user?.type === "Bot" || (actor !== undefined && comment.user?.login === actor)));
    if (mine) {
      await gh.request("PATCH", `${repoRoute(repo)}/issues/comments/${mine.id}`, { body: full });
      return "updated";
    }
    if (comments.length < 100) break;
  }
  await gh.request("POST", route, { body: full });
  return "created";
}
