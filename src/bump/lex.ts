/** A deliberately small lexer: bump only needs to know what is a string, what is a comment, and how brackets pair. */

export type Lang = "js" | "python" | "json" | "other";

export interface Region {
  kind: "string" | "comment";
  start: number;
  end: number;
  /** Offsets of the string contents, excluding delimiters. Only meaningful for strings. */
  contentStart: number;
  contentEnd: number;
}

export interface BracketPair {
  open: number;
  close: number;
}

const JS_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

export function langFor(file: string): Lang {
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot).toLowerCase();
  if (JS_EXT.has(ext)) return "js";
  if (ext === ".py" || ext === ".pyi") return "python";
  if (ext === ".json" || ext === ".jsonc") return "json";
  return "other";
}

function endOfLine(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

function scanQuoted(text: string, start: number, quote: string, multiline: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n" && !multiline) return i;
    i++;
  }
  return text.length;
}

/** A template literal runs to its closing backtick, counting nested ${ } so inner backticks do not end it. */
function scanTemplate(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && text[i + 1] === "{") {
      i = scanTemplateHole(text, i + 2);
      continue;
    }
    i++;
  }
  return text.length;
}

function scanTemplateHole(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === "'" || c === '"') i = scanQuoted(text, i, c, false);
    else if (c === "`") i = scanTemplate(text, i);
    else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
  }
  return i;
}

/** Whether a slash at this position starts a regex rather than a division. */
function regexCanStart(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  if (i < 0) return true;
  const c = text[i] as string;
  if ("=([{,;:!&|?+-*%<>~^\n".includes(c)) return true;
  const word = /([A-Za-z_$]+)$/.exec(text.slice(Math.max(0, i - 10), i + 1))?.[1];
  return word === "return" || word === "typeof" || word === "case" || word === "in" || word === "of";
}

function scanRegex(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") return i;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  return text.length;
}

function stringRegion(start: number, end: number, delimiterLength: number): Region {
  return { kind: "string", start, end, contentStart: start + delimiterLength, contentEnd: Math.max(start + delimiterLength, end - delimiterLength) };
}

function commentRegion(start: number, end: number): Region {
  return { kind: "comment", start, end, contentStart: start, contentEnd: end };
}

function lexJs(text: string, allowComments: boolean): Region[] {
  const out: Region[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = scanQuoted(text, i, c, false);
      out.push(stringRegion(i, end, 1));
      i = end;
    } else if (c === "`") {
      const end = scanTemplate(text, i);
      out.push(stringRegion(i, end, 1));
      i = end;
    } else if (allowComments && c === "/" && text[i + 1] === "/") {
      const end = endOfLine(text, i);
      out.push(commentRegion(i, end));
      i = end;
    } else if (allowComments && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      out.push(commentRegion(i, end));
      i = end;
    } else if (allowComments && c === "/" && regexCanStart(text, i)) {
      i = scanRegex(text, i);
    } else {
      i++;
    }
  }
  return out;
}

function lexPython(text: string): Region[] {
  const out: Region[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const end = endOfLine(text, i);
      out.push(commentRegion(i, end));
      i = end;
    } else if (c === "'" || c === '"') {
      if (text.startsWith(c.repeat(3), i)) {
        const close = findTripleClose(text, i + 3, c.repeat(3));
        out.push(stringRegion(i, close, 3));
        i = close;
      } else {
        const end = scanQuoted(text, i, c, false);
        out.push(stringRegion(i, end, 1));
        i = end;
      }
    } else {
      i++;
    }
  }
  return out;
}

function findTripleClose(text: string, from: number, triple: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(triple, i)) return i + 3;
    i++;
  }
  return text.length;
}

/** YAML, TOML, dotenv: quoted scalars are strings and a # at a token boundary starts a comment. */
function lexConfig(text: string): Region[] {
  const out: Region[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1] as string))) {
      const end = endOfLine(text, i);
      out.push(commentRegion(i, end));
      i = end;
    } else if ((c === "'" || c === '"') && (i === 0 || /[\s:=,[{(-]/.test(text[i - 1] as string))) {
      const end = scanQuoted(text, i, c, false);
      out.push(stringRegion(i, end, 1));
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

export function lexRegions(text: string, lang: Lang): Region[] {
  if (lang === "js") return lexJs(text, true);
  if (lang === "json") return lexJs(text, true);
  if (lang === "python") return lexPython(text);
  return lexConfig(text);
}

export function regionAt(regions: Region[], offset: number): Region | undefined {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const region = regions[mid] as Region;
    if (offset < region.start) high = mid - 1;
    else if (offset >= region.end) low = mid + 1;
    else return region;
  }
  return undefined;
}

const CLOSE_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Pairs brackets outside strings and comments. Mismatched brackets are ignored rather than guessed at. */
export function pairBrackets(text: string, regions: Region[]): BracketPair[] {
  const pairs: BracketPair[] = [];
  const stack: Array<{ char: string; at: number }> = [];
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    const region = regions[next];
    if (region && i === region.start) {
      i = region.end - 1;
      next++;
      continue;
    }
    const c = text[i] as string;
    if (c in CLOSE_FOR) stack.push({ char: c, at: i });
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack[stack.length - 1];
      if (top && CLOSE_FOR[top.char] === c) {
        pairs.push({ open: top.at, close: i });
        stack.pop();
      }
    }
  }
  return pairs;
}

export function innermostPair(pairs: BracketPair[], offset: number, chars: string, text: string): BracketPair | undefined {
  let best: BracketPair | undefined;
  for (const pair of pairs) {
    if (pair.open < offset && offset < pair.close && chars.includes(text[pair.open] as string)) {
      if (!best || pair.open > best.open) best = pair;
    }
  }
  return best;
}
