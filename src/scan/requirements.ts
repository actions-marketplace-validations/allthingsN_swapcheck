import path from "node:path";
import type { Requirements, ScanFinding, ScanResult } from "../types.ts";
import { insideRoot, realInsideRoot } from "../util/paths.ts";
import type { Token } from "./lexer.ts";
import { lexSource, readTextFile, walkTokens } from "./scan.ts";
import type { Frame } from "./scan.ts";

const NEARBY_LINES = 15;
const MAX_FILES = 200;
const MAX_SITES_PER_FINDING = 20;
const MAX_EVIDENCE = 40;

const TOOL_KEYS = new Set(["tools", "functions", "toolchoice", "functioncall", "bindtools", "toolconfig"]);
const STRUCTURED_KEYS = new Set(["responseformat", "responseschema", "responsemimetype", "jsonschema", "withstructuredoutput", "generateobject", "streamobject", "zodresponseformat", "textformat", "outputschema", "structuredoutput"]);
const IMAGE_KEYS = new Set(["imageurl", "inputimage", "images", "inlinedata"]);
const AUDIO_KEYS = new Set(["inputaudio"]);
const PDF_KEYS = new Set(["inputfile", "filedata"]);
const MAX_OUTPUT_KEYS = new Set(["maxtokens", "maxcompletiontokens", "maxoutputtokens", "maxtokenstosample"]);

function normalize(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

interface TokenRange {
  from: number;
  to: number;
}

interface Detected {
  tools: boolean;
  structured_output: boolean;
  vision: boolean;
  audio: boolean;
  pdf: boolean;
  maxOutput: number;
}

function isKeyToken(tokens: Token[], i: number): boolean {
  const token = tokens[i] as Token;
  if (token.kind === "ident") return true;
  return token.kind === "string" && (tokens[i + 1]?.value === ":" || tokens[i + 1]?.value === "=");
}

/** `response_format={"type": "text"}` asks for plain text, which needs no structured output. */
function isPlainTextFormat(tokens: Token[], i: number): boolean {
  for (let j = i + 1; j < Math.min(tokens.length, i + 7); j++) {
    if (tokens[j]?.value === "type" && tokens[j + 2]?.kind === "string") return tokens[j + 2]?.value === "text";
  }
  return false;
}

function maxOutputValue(tokens: Token[], i: number): number {
  const separator = tokens[i + 1];
  const value = tokens[i + 2];
  if (!separator || !value || (separator.value !== ":" && separator.value !== "=") || value.kind !== "number") return 0;
  const parsed = Number(value.value.replaceAll("_", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function typeValueOf(tokens: Token[], i: number): string | undefined {
  const before = tokens[i - 2];
  return tokens[i - 1]?.value === ":" && before?.kind === "string" && normalize(before.value) === "type" ? (tokens[i] as Token).value : undefined;
}

function detectInRange(tokens: Token[], range: TokenRange, file: string, evidence: Set<string>, found: Detected): void {
  const note = (token: Token, what: string): void => {
    evidence.add(`${file}:${token.line} ${what}`);
  };
  for (let i = range.from; i <= range.to; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (isKeyToken(tokens, i)) {
      const key = normalize(token.value);
      if (TOOL_KEYS.has(key)) {
        found.tools = true;
        note(token, "passes tools");
      } else if (STRUCTURED_KEYS.has(key) && !isPlainTextFormat(tokens, i)) {
        found.structured_output = true;
        note(token, "requests structured output");
      } else if (IMAGE_KEYS.has(key)) {
        found.vision = true;
        note(token, "sends images");
      } else if (AUDIO_KEYS.has(key)) {
        found.audio = true;
        note(token, "sends audio");
      } else if (PDF_KEYS.has(key)) {
        found.pdf = true;
        note(token, "sends a file");
      } else if (MAX_OUTPUT_KEYS.has(key)) {
        const value = maxOutputValue(tokens, i);
        if (value > 0) {
          found.maxOutput = Math.max(found.maxOutput, value);
          note(token, `sets ${token.value} to ${value}`);
        }
      }
    }
    if (token.kind !== "string") continue;
    const value = token.value;
    const typeValue = typeValueOf(tokens, i);
    if (value === "image_url" || value === "input_image" || value.startsWith("image/") || typeValue === "image") {
      found.vision = true;
      note(token, "sends images");
    } else if (value === "input_audio" || value.startsWith("audio/")) {
      found.audio = true;
      note(token, "sends audio");
    } else if (value === "application/pdf" || typeValue === "document" || typeValue === "input_file") {
      found.pdf = true;
      note(token, "sends a PDF");
    } else if (typeValue === "json_schema" || typeValue === "json_object") {
      found.structured_output = true;
      note(token, "requests structured output");
    }
  }
}

function tokenAt(tokens: Token[], finding: ScanFinding): number {
  return tokens.findIndex((token) => token.line === finding.line && token.column === finding.column);
}

function enclosingFrames(frames: Frame[], index: number): Frame[] {
  return frames.filter((frame) => frame.open < index && index < frame.close && frame.kind !== "block");
}

/** The whole statement-level bracket, so sibling arguments of the model are all in view. */
function outermost(frames: Frame[]): Frame | undefined {
  return frames.reduce<Frame | undefined>((best, frame) => (!best || frame.open < best.open ? frame : best), undefined);
}

function boundName(tokens: Token[], index: number): string | undefined {
  return tokens[index - 1]?.value === "=" && tokens[index - 2]?.kind === "ident" ? tokens[index - 2]?.value : undefined;
}

function callSites(tokens: Token[], frames: Frame[], index: number): TokenRange[] {
  const frame = outermost(enclosingFrames(frames, index));
  if (frame) return [{ from: frame.open, to: frame.close }];
  const name = boundName(tokens, index);
  if (!name) return [{ from: index, to: index }];
  const sites: TokenRange[] = [];
  for (let i = 0; i < tokens.length && sites.length < MAX_SITES_PER_FINDING; i++) {
    const token = tokens[i] as Token;
    if (i === index - 2 || token.kind !== "ident" || token.value !== name) continue;
    const use = outermost(enclosingFrames(frames, i));
    if (use) sites.push({ from: use.open, to: use.close });
  }
  return sites.length > 0 ? sites : [{ from: index, to: index }];
}

function widenByLines(tokens: Token[], range: TokenRange): TokenRange {
  const firstLine = (tokens[range.from]?.line ?? 1) - NEARBY_LINES;
  const lastLine = (tokens[Math.min(range.to, tokens.length - 1)]?.line ?? 1) + NEARBY_LINES;
  let from = range.from;
  while (from > 0 && (tokens[from - 1]?.line ?? 0) >= firstLine) from--;
  let to = range.to;
  while (to < tokens.length - 1 && (tokens[to + 1]?.line ?? 0) <= lastLine) to++;
  return { from, to };
}

async function readInsideRoot(root: string, file: string): Promise<string | null> {
  let target: string;
  try {
    target = insideRoot(root, file);
    if (!(await realInsideRoot(root, target))) return null;
  } catch {
    return null;
  }
  return readTextFile(target);
}

/** Inspects each code location of `model` for features a replacement must also support. */
export async function inferRequirements(root: string, model: string, scan: ScanResult): Promise<Requirements> {
  const base = path.resolve(root);
  const found: Detected = { tools: false, structured_output: false, vision: false, audio: false, pdf: false, maxOutput: 0 };
  const evidence = new Set<string>();
  const findings = scan.findings.filter((finding) => finding.model === model && finding.kind === "code");
  const byFile = new Map<string, ScanFinding[]>();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);

  let inspected = 0;
  for (const [file, fileFindings] of [...byFile].slice(0, MAX_FILES)) {
    const source = await readInsideRoot(base, file);
    if (source === null) continue;
    const lexed = lexSource(file, source);
    if (!lexed) continue;
    inspected++;
    const frames = walkTokens(lexed.codeTokens, lexed.lang);
    for (const finding of fileFindings) {
      const index = tokenAt(lexed.codeTokens, finding);
      if (index < 0) continue;
      for (const site of callSites(lexed.codeTokens, frames, index)) {
        detectInRange(lexed.codeTokens, widenByLines(lexed.codeTokens, site), file, evidence, found);
      }
    }
  }

  if (inspected === 0) evidence.add(`No code call sites of ${model} were found, so no requirements could be inferred.`);
  return {
    tools: found.tools,
    structured_output: found.structured_output,
    vision: found.vision,
    audio: found.audio,
    pdf: found.pdf,
    min_context: 0,
    min_output: found.maxOutput,
    evidence: [...evidence].slice(0, MAX_EVIDENCE),
  };
}
