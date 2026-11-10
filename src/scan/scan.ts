import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FindingKind, RegistrySnapshot, ScanFinding, ScanResult, UnresolvedCall } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { redactSecrets } from "../util/redact.ts";
import { ROUTE_AZURE, ROUTE_BEDROCK, ROUTE_OPENROUTER, ROUTE_VERTEX, buildIndex, canonicalRoute, firstPartyRoute, isGenericChildKey, isModelKey, isPriceKey, lookupRow, recognize } from "./ids.ts";
import type { ModelIndex, Recognition } from "./ids.ts";
import { CLOSE_JSX, OPEN_JSX, OPEN_TEMPLATE_EXPR, lexJs, lexPython } from "./lexer.ts";
import type { Token } from "./lexer.ts";

export type Lang = "js" | "py";
type FrameKind = "call" | "index" | "array" | "object" | "block" | "paren" | "tmpl" | "jsx";

/** One bracket pair, with what is known about the value it is bound to. */
export interface Frame {
  open: number;
  close: number;
  kind: FrameKind;
  callee?: string;
  /** The key or parameter currently being assigned inside this frame. */
  key?: string;
  /** The key this frame's value is bound to in its parent. */
  name?: string;
  argIndex: number;
  firstArg?: string;
  isType: boolean;
  afterIn: boolean;
  ternary: number;
}

export type ValueVisitor = (index: number, stack: Frame[], inTypeStatement: boolean) => void;

export const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 20_000;
const MAX_UNRESOLVED = 5_000;
const MAX_FILES = 50_000;
const MAX_DEPTH = 64;
const MAX_IGNORE_BYTES = 256 * 1024;
const MAX_IGNORE_RULES = 5_000;
const MAX_PATTERN_LENGTH = 512;
const MAX_EXPRESSION = 120;
const LOOK_AROUND_TOKENS = 40;
const MAX_CONFIG_LINE = 4096;
const MAX_BRACKET_DEPTH = 256;
const FILE_TIME_LIMIT_MS = 1500;
const SCAN_TIME_LIMIT_MS = 120_000;
const TRUNCATED_REASON = "This file was too complex to finish reading in the time allowed, so models in the rest of it were not checked.";
const SCAN_STOPPED_REASON = "The scan reached its time limit here, so this file and the files after it were not checked.";

const JS_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "if", "while", "for", "switch", "catch", "function"]);
const PY_KEYWORDS = new Set(["return", "in", "not", "and", "or", "if", "elif", "else", "yield", "await", "lambda", "is", "from", "import", "assert", "del", "raise", "while", "for", "with", "except"]);
const OBJECT_PRECEDING = new Set(["=", "(", ",", ":", "[", "?", "??", "||", "&&", "return", "...", "default"]);
const COMPARISON = new Set(["==", "===", "!=", "!==", "<", ">", "<=", ">="]);
const FILTER_METHODS = new Set(["includes", "indexOf", "has", "contains"]);

const NON_USE_CALLEES = new Set([
  "startsWith", "endsWith", "startswith", "endswith", "includes", "indexOf", "has", "contains", "match", "matchAll", "test", "search", "replace", "replaceAll",
  "split", "encoding_for_model", "encodingForModel", "from_pretrained", "require", "import_module", "resolve", "join", "open", "readFile", "readFileSync",
  "getElementById", "querySelector", "querySelectorAll", "cn", "clsx", "classNames", "classnames", "Literal",
]);
const LOG_CALLEES = new Set(["print", "pprint", "log", "info", "debug", "warn", "warning", "error", "exception", "critical", "assert", "expect", "describe", "it", "test", "fail"]);
const LOG_ROOTS = new Set(["console", "logger", "logging", "log", "warnings"]);
const GETTER_CALLEES = new Set(["getenv", "get", "env", "environ"]);
const MODEL_CALLEES = new Set([
  "openai", "anthropic", "google", "mistral", "xai", "groq", "deepseek", "bedrock", "vertex", "azure", "cohere", "ChatOpenAI", "ChatAnthropic",
  "ChatGoogleGenerativeAI", "ChatBedrock", "ChatBedrockConverse", "ChatVertexAI", "AzureChatOpenAI", "ChatMistralAI", "ChatGroq", "ChatDeepSeek", "ChatXAI",
  "Agent", "LLM", "completion", "acompletion", "init_chat_model", "initChatModel", "GenerativeModel", "getGenerativeModel",
]);

function isOpener(token: Token): boolean {
  if (token.kind !== "punct") return false;
  return token.value === "(" || token.value === "[" || token.value === "{" || token.value === OPEN_TEMPLATE_EXPR || token.value === OPEN_JSX;
}

function closesFrame(closer: string, frame: Frame): boolean {
  if (closer === ")") return frame.kind === "call" || frame.kind === "paren";
  if (closer === "]") return frame.kind === "index" || frame.kind === "array";
  if (closer === "}") return frame.kind === "object" || frame.kind === "block" || frame.kind === "tmpl" || frame.kind === "paren";
  return frame.kind === "jsx";
}

function isCloser(token: Token): boolean {
  return token.kind === "punct" && (token.value === ")" || token.value === "]" || token.value === "}" || token.value === CLOSE_JSX);
}

function isStringLike(token: Token | undefined): boolean {
  return token?.kind === "string" || token?.kind === "template" || token?.kind === "fstring";
}

function readCallee(tokens: Token[], openIndex: number): string | undefined {
  const parts: string[] = [];
  let i = openIndex - 1;
  while (i >= 0 && parts.length < 8) {
    const token = tokens[i];
    if (token?.kind !== "ident") break;
    parts.unshift(token.value);
    const dot = tokens[i - 1];
    if (dot?.kind !== "punct" || (dot.value !== "." && dot.value !== "?.")) break;
    i -= 2;
  }
  return parts.length > 0 ? parts.join(".") : undefined;
}

function lastSegment(callee: string): string {
  return callee.slice(callee.lastIndexOf(".") + 1);
}

function firstSegment(callee: string): string {
  const dot = callee.indexOf(".");
  return dot < 0 ? callee : callee.slice(0, dot);
}

function continuesStatement(prev: Token, token: Token): boolean {
  if (prev.kind === "punct" && !isCloser(prev) && prev.value !== ";") return true;
  return token.kind === "punct" && [".", "?.", "?", ":", "||", "??", "&&", "+"].includes(token.value);
}

function classifyFrame(tokens: Token[], i: number, lang: Lang, parent: Frame, pendingType: boolean): Frame {
  const token = tokens[i] as Token;
  const prev = tokens[i - 1];
  const keywords = lang === "js" ? JS_KEYWORDS : PY_KEYWORDS;
  const prevIsName = prev?.kind === "ident" && !keywords.has(prev.value);
  const prevCloses = prev !== undefined && isCloser(prev);
  const frame: Frame = {
    open: i,
    close: tokens.length,
    kind: "paren",
    name: parent.key,
    argIndex: 0,
    isType: pendingType,
    afterIn: prev?.kind === "ident" && prev.value === "in",
    ternary: 0,
  };
  if (token.value === "(") {
    frame.kind = prevIsName || prevCloses ? "call" : "paren";
    if (frame.kind === "call") frame.callee = readCallee(tokens, i);
  } else if (token.value === "[") {
    frame.kind = prevIsName || prevCloses || isStringLike(prev) ? "index" : "array";
    if (frame.kind === "index") frame.callee = readCallee(tokens, i);
  } else if (token.value === "{") {
    if (lang === "py") frame.kind = "object";
    else if (parent.kind === "jsx") frame.kind = "paren";
    else frame.kind = prev === undefined || !OBJECT_PRECEDING.has(prev.value) ? "block" : "object";
  } else {
    frame.kind = token.value === OPEN_JSX ? "jsx" : "tmpl";
  }
  return frame;
}

function assignKey(tokens: Token[], i: number, frame: Frame): void {
  const prev = tokens[i - 1];
  if (!prev) return;
  if (prev.kind === "ident" || isStringLike(prev)) {
    // Keep `model` in `model: str = "x"`; `str` is only the annotation.
    if (tokens[i - 2]?.value === ":" && frame.key !== undefined) return;
    frame.key = prev.value;
    return;
  }
  if (prev.value === "]" && tokens[i - 3]?.value === "[" && isStringLike(tokens[i - 2])) {
    frame.key = tokens[i - 2]?.value;
  }
}

function handleColon(tokens: Token[], i: number, frame: Frame): void {
  if (frame.ternary > 0) {
    frame.ternary--;
    return;
  }
  const prev = tokens[i - 1];
  const named = prev?.value === "?" ? tokens[i - 2] : prev;
  if (named && (named.kind === "ident" || isStringLike(named))) frame.key = named.value;
}

function isDeclarationKeyword(tokens: Token[], i: number): boolean {
  const token = tokens[i] as Token;
  if (token.kind !== "ident" || (token.value !== "type" && token.value !== "interface")) return false;
  if (tokens[i + 1]?.kind !== "ident") return false;
  const prev = tokens[i - 1];
  return prev === undefined || prev.line < token.line || prev.value === ";" || prev.value === "}" || prev.value === "export" || prev.value === "declare";
}

/** A deadline for one file, and whether any part of the file went unread. */
export interface WorkLimits {
  deadline: number;
  truncated: boolean;
}

/** True when work must stop. Checks the clock only every 1024 steps, because this runs per token. */
function pastDeadline(limits: WorkLimits | undefined, step: number): boolean {
  if (!limits || (step & 1023) !== 0 || performance.now() <= limits.deadline) return false;
  limits.truncated = true;
  return true;
}

/** Walks code tokens tracking brackets and bindings, in one linear pass. */
export function walkTokens(tokens: Token[], lang: Lang, onValue?: ValueVisitor, limits?: WorkLimits): Frame[] {
  const root: Frame = { open: -1, close: tokens.length, kind: "block", argIndex: 0, isType: false, afterIn: false, ternary: 0 };
  const stack: Frame[] = [root];
  const frames: Frame[] = [];
  let pendingType = false;
  let typeLine = -1;

  for (let i = 0; i < tokens.length; i++) {
    if (pastDeadline(limits, i)) break;
    if (stack.length > MAX_BRACKET_DEPTH) {
      if (limits) limits.truncated = true;
      break;
    }
    const token = tokens[i] as Token;
    const prev = tokens[i - 1];
    let top = stack[stack.length - 1] as Frame;
    if (prev && token.line > prev.line && top.kind === "block" && !continuesStatement(prev, token)) {
      top.key = undefined;
      top.ternary = 0;
    }
    if (lang === "js" && isDeclarationKeyword(tokens, i)) {
      pendingType = true;
      typeLine = token.line;
    }
    if (isOpener(token)) {
      const frame = classifyFrame(tokens, i, lang, top, pendingType || top.isType);
      if (token.value === "{") pendingType = false;
      stack.push(frame);
      frames.push(frame);
      continue;
    }
    if (isCloser(token)) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (!closesFrame(token.value, stack[s] as Frame)) continue;
        (stack[s] as Frame).close = i;
        stack.length = s;
        break;
      }
      continue;
    }
    if (token.kind === "punct") {
      top = stack[stack.length - 1] as Frame;
      if (token.value === ",") {
        top.argIndex++;
        if (top.kind !== "block") top.key = undefined;
        top.ternary = 0;
      } else if (token.value === ";") {
        top.key = undefined;
        top.ternary = 0;
        pendingType = false;
      } else if (token.value === "=") {
        assignKey(tokens, i, top);
      } else if (token.value === ":") {
        handleColon(tokens, i, top);
      } else if (token.value === "?" && lang === "js" && tokens[i + 1]?.value !== ":") {
        top.ternary++;
      }
      continue;
    }
    if (!isStringLike(token)) continue;
    const next = tokens[i + 1];
    const isObjectKey = next?.value === ":" && top.kind === "object" && (prev?.value === "{" || prev?.value === ",");
    if (top.kind === "call" && top.argIndex === 0 && top.firstArg === undefined) top.firstArg = token.value;
    if (!isObjectKey) onValue?.(i, stack, token.line === typeLine);
  }
  return frames;
}

function isTransparent(frame: Frame): boolean {
  return frame.kind === "array" || frame.kind === "paren" || frame.kind === "tmpl";
}

function nearestCall(stack: Frame[]): Frame | undefined {
  for (let s = stack.length - 1; s > 0; s--) {
    const frame = stack[s] as Frame;
    if (frame.kind === "call") return frame;
    if (!isTransparent(frame)) return undefined;
  }
  return undefined;
}

/** Pydantic's create_model and model_* methods take names and data, never an LLM model. */
function isSchemaLibraryCallee(name: string): boolean {
  return name === "create_model" || name.startsWith("model_");
}

function isModelCallee(callee: string): boolean {
  const name = lastSegment(callee);
  return MODEL_CALLEES.has(name) || (isModelKey(name) && !isSchemaLibraryCallee(name));
}

function hasModelContext(tokens: Token[], i: number, stack: Frame[]): boolean {
  for (let s = stack.length - 1, levels = 0; s >= 0 && levels < 4; s--, levels++) {
    const frame = stack[s] as Frame;
    if (frame.key !== undefined && isModelKey(frame.key)) return true;
    if (frame.kind === "call" && frame.callee !== undefined) {
      if (frame.argIndex === 0 && frame.key === undefined && isModelCallee(frame.callee)) return true;
      if (GETTER_CALLEES.has(lastSegment(frame.callee)) && frame.argIndex === 1 && frame.firstArg !== undefined && isModelKey(frame.firstArg)) return true;
    }
    if (frame.kind === "object" && frame.key !== undefined && isGenericChildKey(frame.key) && frame.name !== undefined && isModelKey(frame.name)) return true;
    if (!isTransparent(frame)) break;
  }
  const op = tokens[i - 1];
  const before = tokens[i - 2];
  return (op?.value === "||" || op?.value === "??" || op?.value === "or") && before?.kind === "ident" && isModelKey(before.value);
}

function arrayFollowedByFilter(tokens: Token[], i: number): boolean {
  let depth = 0;
  for (let j = i + 1; j < Math.min(tokens.length, i + 128); j++) {
    const token = tokens[j] as Token;
    if (isOpener(token)) depth++;
    else if (isCloser(token)) {
      if (depth === 0) {
        const method = tokens[j + 2];
        return token.value === "]" && tokens[j + 1]?.value === "." && method !== undefined && FILTER_METHODS.has(method.value);
      }
      depth--;
    }
  }
  return false;
}

function isNumericPriceKey(tokens: Token[], j: number): boolean {
  const token = tokens[j];
  const separator = tokens[j + 1];
  const value = tokens[j + 2];
  if (!token || !separator || !value) return false;
  if (token.kind !== "ident" && !isStringLike(token)) return false;
  return (separator.value === ":" || separator.value === "=") && value.kind === "number" && isPriceKey(token.value);
}

function hasPricedSibling(tokens: Token[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= Math.max(0, i - LOOK_AROUND_TOKENS); j--) {
    const token = tokens[j] as Token;
    if (isCloser(token)) depth++;
    else if (isOpener(token)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && isNumericPriceKey(tokens, j)) return true;
  }
  depth = 0;
  for (let j = i + 1; j <= Math.min(tokens.length - 1, i + LOOK_AROUND_TOKENS); j++) {
    const token = tokens[j] as Token;
    if (isOpener(token)) depth++;
    else if (isCloser(token)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && isNumericPriceKey(tokens, j)) return true;
  }
  return false;
}

function isComparison(prev: Token | undefined, next: Token | undefined): boolean {
  if (prev && COMPARISON.has(prev.value) && prev.kind === "punct") return true;
  if (next && COMPARISON.has(next.value) && next.kind === "punct") return true;
  if (prev?.kind === "ident" && (prev.value === "case" || prev.value === "is")) return true;
  return next?.kind === "ident" && (next.value === "in" || next.value === "not" || next.value === "is");
}

function isInPriceTable(stack: Frame[]): boolean {
  return stack.some((frame) => (frame.key !== undefined && isPriceKey(frame.key)) || (frame.name !== undefined && isPriceKey(frame.name)) || (frame.callee !== undefined && isPriceKey(frame.callee)));
}

/** Strings that mention a model without selecting one: tests, lookups, types, logs and price tables. */
function isNonUse(tokens: Token[], i: number, stack: Frame[], lang: Lang, inTypeStatement: boolean): boolean {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  const top = stack[stack.length - 1] as Frame;
  if (inTypeStatement || stack.some((frame) => frame.isType)) return true;
  if (isComparison(prev, next) || top.kind === "index" || top.afterIn) return true;
  if (lang === "js" && (prev?.value === "|" || next?.value === "|")) return true;
  if (prev?.kind === "ident" && (prev.value === "from" || prev.value === "import")) return true;
  const call = nearestCall(stack);
  if (call?.callee !== undefined) {
    const name = lastSegment(call.callee);
    if (NON_USE_CALLEES.has(name) || LOG_CALLEES.has(name) || LOG_ROOTS.has(firstSegment(call.callee))) return true;
    if (name === "get" && call.argIndex === 0) return true;
  }
  if (top.kind === "array" && arrayFollowedByFilter(tokens, i)) return true;
  if (isInPriceTable(stack)) return true;
  return top.kind === "object" && hasPricedSibling(tokens, i);
}

/** Model IDs have no spaces, so text like `${brand} ${model}` is a display label, not a model. */
function couldBePartOfModelId(text: string): boolean {
  return !/\s/.test(text);
}

function isConcatenated(tokens: Token[], i: number): boolean {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  if (!couldBePartOfModelId((tokens[i] as Token).value)) return false;
  if (prev?.value === "+" || next?.value === "+") return true;
  return next?.value === "." && tokens[i + 2]?.value === "format";
}

interface Signal {
  line: number;
  /** Undefined means the vendor's own API. */
  route?: string;
  vendors?: string[];
  excludeVendors?: string[];
}

type SignalSpec = Omit<Signal, "line">;

const NOT_OPENAI = ["openai"];
const BEDROCK_SIGNAL: SignalSpec = { route: ROUTE_BEDROCK, excludeVendors: NOT_OPENAI };
const VERTEX_SIGNAL: SignalSpec = { route: ROUTE_VERTEX, excludeVendors: NOT_OPENAI };
const AZURE_SIGNAL: SignalSpec = { route: ROUTE_AZURE, vendors: ["openai"] };
const OPENAI_DIRECT: SignalSpec = { vendors: ["openai"] };
const ANTHROPIC_DIRECT: SignalSpec = { vendors: ["anthropic"] };
const GOOGLE_DIRECT: SignalSpec = { vendors: ["google"] };

const CONSTRUCTOR_SIGNALS: Record<string, SignalSpec> = {
  AnthropicBedrock: BEDROCK_SIGNAL,
  AsyncAnthropicBedrock: BEDROCK_SIGNAL,
  ChatBedrock: BEDROCK_SIGNAL,
  ChatBedrockConverse: BEDROCK_SIGNAL,
  BedrockChat: BEDROCK_SIGNAL,
  BedrockLLM: BEDROCK_SIGNAL,
  BedrockRuntimeClient: BEDROCK_SIGNAL,
  createAmazonBedrock: BEDROCK_SIGNAL,
  AnthropicVertex: VERTEX_SIGNAL,
  AsyncAnthropicVertex: VERTEX_SIGNAL,
  VertexAI: VERTEX_SIGNAL,
  ChatVertexAI: VERTEX_SIGNAL,
  ChatAnthropicVertex: VERTEX_SIGNAL,
  createVertex: VERTEX_SIGNAL,
  createVertexAnthropic: VERTEX_SIGNAL,
  AzureOpenAI: AZURE_SIGNAL,
  AsyncAzureOpenAI: AZURE_SIGNAL,
  AzureChatOpenAI: AZURE_SIGNAL,
  createAzure: AZURE_SIGNAL,
  OpenAI: OPENAI_DIRECT,
  AsyncOpenAI: OPENAI_DIRECT,
  ChatOpenAI: OPENAI_DIRECT,
  createOpenAI: OPENAI_DIRECT,
  Anthropic: ANTHROPIC_DIRECT,
  AsyncAnthropic: ANTHROPIC_DIRECT,
  ChatAnthropic: ANTHROPIC_DIRECT,
  createAnthropic: ANTHROPIC_DIRECT,
  GoogleGenerativeAI: GOOGLE_DIRECT,
  ChatGoogleGenerativeAI: GOOGLE_DIRECT,
};

const HOST_SIGNALS: Array<[string, SignalSpec]> = [
  ["bedrock-runtime", BEDROCK_SIGNAL],
  ["amazon-bedrock", BEDROCK_SIGNAL],
  ["bedrock-sdk", BEDROCK_SIGNAL],
  ["client-bedrock", BEDROCK_SIGNAL],
  ["aiplatform.googleapis.com", VERTEX_SIGNAL],
  ["google-vertex", VERTEX_SIGNAL],
  ["vertex-sdk", VERTEX_SIGNAL],
  ["google-cloud/vertexai", VERTEX_SIGNAL],
  ["openai.azure.com", AZURE_SIGNAL],
  ["openrouter.ai", { route: ROUTE_OPENROUTER }],
  ["api.groq.com", { route: "groq" }],
  ["api.together", { route: "together" }],
  ["api.fireworks.ai", { route: "fireworks" }],
  ["generativelanguage.googleapis.com", GOOGLE_DIRECT],
  ["api.openai.com", OPENAI_DIRECT],
  ["api.anthropic.com", ANTHROPIC_DIRECT],
];

function hostSignal(value: string): SignalSpec | undefined {
  for (const [needle, spec] of HOST_SIGNALS) {
    if (value.includes(needle)) return spec;
  }
  return undefined;
}

function collectSignals(tokens: Token[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.kind === "ident" && tokens[i + 1]?.value === "(") {
      const spec = CONSTRUCTOR_SIGNALS[token.value];
      if (spec) signals.push({ line: token.line, ...spec });
    } else if (isStringLike(token)) {
      const spec = hostSignal(token.value);
      if (spec) signals.push({ line: token.line, ...spec });
    }
  }
  return signals;
}

function signalApplies(signal: Signal, vendor: string | undefined): boolean {
  if (signal.vendors && (vendor === undefined || !signal.vendors.includes(vendor))) return false;
  return !(signal.excludeVendors && vendor !== undefined && signal.excludeVendors.includes(vendor));
}

const SIGNAL_LOOKAHEAD_LINES = 30;

/** The closest applicable client above the model, or failing that just below it. */
function nearestSignal(signals: Signal[], line: number, vendor: string | undefined): Signal | undefined {
  let before: Signal | undefined;
  let after: Signal | undefined;
  for (const signal of signals) {
    if (!signalApplies(signal, vendor)) continue;
    if (signal.line <= line) {
      if (!before || signal.line >= before.line) before = signal;
    } else if (signal.line - line <= SIGNAL_LOOKAHEAD_LINES && (!after || signal.line < after.line)) {
      after = signal;
    }
  }
  return before ?? after;
}

function resolveRoute(rec: Recognition, signals: Signal[], line: number, index: ModelIndex): string | undefined {
  if (rec.fixedRoute !== undefined) return canonicalRoute(index, rec.fixedRoute);
  const signal = nearestSignal(signals, line, rec.vendor);
  if (signal?.route !== undefined) return canonicalRoute(index, signal.route);
  return firstPartyRoute(index, rec.model, rec.vendor);
}

interface Collector {
  index: ModelIndex;
  findings: ScanFinding[];
  unresolved: UnresolvedCall[];
  includeDocs: boolean;
  fileTimeLimitMs: number;
  /** performance.now() value after which no more files are read. */
  scanDeadline: number;
  scanStopped: boolean;
}

function addFinding(out: Collector, rec: Recognition, route: string | undefined, file: string, line: number, column: number, kind: FindingKind): void {
  if (out.findings.length >= MAX_FINDINGS) return;
  const provider = lookupRow(out.index, rec.model, route)?.provider ?? out.index.providers.get(rec.model) ?? rec.vendor;
  const finding: ScanFinding = { model: rec.model, file, line, column, kind, known: rec.known };
  if (provider !== undefined) finding.provider = provider;
  if (route !== undefined) finding.route = route;
  out.findings.push(finding);
}

function addUnresolved(out: Collector, source: string, token: Token, file: string, reason: string): void {
  if (out.unresolved.length >= MAX_UNRESOLVED) return;
  const expression = redactSecrets(source.slice(token.start, Math.min(token.end, token.start + MAX_EXPRESSION)));
  out.unresolved.push({ file, line: token.line, column: token.column, expression, reason });
}

function isCodeToken(token: Token): boolean {
  return token.kind !== "comment" && token.kind !== "docstring";
}

export function lexSource(file: string, source: string, limits?: WorkLimits): { tokens: Token[]; codeTokens: Token[]; lang: Lang } | null {
  const lang = codeLanguage(file);
  if (!lang) return null;
  const ext = path.extname(file).toLowerCase();
  const lexLimits = limits ? { deadline: limits.deadline } : {};
  const { tokens, truncated } = lang === "py" ? lexPython(source, lexLimits) : lexJs(source, { jsx: ext !== ".ts" && ext !== ".mts" && ext !== ".cts", ...lexLimits });
  if (truncated && limits) limits.truncated = true;
  return { tokens, codeTokens: tokens.filter(isCodeToken), lang };
}

function scanCode(rel: string, source: string, out: Collector, docKind: boolean, limits: WorkLimits): void {
  const lexed = lexSource(rel, source, limits);
  if (!lexed) return;
  const { tokens, codeTokens, lang } = lexed;
  const signals = collectSignals(codeTokens);
  walkTokens(codeTokens, lang, (i, stack, inTypeStatement) => {
    const token = codeTokens[i] as Token;
    if (token.unterminated || isNonUse(codeTokens, i, stack, lang, inTypeStatement)) return;
    const context = hasModelContext(codeTokens, i, stack);
    if (token.dynamic) {
      if (context && !docKind && couldBePartOfModelId(token.value)) {
        addUnresolved(out, source, token, rel, token.kind === "fstring" ? "The model is built with an f-string, so its value is only known at runtime." : "The model is built with a template literal, so its value is only known at runtime.");
      }
      return;
    }
    const rec = recognize(token.value, out.index, context);
    if (!rec) {
      if (context && !docKind && isConcatenated(codeTokens, i)) addUnresolved(out, source, token, rel, "The model name is concatenated at runtime, so its value is only known at runtime.");
      return;
    }
    addFinding(out, rec, resolveRoute(rec, signals, token.line, out.index), rel, token.line, token.column, docKind ? "docs" : "code");
  }, limits);
  if (out.includeDocs) {
    for (const token of tokens) {
      if (!isCodeToken(token)) scanProse(rel, token.value, token.line, token.column, out);
    }
  }
}

/** Only known IDs count in prose: there is no surrounding code to give context. */
function scanProse(rel: string, text: string, firstLine: number, firstColumn: number, out: Collector): void {
  let line = firstLine;
  let lineStart = 0;
  const offset = (at: number): number => (line === firstLine ? firstColumn + at : at - lineStart + 1);
  let wordStart = -1;
  const flush = (end: number): void => {
    if (wordStart < 0) return;
    const rec = recognize(text.slice(wordStart, end).replace(/[.:]+$/, ""), out.index, false);
    if (rec) addFinding(out, rec, firstPartyRoute(out.index, rec.model, rec.vendor), rel, line, offset(wordStart), "docs");
    wordStart = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\n") {
      flush(i);
      line++;
      lineStart = i + 1;
    } else if (/[\s`"'(),;<>{}|*=]/.test(ch)) {
      flush(i);
    } else if (wordStart < 0) {
      wordStart = i;
    }
  }
  flush(text.length);
}

interface ConfigPair {
  path: string[];
  value: string;
  line: number;
  column: number;
}

function pathHintsModel(keys: string[]): boolean {
  const last = keys[keys.length - 1];
  if (last === undefined) return false;
  if (isModelKey(last)) return true;
  const parent = keys[keys.length - 2];
  return isGenericChildKey(last) && parent !== undefined && isModelKey(parent);
}

const PROVIDER_KEYS = new Set(["provider", "api_type", "apitype", "backend", "route", "platform"]);
const PROVIDER_VALUES: Array<[RegExp, SignalSpec]> = [
  [/bedrock/i, BEDROCK_SIGNAL],
  [/vertex/i, VERTEX_SIGNAL],
  [/azure/i, AZURE_SIGNAL],
  [/openrouter/i, { route: ROUTE_OPENROUTER }],
];

function configSignal(keys: string[], value: string, line: number): Signal | undefined {
  const host = hostSignal(value);
  if (host) return { line, ...host };
  const key = (keys[keys.length - 1] ?? "").toLowerCase();
  if (!PROVIDER_KEYS.has(key)) return undefined;
  for (const [pattern, spec] of PROVIDER_VALUES) {
    if (pattern.test(value)) return { line, ...spec };
  }
  return undefined;
}

function reportPairs(rel: string, pairs: ConfigPair[], extraSignals: Signal[], kind: FindingKind, out: Collector, docKind: boolean, limits?: WorkLimits): void {
  const signals = [...extraSignals];
  for (const pair of pairs) {
    const signal = configSignal(pair.path, pair.value, pair.line);
    if (signal) signals.push(signal);
  }
  for (let n = 0; n < pairs.length; n++) {
    if (pastDeadline(limits, n)) break;
    const pair = pairs[n] as ConfigPair;
    if (!pathHintsModel(pair.path)) continue;
    const rec = recognize(pair.value, out.index, true);
    if (!rec) continue;
    addFinding(out, rec, resolveRoute(rec, signals, pair.line, out.index), rel, pair.line, pair.column, docKind ? "docs" : kind);
  }
}

function stripInlineComment(text: string, marker: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === marker && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i);
    }
  }
  return text;
}

function unquote(text: string): { value: string; offset: number } {
  const first = text[0];
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) {
    return { value: text.slice(1, -1), offset: 1 };
  }
  return { value: text, offset: 0 };
}

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (line[n] === " " || line[n] === "\t") n++;
  return n;
}

/** Index of the `:` ending a plain or quoted YAML key, or -1. */
function yamlColon(text: string): number {
  const quote = text[0] === '"' || text[0] === "'" ? text[0] : "";
  let i = 0;
  if (quote) {
    i = text.indexOf(quote, 1);
    if (i < 0) return -1;
    i++;
    return text[i] === ":" && (i + 1 >= text.length || text[i + 1] === " ") ? i : -1;
  }
  if (text[0] === "{" || text[0] === "[" || text[0] === "#") return -1;
  for (; i < text.length; i++) {
    if (text[i] === ":" && (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\t")) return i;
  }
  return -1;
}

function pushFlowItems(body: string, bodyColumn: number, keys: string[], line: number, pairs: ConfigPair[]): void {
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i < body.length && body[i] !== ",") continue;
    const item = body.slice(start, i);
    const trimmed = item.trim();
    if (trimmed) {
      const { value, offset } = unquote(trimmed);
      pairs.push({ path: keys, value, line, column: bodyColumn + start + (item.length - item.trimStart().length) + offset });
    }
    start = i + 1;
  }
}

function pushScalar(raw: string, column: number, keys: string[], line: number, pairs: ConfigPair[]): void {
  const noComment = stripInlineComment(raw, "#").trimEnd();
  if (!noComment || noComment.startsWith("&") || noComment.startsWith("*") || noComment.startsWith("!")) return;
  if (noComment.startsWith("[") && noComment.endsWith("]")) {
    pushFlowItems(noComment.slice(1, -1), column + 1, keys, line, pairs);
    return;
  }
  const { value, offset } = unquote(noComment);
  pairs.push({ path: keys, value, line, column: column + offset });
}

export function parseYamlPairs(source: string): ConfigPair[] {
  const pairs: ConfigPair[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let blockScalarIndent = -1;
  splitLines(source).forEach((text, n) => {
    if (text.length > MAX_CONFIG_LINE) return;
    const lineNo = n + 1;
    const trimmed = text.trim();
    let indent = leadingSpaces(text);
    if (blockScalarIndent >= 0) {
      if (trimmed === "" || indent > blockScalarIndent) return;
      blockScalarIndent = -1;
    }
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") return;
    let body = text.slice(indent);
    let column = indent + 1;
    if (body === "-" || body.startsWith("- ")) {
      const after = body.slice(1);
      const skipped = 1 + leadingSpaces(after);
      const itemIndent = indent;
      indent += skipped;
      column += skipped;
      body = body.slice(skipped);
      while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent > itemIndent) stack.pop();
    }
    const colon = yamlColon(body);
    if (colon < 0) {
      if (body) pushScalar(body, column, stack.map((entry) => entry.key), lineNo, pairs);
      return;
    }
    const { value: key } = unquote(body.slice(0, colon).trim());
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const keys = [...stack.map((entry) => entry.key), key];
    const rawValue = body.slice(colon + 1);
    const valueText = rawValue.trimStart();
    const valueColumn = column + colon + 1 + (rawValue.length - valueText.length);
    if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(valueText)) {
      blockScalarIndent = indent;
    } else if (valueText && !valueText.startsWith("#")) {
      pushScalar(valueText, valueColumn, keys, lineNo, pairs);
    }
    if (!valueText || valueText.startsWith("#")) stack.push({ indent, key });
  });
  return pairs;
}

export function parseTomlPairs(source: string): ConfigPair[] {
  const pairs: ConfigPair[] = [];
  let section: string[] = [];
  let openArray: { keys: string[] } | null = null;
  let tripleQuote = "";
  splitLines(source).forEach((text, n) => {
    if (text.length > MAX_CONFIG_LINE) return;
    const lineNo = n + 1;
    const trimmed = text.trim();
    if (tripleQuote) {
      if (trimmed.includes(tripleQuote)) tripleQuote = "";
      return;
    }
    if (!trimmed || trimmed.startsWith("#")) return;
    if (openArray) {
      const body = stripInlineComment(trimmed, "#").trim();
      const closed = body.endsWith("]");
      pushFlowItems(closed ? body.slice(0, -1) : body, leadingSpaces(text) + 1, openArray.keys, lineNo, pairs);
      if (closed) openArray = null;
      return;
    }
    if (trimmed.startsWith("[")) {
      section = trimmed.replace(/^\[+/, "").replace(/\].*$/, "").split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""));
      return;
    }
    const eq = text.indexOf("=");
    if (eq < 0) return;
    const keys = [...section, ...text.slice(0, eq).trim().split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""))];
    const rawValue = text.slice(eq + 1);
    const valueText = rawValue.trimStart();
    const valueColumn = eq + 2 + (rawValue.length - valueText.length);
    if (valueText.startsWith('"""') || valueText.startsWith("'''")) {
      const quote = valueText.slice(0, 3);
      if (!valueText.slice(3).includes(quote)) tripleQuote = quote;
      return;
    }
    const noComment = stripInlineComment(valueText, "#").trimEnd();
    if (noComment.startsWith("[")) {
      if (noComment.endsWith("]")) pushFlowItems(noComment.slice(1, -1), valueColumn + 1, keys, lineNo, pairs);
      else {
        pushFlowItems(noComment.slice(1), valueColumn + 1, keys, lineNo, pairs);
        openArray = { keys };
      }
      return;
    }
    const { value, offset } = unquote(noComment);
    pairs.push({ path: keys, value, line: lineNo, column: valueColumn + offset });
  });
  return pairs;
}

export function parseEnvPairs(source: string): ConfigPair[] {
  const pairs: ConfigPair[] = [];
  splitLines(source).forEach((text, n) => {
    if (text.length > MAX_CONFIG_LINE) return;
    const indent = leadingSpaces(text);
    let body = text.slice(indent);
    if (!body || body.startsWith("#")) return;
    let column = indent + 1;
    if (body.startsWith("export ")) {
      const skipped = 7 + leadingSpaces(body.slice(7));
      body = body.slice(skipped);
      column += skipped;
    }
    const eq = body.indexOf("=");
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(body.slice(0, eq))) return;
    const rawValue = stripInlineComment(body.slice(eq + 1), "#").trim();
    const leading = body.slice(eq + 1).length - body.slice(eq + 1).trimStart().length;
    const { value, offset } = unquote(rawValue);
    if (value) pairs.push({ path: [body.slice(0, eq)], value, line: n + 1, column: column + eq + 1 + leading + offset });
  });
  return pairs;
}

export function parseJsonPairs(source: string, limits?: WorkLimits): ConfigPair[] {
  const pairs: ConfigPair[] = [];
  const { tokens, truncated } = lexJs(source, limits ? { deadline: limits.deadline } : {});
  if (truncated && limits) limits.truncated = true;
  const path: Array<string | undefined> = [];
  let pending: string | undefined;
  const keys = (): string[] => [...path, pending].filter((key): key is string => key !== undefined);
  for (let i = 0; i < tokens.length; i++) {
    if (pastDeadline(limits, i)) break;
    if (path.length > MAX_BRACKET_DEPTH) {
      if (limits) limits.truncated = true;
      break;
    }
    const token = tokens[i] as Token;
    if (token.kind === "string") {
      if (tokens[i + 1]?.value === ":") {
        pending = token.value;
      } else {
        if (!token.unterminated) pairs.push({ path: keys(), value: token.value, line: token.line, column: token.column });
        pending = undefined;
      }
    } else if (token.value === "{" || token.value === "[") {
      path.push(pending);
      pending = undefined;
    } else if (token.value === "}" || token.value === "]") {
      path.pop();
      pending = undefined;
    }
  }
  return pairs;
}

const ENV_ROUTE_KEYS: Array<[RegExp, SignalSpec]> = [
  [/BEDROCK/, BEDROCK_SIGNAL],
  [/VERTEX/, VERTEX_SIGNAL],
  [/AZURE/, AZURE_SIGNAL],
  [/OPENROUTER/, { route: ROUTE_OPENROUTER }],
];

const DISABLED_VALUES = new Set(["0", "false", "no", "off", ""]);

function envKeySignals(pairs: ConfigPair[]): Signal[] {
  const signals: Signal[] = [];
  for (const pair of pairs) {
    if (DISABLED_VALUES.has(pair.value.toLowerCase())) continue;
    for (const [pattern, spec] of ENV_ROUTE_KEYS) {
      // Env files are flat, so a route switch anywhere in the file applies to all of it.
      if (pattern.test(pair.path[0] ?? "")) signals.push({ line: 0, ...spec });
    }
  }
  return signals;
}

type FileType = "code" | "yaml" | "toml" | "json" | "env" | "prose";

const CODE_EXTENSIONS = new Map<string, Lang>([
  [".ts", "js"], [".tsx", "js"], [".mts", "js"], [".cts", "js"], [".js", "js"], [".jsx", "js"], [".mjs", "js"], [".cjs", "js"], [".py", "py"], [".pyi", "py"],
]);

function codeLanguage(file: string): Lang | undefined {
  return CODE_EXTENSIONS.get(path.extname(file).toLowerCase());
}

function fileTypeOf(name: string): FileType | undefined {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower === ".envrc" || lower.startsWith(".env.") || lower.endsWith(".env")) return "env";
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts") || lower.includes(".min.")) return undefined;
  const ext = path.extname(lower);
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".toml") return "toml";
  if (ext === ".json" || ext === ".jsonc") return "json";
  if (ext === ".md" || ext === ".mdx" || ext === ".rst") return "prose";
  return undefined;
}

const SKIPPED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "dist", "build", "out", "target", "coverage", "venv", ".venv", "virtualenv", "__pycache__",
  "site-packages", "vendor", "vendors", "vendored", "third_party", "thirdparty", "generated", "__generated__", "gen", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".gradle", ".idea", ".terraform", ".swapcheck-cache",
]);
const SCANNED_HIDDEN_DIRS = new Set([".github", ".gitlab", ".circleci"]);
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock",
  "composer.lock", "gemfile.lock", "go.sum", "flake.lock", "models.lock", "swapcheck.yaml", "swapcheck.yml",
]);

function isSkippedDir(name: string, rel: string): boolean {
  if (SKIPPED_DIRS.has(name) || name.endsWith(".egg-info")) return true;
  if (name.startsWith(".") && !SCANNED_HIDDEN_DIRS.has(name)) return true;
  return rel === "swapcheck";
}

const DOC_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "fixtures", "__fixtures__", "__mocks__", "mocks", "testdata", "test_data", "e2e", "examples", "example", "samples", "sample", "docs", "doc", "cookbook", "cookbooks", "benchmarks", "benchmark", "conformance", "seeds", "seeders"]);

/** Tests, fixtures, examples and documentation mention models without running them in production. */
export function isDocumentationPath(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((part) => DOC_DIRS.has(part.toLowerCase()))) return true;
  return /\.(?:test|spec|stories)\.[a-z]+$/i.test(name) || /^test_.*\.py$/i.test(name) || /_test\.py$/i.test(name) || name === "conftest.py"
    // Database seed scripts write sample rows; they do not call a model.
    || /^seeds?\.(?:py|[cm]?[jt]s)$/i.test(name);
}

const DATA_OUTPUT_DIRS = new Set(["data", "results", "result", "outputs", "output", "logs", "reports", "snapshots", "__snapshots__", "dumps", "traces", "runs", "evals", "artifacts"]);

/** JSON under these folders records past runs or datasets; it does not choose a model. */
function isDataOutputPath(rel: string): boolean {
  const parts = rel.split("/");
  if (/(?:^|[._-])(?:results?|vectors)\.json$/i.test(parts[parts.length - 1] ?? "")) return true;
  return parts.slice(0, -1).some((part) => DATA_OUTPUT_DIRS.has(part.toLowerCase()));
}

/** Reads a regular file without following a final symlink. Null when unusable. */
export async function readTextFile(file: string, limit: number = MAX_SCANNED_BYTES): Promise<string | null> {
  let handle;
  try {
    // Windows has no O_NOFOLLOW, so check the link first and confirm the opened file is the same one.
    const linkInfo = await lstat(file);
    if (linkInfo.isSymbolicLink()) return null;
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (info.ino !== linkInfo.ino || info.dev !== linkInfo.dev) return null;
    if (!info.isFile() || info.size > limit) return null;
    const bytes = await handle.readFile();
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function looksMinified(source: string): boolean {
  if (source.length < 4096) return false;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return source.length / lines > 1000;
}

const GENERATED_MARKERS = ["@generated", "DO NOT EDIT", "Code generated by", "auto-generated", "autogenerated"];

function looksGenerated(source: string): boolean {
  const header = source.slice(0, 1024);
  return GENERATED_MARKERS.some((marker) => header.includes(marker));
}

interface IgnoreRule {
  base: string;
  segments: string[];
  anchored: boolean;
  dirOnly: boolean;
  negated: boolean;
}

export function parseIgnoreRule(line: string, base: string): IgnoreRule | null {
  let text = line.replace(/\r$/, "");
  if (!text || text.startsWith("#") || text.length > MAX_PATTERN_LENGTH) return null;
  while (text.endsWith(" ") && !text.endsWith("\\ ")) text = text.slice(0, -1);
  if (!text) return null;
  let negated = false;
  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  }
  if (text.startsWith("\\#") || text.startsWith("\\!")) text = text.slice(1);
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.slice(0, -1);
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);
  if (!text) return null;
  return { base, segments: text.split("/"), anchored, dirOnly, negated };
}

function classMatches(pattern: string, start: number, ch: string): { matched: boolean; next: number } | null {
  let i = start + 1;
  const negated = pattern[i] === "!" || pattern[i] === "^";
  if (negated) i++;
  let matched = false;
  let first = true;
  for (; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "]" && !first) return { matched: matched !== negated, next: i + 1 };
    first = false;
    if (pattern[i + 1] === "-" && pattern[i + 2] !== undefined && pattern[i + 2] !== "]") {
      if (c <= ch && ch <= (pattern[i + 2] as string)) matched = true;
      i += 2;
    } else if (c === ch) {
      matched = true;
    }
  }
  return null;
}

/** Glob match for one path segment. Iterative, so hostile patterns cannot backtrack badly. */
export function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const c = pattern[p];
    const ch = text[t] as string;
    if (c === "*") {
      starP = p++;
      starT = t;
      continue;
    }
    if (c === "[") {
      const cls = classMatches(pattern, p, ch);
      if (cls) {
        if (cls.matched) {
          p = cls.next;
          t++;
          continue;
        }
      } else if (ch === "[") {
        p++;
        t++;
        continue;
      }
    } else if (c === "\\" && pattern[p + 1] === ch) {
      p += 2;
      t++;
      continue;
    } else if (c === "?" || (c === ch && c !== undefined)) {
      p++;
      t++;
      continue;
    }
    if (starP < 0) return false;
    p = starP + 1;
    t = ++starT;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function matchSegments(rule: string[], parts: string[]): boolean {
  // Row r holds which prefixes of `parts` the first r rule segments can consume.
  let row = new Array<boolean>(parts.length + 1).fill(false);
  row[0] = true;
  for (let r = 0; r < rule.length; r++) {
    const segment = rule[r] as string;
    const next = new Array<boolean>(parts.length + 1).fill(false);
    if (segment === "**") {
      let reachable = false;
      for (let p = 0; p <= parts.length; p++) {
        reachable = reachable || (row[p] as boolean);
        next[p] = reachable;
      }
    } else {
      for (let p = 0; p < parts.length; p++) {
        if (row[p] && matchSegment(segment, parts[p] as string)) next[p + 1] = true;
      }
    }
    row = next;
  }
  return row[parts.length] as boolean;
}

function ruleApplies(rule: IgnoreRule, rel: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.base && !rel.startsWith(`${rule.base}/`)) return false;
  const local = rule.base ? rel.slice(rule.base.length + 1) : rel;
  if (rule.anchored) return matchSegments(rule.segments, local.split("/"));
  const name = local.slice(local.lastIndexOf("/") + 1);
  return matchSegment(rule.segments[0] as string, name);
}

/** Walking top-down means a re-include cannot revive a file under an ignored folder, as in git. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as IgnoreRule;
    if (ruleApplies(rule, rel, isDir)) return !rule.negated;
  }
  return false;
}

async function loadIgnoreRules(dir: string, base: string): Promise<IgnoreRule[]> {
  const text = await readTextFile(path.join(dir, ".gitignore"), MAX_IGNORE_BYTES);
  if (text === null) return [];
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const rule = parseIgnoreRule(line, base);
    if (rule) rules.push(rule);
    if (rules.length >= MAX_IGNORE_RULES) break;
  }
  return rules;
}

/** Truncation is reported directly, so the cap on unresolved calls cannot hide it. */
function reportUnfinished(out: Collector, file: string, reason: string): void {
  out.unresolved.push({ file, line: 1, column: 1, expression: "", reason });
}

function scanFile(rel: string, type: FileType, source: string, out: Collector): void {
  const docKind = isDocumentationPath(rel);
  const limits: WorkLimits = { deadline: Math.min(performance.now() + out.fileTimeLimitMs, out.scanDeadline), truncated: false };
  if (type === "code") {
    if (!looksMinified(source) && !looksGenerated(source)) scanCode(rel, source, out, docKind, limits);
  } else if (type === "yaml") {
    reportPairs(rel, parseYamlPairs(source), [], "config", out, docKind, limits);
  } else if (type === "toml") {
    reportPairs(rel, parseTomlPairs(source), [], "config", out, docKind, limits);
  } else if (type === "json") {
    if (!looksMinified(source) && !isDataOutputPath(rel)) reportPairs(rel, parseJsonPairs(source, limits), [], "config", out, docKind, limits);
  } else if (type === "env") {
    const pairs = parseEnvPairs(source);
    reportPairs(rel, pairs, envKeySignals(pairs), "env", out, docKind, limits);
  } else if (out.includeDocs) {
    scanProse(rel, source, 1, 1, out);
  }
  if (limits.truncated) reportUnfinished(out, rel, TRUNCATED_REASON);
}

interface WalkState {
  count: number;
}

export interface ScanOptions {
  exclude?: string[];
  /** Also report comments, docstrings, tests and docs, as kind "docs". Off by default. */
  includeDocs?: boolean;
  /** Overrides the time allowed per file, in milliseconds. */
  fileTimeLimitMs?: number;
  /** Overrides the time allowed for the whole scan, in milliseconds. */
  scanTimeLimitMs?: number;
}

async function walkDir(dir: string, rel: string, parentRules: IgnoreRule[], excludeRules: IgnoreRule[], depth: number, state: WalkState, out: Collector): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const rules = [...parentRules, ...(await loadIgnoreRules(dir, rel))];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (state.count >= MAX_FILES || out.findings.length >= MAX_FINDINGS || out.scanStopped) return;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    // Symlinks are never followed: inside the root they are duplicates, outside it they are off limits.
    if (entry.isSymbolicLink()) continue;
    const isDir = entry.isDirectory();
    if (isIgnored([...rules, ...excludeRules], childRel, isDir)) continue;
    const full = path.join(dir, entry.name);
    if (isDir) {
      if (isSkippedDir(entry.name, childRel)) continue;
      if (await hasVirtualenvMarker(full)) continue;
      await walkDir(full, childRel, rules, excludeRules, depth + 1, state, out);
      continue;
    }
    if (!entry.isFile() || LOCKFILES.has(entry.name.toLowerCase()) || entry.name.toLowerCase().endsWith(".lock")) continue;
    const type = fileTypeOf(entry.name);
    if (!type || (isDocumentationPath(childRel) && !out.includeDocs) || (type === "prose" && !out.includeDocs)) continue;
    if (performance.now() > out.scanDeadline) {
      out.scanStopped = true;
      reportUnfinished(out, childRel, SCAN_STOPPED_REASON);
      return;
    }
    const source = await readTextFile(full);
    if (source === null) continue;
    state.count++;
    scanFile(childRel, type, source, out);
  }
}

async function hasVirtualenvMarker(dir: string): Promise<boolean> {
  return (await readTextFile(path.join(dir, "pyvenv.cfg"), 4096)) !== null;
}

function compareFindings(a: ScanFinding | UnresolvedCall, b: ScanFinding | UnresolvedCall): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line || a.column - b.column;
}

export async function scanProject(root: string, snapshot: RegistrySnapshot, opts: ScanOptions = {}): Promise<ScanResult> {
  const base = path.resolve(root);
  let realRoot: string;
  try {
    realRoot = await realpath(base);
  } catch {
    throw new SwapcheckError(`The folder ${base} does not exist. Pass an existing project folder with --cwd.`);
  }
  const out: Collector = {
    index: buildIndex(snapshot),
    findings: [],
    unresolved: [],
    includeDocs: opts.includeDocs === true,
    fileTimeLimitMs: opts.fileTimeLimitMs ?? FILE_TIME_LIMIT_MS,
    scanDeadline: performance.now() + (opts.scanTimeLimitMs ?? SCAN_TIME_LIMIT_MS),
    scanStopped: false,
  };
  const excludeRules = (opts.exclude ?? []).slice(0, MAX_IGNORE_RULES).flatMap((line) => parseIgnoreRule(line, "") ?? []);
  const state: WalkState = { count: 0 };
  await walkDir(realRoot, "", [], excludeRules, 0, state, out);
  out.findings.sort(compareFindings);
  out.unresolved.sort(compareFindings);
  return { root: base, files_scanned: state.count, findings: out.findings, unresolved: out.unresolved };
}
