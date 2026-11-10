/**
 * Hand-written lexers for TS/JS and Python. They separate code strings from
 * comments, docstrings and interpolated text, and never throw on malformed input.
 */

export type TokenKind = "string" | "template" | "fstring" | "docstring" | "comment" | "ident" | "number" | "regex" | "punct";

export interface Token {
  kind: TokenKind;
  /** Decoded text for string-like tokens; static text only for templates and f-strings. */
  value: string;
  /** 1-based position. For string-like tokens, the first character inside the quotes. */
  line: number;
  column: number;
  start: number;
  end: number;
  /** Template or f-string containing at least one interpolation. */
  dynamic?: boolean;
  /** Static text between interpolations. */
  parts?: string[];
  unterminated?: boolean;
}

export interface LexResult {
  tokens: Token[];
  truncated: boolean;
}

export interface LexLimits {
  /** performance.now() value after which lexing stops and the result is marked truncated. */
  deadline?: number;
}

export const OPEN_TEMPLATE_EXPR = "${";
export const OPEN_JSX = "<jsx";
export const CLOSE_JSX = "jsx>";

const MAX_TOKENS = 500_000;
const MAX_NESTING = 512;

function isAsciiIdStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isIdStartAt(src: string, i: number): boolean {
  const c = src.charCodeAt(i);
  if (c < 128) return isAsciiIdStart(c);
  return /\p{ID_Start}/u.test(String.fromCodePoint(src.codePointAt(i) ?? 0));
}

function isIdPartCode(cp: number): boolean {
  if (cp < 128) return isAsciiIdStart(cp) || isDigit(cp);
  return /\p{ID_Continue}/u.test(String.fromCodePoint(cp));
}

function isNewline(c: number): boolean {
  return c === 10 || c === 13;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

function hexAt(raw: string, from: number, length: number): number | null {
  const text = raw.slice(from, from + length);
  return text.length === length && /^[0-9a-fA-F]+$/.test(text) ? Number.parseInt(text, 16) : null;
}

function fromCode(code: number | null): string {
  return code !== null && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Decodes the escapes that can occur in a model ID. Unknown escapes keep their character. */
function decodeEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "\n") continue;
    if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
    } else if (next === "x") {
      out += fromCode(hexAt(raw, i + 1, 2));
      i += 2;
    } else if (next === "u" && raw[i + 1] === "{") {
      const close = raw.indexOf("}", i);
      if (close < 0 || close - i > 10) continue;
      out += fromCode(hexAt(raw, i + 2, close - i - 2));
      i = close;
    } else if (next === "u") {
      out += fromCode(hexAt(raw, i + 1, 4));
      i += 4;
    } else {
      out += next;
    }
  }
  return out;
}

class Scanner {
  readonly src: string;
  readonly n: number;
  readonly tokens: Token[] = [];
  readonly lineStarts: number[] = [0];
  i = 0;
  truncated = false;
  readonly deadline: number | undefined;
  steps = 0;

  constructor(source: string, limits: LexLimits = {}) {
    this.src = source;
    this.n = source.length;
    this.deadline = limits.deadline;
    if (source.charCodeAt(0) === 0xfeff) {
      this.i = 1;
      this.lineStarts[0] = 1;
    }
    for (let p = 0; p < this.n; p++) {
      const c = source.charCodeAt(p);
      if (c === 10 || (c === 13 && source.charCodeAt(p + 1) !== 10)) this.lineStarts.push(p + 1);
    }
  }

  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.lineStarts[lo] ?? 0) + 1 };
  }

  full(): boolean {
    const late = this.deadline !== undefined && (++this.steps & 1023) === 0 && performance.now() > this.deadline;
    if (this.tokens.length < MAX_TOKENS && !late) return false;
    this.truncated = true;
    return true;
  }

  make(kind: TokenKind, value: string, start: number, end: number, contentStart: number = start): Token {
    const { line, column } = this.position(contentStart);
    const token: Token = { kind, value, line, column, start, end };
    this.tokens.push(token);
    return token;
  }

  readIdentEnd(from: number): number {
    let p = from;
    while (p < this.n) {
      const cp = this.src.codePointAt(p) ?? 0;
      if (!isIdPartCode(cp)) break;
      p += cp > 0xffff ? 2 : 1;
    }
    return p;
  }

  readNumberEnd(from: number): number {
    let p = from;
    while (p < this.n) {
      const c = this.src.charCodeAt(p);
      const isExponentSign = (c === 43 || c === 45) && /[eE]/.test(this.src[p - 1] ?? "") && !/^0[xXbBoO]/.test(this.src.slice(from, from + 2));
      if (isDigit(c) || isAsciiIdStart(c) || c === 46 || isExponentSign) p++;
      else break;
    }
    return p;
  }
}

type JsMode =
  | { t: "code"; braces: number; closes: boolean }
  | { t: "template"; token: Token; parts: string[]; partStart: number }
  | { t: "jsxTag" }
  | { t: "jsxChildren" };

const JS_NON_VALUE_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

const JS_PUNCT = [
  ">>>=",
  "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];

class JsLexer extends Scanner {
  readonly jsx: boolean;
  readonly stack: JsMode[] = [{ t: "code", braces: 0, closes: false }];
  /** True when the previous token ends a value, so `/` is division and `<` is less-than. */
  prevValueEnd = false;
  /** Offsets before this already failed as a regex on their line, so they are not rescanned. */
  noRegexBefore = 0;

  constructor(source: string, jsx: boolean, limits: LexLimits = {}) {
    super(source, limits);
    this.jsx = jsx;
    if (this.src.startsWith("#!", this.i)) this.skipLine();
  }

  skipLine(): void {
    while (this.i < this.n && !isNewline(this.src.charCodeAt(this.i))) this.i++;
  }

  run(): LexResult {
    while (this.i < this.n && !this.full()) {
      const mode = this.stack[this.stack.length - 1];
      if (!mode) break;
      if (mode.t === "code") this.stepCode(mode);
      else if (mode.t === "template") this.stepTemplate(mode);
      else if (mode.t === "jsxTag") this.stepJsxTag();
      else this.stepJsxChildren();
    }
    for (const mode of this.stack) {
      // Only the innermost has text pending. Decoding the tail for every level is memory-exhausting when nested.
      if (mode.t === "template") this.finishTemplate(mode, this.n, true, mode === this.stack[this.stack.length - 1] ? this.n : mode.partStart);
    }
    return { tokens: this.tokens, truncated: this.truncated };
  }

  push(mode: JsMode): boolean {
    if (this.stack.length >= MAX_NESTING) {
      this.truncated = true;
      this.i = this.n;
      return false;
    }
    this.stack.push(mode);
    return true;
  }

  emit(kind: TokenKind, value: string, start: number, end: number, contentStart: number = start): Token {
    const token = this.make(kind, value, start, end, contentStart);
    if (kind === "punct") this.prevValueEnd = value === ")" || value === "]" || value === "}" || value === CLOSE_JSX;
    else if (kind === "ident") this.prevValueEnd = !JS_NON_VALUE_KEYWORDS.has(value);
    else if (kind !== "comment") this.prevValueEnd = true;
    return token;
  }

  stepCode(mode: Extract<JsMode, { t: "code" }>): void {
    const { src } = this;
    const c = src.charCodeAt(this.i);
    if (isSpace(c)) {
      this.i++;
      return;
    }
    const start = this.i;
    if (c === 47 && src[start + 1] === "/") {
      this.skipLine();
      this.emit("comment", src.slice(start + 2, this.i), start, this.i, start + 2);
      return;
    }
    if (c === 47 && src[start + 1] === "*") return this.readBlockComment();
    if (c === 34 || c === 39) return this.readString(c);
    if (c === 96) return this.openTemplate();
    if (isIdStartAt(src, start)) {
      this.i = this.readIdentEnd(start);
      this.emit("ident", src.slice(start, this.i), start, this.i);
      return;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(start + 1)))) {
      this.i = this.readNumberEnd(start);
      this.emit("number", src.slice(start, this.i), start, this.i);
      return;
    }
    if (c === 47 && this.regexAllowed(start) && this.tryRegex()) return;
    if (c === 60 && this.jsx && !this.prevValueEnd && this.startsJsxElement(start)) return this.openJsxTag();
    if (c === 123) {
      mode.braces++;
    } else if (c === 125) {
      if (mode.braces === 0 && mode.closes) {
        this.i++;
        this.stack.pop();
        const resumed = this.stack[this.stack.length - 1];
        if (resumed?.t === "template") resumed.partStart = this.i;
        this.emit("punct", "}", start, this.i);
        return;
      }
      if (mode.braces > 0) mode.braces--;
    }
    this.readPunct();
  }

  regexAllowed(at: number): boolean {
    if (!this.prevValueEnd) return true;
    const last = this.tokens[this.tokens.length - 1];
    if (last?.kind !== "punct" || last.value !== "}") return false;
    // `}` then `/` is a regex only when it begins a new statement line.
    let p = at - 1;
    while (p >= 0 && (this.src[p] === " " || this.src[p] === "\t")) p--;
    return p < 0 || isNewline(this.src.charCodeAt(p));
  }

  readPunct(): void {
    const start = this.i;
    const { src } = this;
    for (const op of JS_PUNCT) {
      if (!src.startsWith(op, start)) continue;
      if (op === "?." && isDigit(src.charCodeAt(start + 2))) continue;
      this.i += op.length;
      this.emit("punct", op, start, this.i);
      return;
    }
    this.i++;
    this.emit("punct", src[start] ?? "", start, this.i);
  }

  readBlockComment(): void {
    const start = this.i;
    const close = this.src.indexOf("*/", start + 2);
    const contentEnd = close < 0 ? this.n : close;
    this.i = close < 0 ? this.n : close + 2;
    const token = this.emit("comment", this.src.slice(start + 2, contentEnd), start, this.i, start + 2);
    if (close < 0) token.unterminated = true;
  }

  readString(quote: number): void {
    const start = this.i;
    const { src, n } = this;
    let p = start + 1;
    let closed = false;
    while (p < n) {
      const c = src.charCodeAt(p);
      if (c === 92) {
        p += src[p + 1] === "\r" && src[p + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (c === quote) {
        closed = true;
        break;
      }
      if (isNewline(c)) break;
      p++;
    }
    const contentEnd = Math.min(p, n);
    this.i = closed ? p + 1 : contentEnd;
    const token = this.emit("string", decodeEscapes(src.slice(start + 1, contentEnd)), start, this.i, start + 1);
    if (!closed) token.unterminated = true;
  }

  openTemplate(): void {
    const start = this.i;
    this.i++;
    // Emitted now so it precedes the tokens of its own interpolations.
    const token = this.emit("template", "", start, start + 1, start + 1);
    this.push({ t: "template", token, parts: [], partStart: this.i });
  }

  closeTemplatePart(mode: Extract<JsMode, { t: "template" }>, end: number): void {
    mode.parts.push(decodeEscapes(this.src.slice(mode.partStart, end)));
  }

  finishTemplate(mode: Extract<JsMode, { t: "template" }>, end: number, unterminated: boolean, partEnd: number = end): void {
    this.closeTemplatePart(mode, Math.min(partEnd, this.n));
    mode.token.parts = mode.parts;
    mode.token.value = mode.parts.join("");
    mode.token.dynamic = mode.parts.length > 1;
    mode.token.end = Math.min(end + 1, this.n);
    if (unterminated) mode.token.unterminated = true;
  }

  stepTemplate(mode: Extract<JsMode, { t: "template" }>): void {
    const { src, n } = this;
    while (this.i < n) {
      const c = src.charCodeAt(this.i);
      if (c === 92) {
        this.i += 2;
      } else if (c === 96) {
        this.finishTemplate(mode, this.i, false);
        this.i++;
        this.stack.pop();
        this.prevValueEnd = true;
        return;
      } else if (c === 36 && src[this.i + 1] === "{") {
        this.closeTemplatePart(mode, this.i);
        const start = this.i;
        this.i += 2;
        this.emit("punct", OPEN_TEMPLATE_EXPR, start, this.i);
        this.push({ t: "code", braces: 0, closes: true });
        return;
      } else {
        this.i++;
      }
    }
  }

  tryRegex(): boolean {
    const start = this.i;
    if (start < this.noRegexBefore) return false;
    const { src, n } = this;
    let p = start + 1;
    let inClass = false;
    for (; p < n; p++) {
      const c = src.charCodeAt(p);
      if (isNewline(c)) {
        this.noRegexBefore = p;
        return false;
      }
      if (c === 92) p++;
      else if (c === 91) inClass = true;
      else if (c === 93) inClass = false;
      else if (c === 47 && !inClass) break;
    }
    if (p >= n) {
      this.noRegexBefore = n;
      return false;
    }
    const end = this.readIdentEnd(p + 1);
    this.i = end;
    this.emit("regex", src.slice(start, end), start, end);
    return true;
  }

  startsJsxElement(at: number): boolean {
    const { src } = this;
    if (src[at + 1] === ">") return true;
    if (!isIdStartAt(src, at + 1)) return false;
    let p = this.readJsxNameEnd(at + 1);
    while (p < this.n && isSpace(src.charCodeAt(p))) p++;
    // `<T,>(x) => x` and `<T extends U>(x) => x` are generic arrows.
    return src[p] !== "," && !(src.startsWith("extends", p) && !isIdPartCode(src.codePointAt(p + 7) ?? 0));
  }

  readJsxNameEnd(from: number): number {
    let p = from;
    while (p < this.n) {
      const cp = this.src.codePointAt(p) ?? 0;
      if (!isIdPartCode(cp) && cp !== 45 && cp !== 46 && cp !== 58) break;
      p += cp > 0xffff ? 2 : 1;
    }
    return p;
  }

  openJsxTag(): void {
    const start = this.i;
    this.i++;
    this.emit("punct", OPEN_JSX, start, this.i);
    if (this.src[this.i] !== ">") {
      const nameStart = this.i;
      this.i = this.readJsxNameEnd(nameStart);
      this.emit("ident", this.src.slice(nameStart, this.i), nameStart, this.i);
    }
    this.push({ t: "jsxTag" });
  }

  stepJsxTag(): void {
    const { src } = this;
    const c = src.charCodeAt(this.i);
    if (isSpace(c)) {
      this.i++;
      return;
    }
    const start = this.i;
    if (c === 47 && src[start + 1] === ">") {
      this.i += 2;
      this.stack.pop();
      this.emit("punct", CLOSE_JSX, start, this.i);
      return;
    }
    if (c === 62) {
      this.i++;
      this.stack.pop();
      this.emit("punct", CLOSE_JSX, start, this.i);
      this.push({ t: "jsxChildren" });
      return;
    }
    if (c === 47 && src[start + 1] === "*") return this.readBlockComment();
    if (c === 123) {
      this.i++;
      this.emit("punct", "{", start, this.i);
      this.push({ t: "code", braces: 0, closes: true });
      return;
    }
    if (c === 34 || c === 39) return this.readJsxAttrString(c);
    if (c === 61) {
      this.i++;
      this.emit("punct", "=", start, this.i);
      return;
    }
    if (isIdStartAt(src, start)) {
      this.i = this.readJsxNameEnd(start);
      this.emit("ident", src.slice(start, this.i), start, this.i);
      return;
    }
    this.i++;
  }

  /** JSX attribute strings have no escapes and may span lines. */
  readJsxAttrString(quote: number): void {
    const start = this.i;
    const close = this.src.indexOf(String.fromCharCode(quote), start + 1);
    const contentEnd = close < 0 ? this.n : close;
    this.i = close < 0 ? this.n : close + 1;
    const token = this.emit("string", this.src.slice(start + 1, contentEnd), start, this.i, start + 1);
    if (close < 0) token.unterminated = true;
  }

  stepJsxChildren(): void {
    const { src, n } = this;
    while (this.i < n) {
      const c = src.charCodeAt(this.i);
      if (c === 123) {
        const start = this.i;
        this.i++;
        this.emit("punct", "{", start, this.i);
        this.push({ t: "code", braces: 0, closes: true });
        return;
      }
      if (c === 60) {
        if (src[this.i + 1] === "/") {
          const close = src.indexOf(">", this.i);
          this.i = close < 0 ? n : close + 1;
          this.stack.pop();
          this.prevValueEnd = true;
          return;
        }
        if (src[this.i + 1] === ">" || isIdStartAt(src, this.i + 1)) return this.openJsxTag();
      }
      this.i++;
    }
  }
}

/** Lexes TS/JS. Set `jsx` for .js, .jsx and .tsx; in .ts a `<` is never an element. */
export function lexJs(source: string, opts: { jsx?: boolean } & LexLimits = {}): LexResult {
  return new JsLexer(source, opts.jsx === true, opts).run();
}

type PyMode =
  | { t: "code"; depth: number; closes: boolean }
  | { t: "fstring"; token: Token; parts: string[]; partStart: number; quote: string; triple: boolean; raw: boolean }
  | { t: "spec" };

const PY_STRING_PREFIXES = new Set(["r", "u", "b", "f", "t", "rb", "br", "fr", "rf", "tr", "rt"]);
const PY_PUNCT = ["**=", "//=", ">>=", "<<=", "...", "==", "!=", "<=", ">=", "->", ":=", "**", "//", ">>", "<<", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@="];

class PyLexer extends Scanner {
  readonly stack: PyMode[] = [{ t: "code", depth: 0, closes: false }];
  /** True until the first token of a logical line, which is how docstrings are recognised. */
  logicalStart = true;

  run(): LexResult {
    while (this.i < this.n && !this.full()) {
      const mode = this.stack[this.stack.length - 1];
      if (!mode) break;
      if (mode.t === "code") this.stepCode(mode);
      else if (mode.t === "fstring") this.stepFString(mode);
      else this.stepSpec();
    }
    for (const mode of this.stack) {
      if (mode.t === "fstring") this.finishFString(mode, this.n, true, mode === this.stack[this.stack.length - 1] ? this.n : mode.partStart);
    }
    return { tokens: this.tokens, truncated: this.truncated };
  }

  push(mode: PyMode): void {
    if (this.stack.length >= MAX_NESTING) {
      this.truncated = true;
      this.i = this.n;
      return;
    }
    this.stack.push(mode);
  }

  emit(kind: TokenKind, value: string, start: number, end: number, contentStart: number = start): Token {
    if (kind !== "comment") this.logicalStart = false;
    return this.make(kind, value, start, end, contentStart);
  }

  atStatementStart(): boolean {
    const top = this.stack[0];
    return this.logicalStart && this.stack.length === 1 && top?.t === "code" && top.depth === 0;
  }

  stepCode(mode: Extract<PyMode, { t: "code" }>): void {
    const { src } = this;
    const c = src.charCodeAt(this.i);
    if (isNewline(c)) {
      this.i++;
      if (this.stack.length === 1 && mode.depth === 0) this.logicalStart = true;
      return;
    }
    if (isSpace(c)) {
      this.i++;
      return;
    }
    if (c === 92 && isNewline(src.charCodeAt(this.i + 1))) {
      this.i += src[this.i + 1] === "\r" && src[this.i + 2] === "\n" ? 3 : 2;
      return;
    }
    const start = this.i;
    if (c === 35) {
      while (this.i < this.n && !isNewline(src.charCodeAt(this.i))) this.i++;
      this.emit("comment", src.slice(start + 1, this.i), start, this.i, start + 1);
      return;
    }
    if (c === 34 || c === 39) return this.readStringLiteral("", start);
    if (isIdStartAt(src, start)) {
      const end = this.readIdentEnd(start);
      const word = src.slice(start, end);
      const next = src[end];
      if ((next === '"' || next === "'") && PY_STRING_PREFIXES.has(word.toLowerCase())) {
        this.i = end;
        return this.readStringLiteral(word.toLowerCase(), start);
      }
      this.i = end;
      this.emit("ident", word, start, end);
      return;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(start + 1)))) {
      this.i = this.readNumberEnd(start);
      this.emit("number", src.slice(start, this.i), start, this.i);
      return;
    }
    if (c === 40 || c === 91 || c === 123) {
      mode.depth++;
    } else if (c === 41 || c === 93 || c === 125) {
      if (c === 125 && mode.closes && mode.depth === 0) {
        this.closeReplacementField();
        return;
      }
      if (mode.depth > 0) mode.depth--;
    } else if (c === 58 && mode.closes && mode.depth === 0) {
      // First top-level colon in a replacement field begins the format spec.
      this.i++;
      this.stack.pop();
      this.push({ t: "spec" });
      return;
    }
    this.readPunct();
  }

  readPunct(): void {
    const start = this.i;
    for (const op of PY_PUNCT) {
      if (this.src.startsWith(op, start)) {
        this.i += op.length;
        this.emit("punct", op, start, this.i);
        return;
      }
    }
    this.i++;
    this.emit("punct", this.src[start] ?? "", start, this.i);
  }

  readStringLiteral(prefix: string, start: number): void {
    const { src } = this;
    const quote = src[this.i] ?? '"';
    const triple = src.startsWith(quote.repeat(3), this.i);
    const raw = prefix.includes("r");
    const interpolated = prefix.includes("f") || prefix.includes("t");
    const statementStart = this.atStatementStart();
    this.i += triple ? 3 : 1;
    if (interpolated) {
      const token = this.emit("fstring", "", start, this.i, this.i);
      this.push({ t: "fstring", token, parts: [], partStart: this.i, quote, triple, raw });
      return;
    }
    this.readPlainBody(start, quote, triple, raw, statementStart, prefix.includes("b"));
  }

  readPlainBody(start: number, quote: string, triple: boolean, raw: boolean, statementStart: boolean, bytes: boolean): void {
    const { src, n } = this;
    const contentStart = this.i;
    const closer = triple ? quote.repeat(3) : quote;
    let p = contentStart;
    let closed = false;
    while (p < n) {
      if (src.charCodeAt(p) === 92) {
        p += 2;
        continue;
      }
      if (src.startsWith(closer, p)) {
        closed = true;
        break;
      }
      if (!triple && isNewline(src.charCodeAt(p))) break;
      p++;
    }
    const contentEnd = Math.min(p, n);
    this.i = closed ? p + closer.length : contentEnd;
    const body = src.slice(contentStart, contentEnd);
    const isDoc = statementStart && !bytes && this.lineEndsAfterString();
    const token = this.emit(isDoc ? "docstring" : "string", raw ? body : decodeEscapes(body), start, this.i, contentStart);
    if (!closed) token.unterminated = true;
  }

  lineEndsAfterString(): boolean {
    let p = this.i;
    while (p < this.n && (this.src[p] === " " || this.src[p] === "\t")) p++;
    const c = this.src.charCodeAt(p);
    return p >= this.n || isNewline(c) || c === 35 || c === 59;
  }

  closeFPart(mode: Extract<PyMode, { t: "fstring" }>, end: number): void {
    const text = this.src.slice(mode.partStart, end).replaceAll("{{", "{").replaceAll("}}", "}");
    mode.parts.push(mode.raw ? text : decodeEscapes(text));
  }

  finishFString(mode: Extract<PyMode, { t: "fstring" }>, end: number, unterminated: boolean, partEnd: number = end): void {
    this.closeFPart(mode, Math.min(partEnd, this.n));
    mode.token.parts = mode.parts;
    mode.token.value = mode.parts.join("");
    mode.token.dynamic = mode.parts.length > 1;
    mode.token.end = Math.min(end + (mode.triple ? 3 : 1), this.n);
    if (unterminated) mode.token.unterminated = true;
  }

  stepFString(mode: Extract<PyMode, { t: "fstring" }>): void {
    const { src, n } = this;
    const closer = mode.triple ? mode.quote.repeat(3) : mode.quote;
    while (this.i < n) {
      const ch = src[this.i];
      const next = src[this.i + 1];
      if (ch === "\\") {
        this.i += next === "{" || next === "}" ? 1 : 2;
      } else if ((ch === "{" && next === "{") || (ch === "}" && next === "}")) {
        this.i += 2;
      } else if (ch === "{") {
        this.closeFPart(mode, this.i);
        const start = this.i;
        this.i++;
        this.emit("punct", OPEN_TEMPLATE_EXPR, start, this.i);
        this.push({ t: "code", depth: 0, closes: true });
        return;
      } else if (src.startsWith(closer, this.i)) {
        this.finishFString(mode, this.i, false);
        this.i += closer.length;
        this.stack.pop();
        return;
      } else if (!mode.triple && isNewline(src.charCodeAt(this.i))) {
        this.finishFString(mode, this.i, true);
        this.stack.pop();
        return;
      } else {
        this.i++;
      }
    }
  }

  /** Pops a `{...}` field; the f-string's next static part begins just after it. */
  closeReplacementField(): void {
    const start = this.i;
    this.i++;
    this.stack.pop();
    const resumed = this.stack[this.stack.length - 1];
    if (resumed?.t === "fstring") resumed.partStart = this.i;
    this.emit("punct", "}", start, this.i);
  }

  stepSpec(): void {
    const { src, n } = this;
    while (this.i < n) {
      const ch = src[this.i];
      if (ch === "}") {
        this.closeReplacementField();
        return;
      }
      if (ch === "{") {
        const start = this.i;
        this.i++;
        this.emit("punct", OPEN_TEMPLATE_EXPR, start, this.i);
        this.push({ t: "code", depth: 0, closes: true });
        return;
      }
      this.i++;
    }
  }
}

export function lexPython(source: string, limits: LexLimits = {}): LexResult {
  return new PyLexer(source, limits).run();
}
