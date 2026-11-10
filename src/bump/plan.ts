import { lstat, mkdtemp, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readLock, lockFromExposure, writeLock } from "../lock.ts";
import type { LockFile, RegistrySnapshot, ScanFinding, ScanResult } from "../types.ts";
import { computeExposure } from "../watch.ts";
import { isSafeModelId } from "../scan/ids.ts";
import { SwapcheckError } from "../util/errors.ts";
import { insideRoot, realInsideRoot } from "../util/paths.ts";
import { innermostPair, langFor, lexRegions, pairBrackets, regionAt, type BracketPair, type Lang, type Region } from "./lex.ts";
import { removalsNear, yamlRemovalsNear, type ParamRemoval, type TextRange } from "./params.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface BumpSkip {
  file: string;
  line: number;
  reason: string;
}

export interface BumpChange {
  file: string;
  before: string;
  after: string;
  executable: boolean;
  replacements: number;
  removed_params: string[];
}

export interface BumpPlan {
  from: string;
  to: string;
  rejected_params: string[];
  changes: BumpChange[];
  skipped: BumpSkip[];
  lock: LockFile;
}

export interface PlanInput {
  root: string;
  from: string;
  to: string;
  snapshot: RegistrySnapshot;
  scan: ScanResult;
  now?: Date;
}

const ID_CHAR = /[A-Za-z0-9._-]/;
const PRICE_NAME = /pric|cost|tariff|billing|rate_?card/i;
const PRICE_VALUE = /\b(?:input|output|prompt|completion)(?:_?(?:tokens?|cost|price|usd|rate))?\b|pric|cost|usd|per_?(?:m|million|1k)\b/i;

/** Matches the scan lexer's idea of a line: LF, CRLF, or a bare CR. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return starts;
}

/** Scan positions are 1-based, in UTF-16 code units, and point at the first character of the string contents. */
function offsetOf(starts: number[], finding: ScanFinding): number | null {
  const start = starts[finding.line - 1];
  if (start === undefined || finding.column < 1) return null;
  return start + finding.column - 1;
}

function nextCode(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  return i;
}

function prevCode(text: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(text[i] as string)) i--;
  return i;
}

function looksLikePriceTable(text: string, file: string, tokenStart: number, tokenEnd: number, lang: Lang, pairs: BracketPair[]): boolean {
  const after = nextCode(text, tokenEnd);
  const isKey = text[after] === ":" || (lang === "other" && text[after] === "=");
  if (!isKey) {
    const before = prevCode(text, tokenStart - 1);
    if (text[before] !== "[") return false;
    const name = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, before - 64), before))?.[1];
    return name !== undefined && PRICE_NAME.test(name);
  }
  const valueStart = nextCode(text, after + 1);
  if (/[0-9]/.test(text[valueStart] ?? "")) return true;
  if (PRICE_NAME.test(path.basename(file))) return true;
  if (PRICE_VALUE.test(text.slice(valueStart, valueStart + 240))) return true;
  const container = innermostPair(pairs, tokenStart, "{[", text);
  if (container) {
    const name = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(text.slice(Math.max(0, container.open - 80), container.open))?.[1];
    if (name !== undefined && PRICE_NAME.test(name)) return true;
  }
  return false;
}

interface Located {
  offset: number;
  token: TextRange;
}

/** Re-verifies the bytes and decides whether this position is a value bump may rewrite. */
function classify(text: string, regions: Region[], lang: Lang, offset: number, model: string): { located: Located } | { reason: string } {
  if (text.slice(offset, offset + model.length) !== model) return { reason: "the file no longer has this model ID at that position" };
  const before = text[offset - 1] ?? "";
  const after = text[offset + model.length] ?? "";
  if (ID_CHAR.test(before) || ID_CHAR.test(after)) return { reason: "the ID is part of a longer name" };
  const region = regionAt(regions, offset);
  if (region?.kind === "comment") return { reason: "it is in a comment" };
  if (region?.kind === "string") {
    if (offset < region.contentStart || offset + model.length > region.contentEnd) return { reason: "it is not inside the string contents" };
    return { located: { offset, token: { start: region.start, end: region.end } } };
  }
  if (lang !== "other") return { reason: "it is not inside a string" };
  return { located: { offset, token: { start: offset, end: offset + model.length } } };
}

async function readForEdit(root: string, file: string): Promise<{ text: string; executable: boolean } | { reason: string }> {
  let absolute: string;
  try {
    absolute = insideRoot(root, file);
    if (!(await realInsideRoot(root, absolute))) return { reason: "the file is a link that leads outside the project" };
  } catch (error) {
    if (error instanceof SwapcheckError) return { reason: "the path is outside the project" };
    return { reason: "the file could not be found" };
  }
  const info = await lstat(absolute);
  if (!info.isFile()) return { reason: "it is not a regular file" };
  if (info.size > MAX_FILE_BYTES) return { reason: "the file is larger than 2 MB" };
  const bytes = await readFile(absolute);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return { reason: "the file is not valid UTF-8" };
  return { text, executable: (info.mode & 0o100) !== 0 };
}

function applyRanges(text: string, ranges: Array<TextRange & { insert: string }>): string {
  let out = text;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, range.start) + range.insert + out.slice(range.end);
  }
  return out;
}

function overlaps(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function rejectedParams(snapshot: RegistrySnapshot, to: string): string[] {
  const params = snapshot.events.filter((event) => event.type === "parameter_change" && event.model === to).flatMap((event) => event.params ?? []);
  return [...new Set(params)];
}

function paramMentions(text: string, regions: Region[], params: string[], removed: TextRange[], starts: number[], file: string): BumpSkip[] {
  const out: BumpSkip[] = [];
  for (const param of params) {
    const pattern = new RegExp(`(?<![\\w$])${param.replace(/[^\w-]/g, "")}(?![\\w$])`, "g");
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      if (regionAt(regions, at)?.kind === "comment" || removed.some((r) => at >= r.start && at < r.end)) continue;
      const line = starts.findLastIndex((s) => s <= at) + 1;
      out.push({ file, line, reason: `the target rejects ${param}, and this mention was not beside the model ID; check it by hand` });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

interface FileView {
  text: string;
  file: string;
  lang: Lang;
  regions: Region[];
  pairs: BracketPair[];
  starts: number[];
}

/** Every other occurrence in the file gets a line in the skipped list, so nothing is left silently. */
function residualMentions(view: FileView, model: string, handled: Set<number>): BumpSkip[] {
  const out: BumpSkip[] = [];
  for (let at = view.text.indexOf(model); at !== -1 && out.length < 50; at = view.text.indexOf(model, at + model.length)) {
    if (handled.has(at)) continue;
    if (ID_CHAR.test(view.text[at - 1] ?? "") || ID_CHAR.test(view.text[at + model.length] ?? "")) continue;
    const line = view.starts.findLastIndex((start) => start <= at) + 1;
    const region = regionAt(view.regions, at);
    if (region?.kind === "comment") out.push({ file: view.file, line, reason: "it is in a comment" });
    else if (looksLikePriceTable(view.text, view.file, region?.start ?? at, region?.end ?? at + model.length, view.lang, view.pairs)) out.push({ file: view.file, line, reason: "it looks like a price table" });
    else out.push({ file: view.file, line, reason: "the scan did not see it as a model in use" });
  }
  return out;
}

interface FileOutcome {
  change?: BumpChange;
  editedFindings: ScanFinding[];
  skipped: BumpSkip[];
}

function planFile(file: string, text: string, executable: boolean, findings: ScanFinding[], input: PlanInput, params: string[]): FileOutcome {
  const lang = langFor(file);
  const regions = lexRegions(text, lang);
  const pairs = lang === "other" ? [] : pairBrackets(text, regions);
  const starts = lineStarts(text);
  const skipped: BumpSkip[] = [];
  const edits: Array<TextRange & { insert: string }> = [];
  const removals = new Map<number, ParamRemoval>();
  const manualParams = new Set<string>();
  const editedFindings: ScanFinding[] = [];
  const seen = new Set<number>();

  for (const finding of findings) {
    const offset = offsetOf(starts, finding);
    if (offset === null) {
      skipped.push({ file, line: finding.line, reason: "the scan position is not in the file" });
      continue;
    }
    if (seen.has(offset)) continue;
    seen.add(offset);
    const verdict = classify(text, regions, lang, offset, input.from);
    if ("reason" in verdict) {
      skipped.push({ file, line: finding.line, reason: verdict.reason });
      continue;
    }
    if (looksLikePriceTable(text, file, verdict.located.token.start, verdict.located.token.end, lang, pairs)) {
      skipped.push({ file, line: finding.line, reason: "it looks like a price table" });
      continue;
    }
    edits.push({ start: offset, end: offset + input.from.length, insert: input.to });
    editedFindings.push(finding);
    if (params.length === 0) continue;
    if (lang === "other") {
      if (/\.ya?ml$/i.test(file)) {
        const yaml = yamlRemovalsNear(text, offset, params);
        for (const removal of yaml.removals) removals.set(removal.start, removal);
        yaml.manual.forEach((param) => manualParams.add(param));
      }
    } else {
      for (const removal of removalsNear(text, file, offset, params)) removals.set(removal.start, removal);
    }
  }

  skipped.push(...residualMentions({ text, file, lang, regions, pairs, starts }, input.from, seen));
  const kept = [...removals.values()].filter((removal) => !edits.some((edit) => overlaps(edit, removal)));
  if (edits.length === 0) return { editedFindings, skipped };
  const stray = params.length > 0 ? paramMentions(text, regions, params, kept, starts, file) : [];
  skipped.push(...stray);
  for (const param of manualParams) skipped.push({ file, line: 0, reason: `the target rejects ${param}, and its value spans several lines; remove it by hand` });
  const after = applyRanges(text, [...edits, ...kept.map((removal) => ({ start: removal.start, end: removal.end, insert: "" }))]);
  return {
    editedFindings,
    skipped,
    change: { file, before: text, after, executable, replacements: edits.length, removed_params: [...new Set(kept.map((removal) => removal.param))] },
  };
}

export async function planBump(input: PlanInput): Promise<BumpPlan> {
  // The target is written into source files, so it must not be able to close the string it lands in.
  if (!isSafeModelId(input.to)) throw new SwapcheckError("The target model name is not a valid model ID, so nothing was changed. A model ID uses only letters, digits and . _ : / @ [ ] ~ -.");
  const params = rejectedParams(input.snapshot, input.to);
  const findings = input.scan.findings.filter((finding) => finding.model === input.from);
  if (findings.length === 0) throw new SwapcheckError(`${input.from} was not found in this project, so there is nothing to change. Run swapcheck scan to see the models in use.`);
  const byFile = new Map<string, ScanFinding[]>();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);

  const changes: BumpChange[] = [];
  const skipped: BumpSkip[] = [];
  const edited = new Set<ScanFinding>();

  for (const [file, group] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const editable = group.filter((finding) => {
      if (finding.kind === "code" || finding.kind === "config") return true;
      skipped.push({ file, line: finding.line, reason: finding.kind === "docs" ? "docs are left for you to reword" : "environment files are left for you to change where they are deployed" });
      return false;
    });
    if (editable.length === 0) continue;
    const loaded = await readForEdit(input.root, file);
    if ("reason" in loaded) {
      for (const finding of editable) skipped.push({ file, line: finding.line, reason: loaded.reason });
      continue;
    }
    const outcome = planFile(file, loaded.text, loaded.executable, editable, input, params);
    skipped.push(...outcome.skipped);
    if (outcome.change) changes.push(outcome.change);
    outcome.editedFindings.forEach((finding) => edited.add(finding));
  }

  const updatedScan: ScanResult = { ...input.scan, findings: input.scan.findings.map((f) => (edited.has(f) ? { ...f, model: input.to } : f)) };
  const exposure = computeExposure(updatedScan, input.snapshot, input.now);
  const lock = lockFromExposure(exposure, input.snapshot, await readLock(input.root));
  return { from: input.from, to: input.to, rejected_params: params, changes, skipped, lock };
}

async function writeReplacing(target: string, content: string, mode: number): Promise<string> {
  const temp = `${target}.swapcheck-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode, flag: "wx" });
  await chmod(temp, mode);
  return temp;
}

/** Writes every edit to a temp file first, then renames, restoring any file already swapped if one fails. */
export async function applyBump(root: string, plan: BumpPlan): Promise<void> {
  const staged: Array<{ target: string; temp: string; before: string; mode: number }> = [];
  try {
    for (const change of plan.changes) {
      const target = insideRoot(root, change.file);
      if ((await lstat(target)).isSymbolicLink() || !(await realInsideRoot(root, path.dirname(target)))) throw new SwapcheckError(`${change.file} became a symbolic link or moved outside the project, so nothing was written. Run the bump again.`);
      const current = await readFile(target, "utf8");
      if (current !== change.before) throw new SwapcheckError(`${change.file} changed while Swapcheck was working, so nothing was written. Run the bump again.`);
      const { mode } = await stat(target);
      staged.push({ target, temp: await writeReplacing(target, change.after, mode & 0o777), before: change.before, mode: mode & 0o777 });
    }
  } catch (error) {
    await Promise.all(staged.map(({ temp }) => rm(temp, { force: true })));
    throw error;
  }
  const done: typeof staged = [];
  try {
    for (const item of staged) {
      await rename(item.temp, item.target);
      done.push(item);
    }
    await writeLock(root, plan.lock);
  } catch (error) {
    for (const item of done) await writeFile(item.target, item.before, { mode: item.mode });
    await Promise.all(staged.map(({ temp }) => rm(temp, { force: true })));
    throw new SwapcheckError(`The edit could not be finished, so the files were put back: ${(error as Error).message}`);
  }
}

/** Renders the lock through writeLock into a throwaway folder, so a pull request gets the same bytes a local bump would. */
export async function renderLock(lock: LockFile): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swapcheck-lock-"));
  try {
    await writeLock(dir, lock);
    return await readFile(path.join(dir, "models.lock"), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
