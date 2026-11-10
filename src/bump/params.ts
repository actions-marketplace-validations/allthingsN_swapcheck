import { innermostPair, langFor, lexRegions, pairBrackets, regionAt, type BracketPair, type Lang, type Region } from "./lex.ts";

export interface TextRange {
  start: number;
  end: number;
}

export interface ParamRemoval extends TextRange {
  param: string;
}

interface Entry {
  key: string | null;
  start: number;
  end: number;
  commaAfter: number | null;
  commaBefore: number | null;
}

function skipSpace(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && /\s/.test(text[i] as string)) i++;
  return i;
}

/** Splits the inside of a bracket pair at its top-level commas, skipping strings, comments and nested brackets. */
function splitEntries(text: string, pair: BracketPair, pairs: BracketPair[], regions: Region[], lang: Lang): Entry[] {
  const nested = new Map(pairs.filter((p) => p.open > pair.open && p.close < pair.close).map((p) => [p.open, p.close]));
  const commas: number[] = [];
  let i = pair.open + 1;
  while (i < pair.close) {
    const region = regionAt(regions, i);
    if (region) {
      i = region.end;
      continue;
    }
    const close = nested.get(i);
    if (close !== undefined) {
      i = close + 1;
      continue;
    }
    if (text[i] === ",") commas.push(i);
    i++;
  }

  const entries: Entry[] = [];
  let from = pair.open + 1;
  for (let c = 0; c <= commas.length; c++) {
    const end = commas[c] ?? pair.close;
    const start = firstCode(text, from, end, regions);
    if (start < end) {
      entries.push({ key: readKey(text, start, end, regions, lang), start, end: lastCode(text, start, end, regions), commaAfter: commas[c] ?? null, commaBefore: commas[c - 1] ?? null });
    }
    from = end + 1;
  }
  return entries;
}

function firstCode(text: string, from: number, to: number, regions: Region[]): number {
  let i = skipSpace(text, from, to);
  for (;;) {
    const region = regionAt(regions, i);
    if (!region || region.kind !== "comment") return i;
    i = skipSpace(text, region.end, to);
  }
}

function lastCode(text: string, start: number, end: number, regions: Region[]): number {
  let i = end;
  for (;;) {
    while (i > start && /\s/.test(text[i - 1] as string)) i--;
    const region = i > start ? regionAt(regions, i - 1) : undefined;
    if (!region || region.kind !== "comment") return i;
    i = region.start;
  }
}

function readKey(text: string, start: number, end: number, regions: Region[], lang: Lang): string | null {
  const region = regionAt(regions, start);
  let keyEnd: number;
  let key: string;
  if (region?.kind === "string") {
    key = text.slice(region.contentStart, region.contentEnd);
    keyEnd = region.end;
  } else {
    const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(start, end));
    if (!match) return null;
    key = match[0];
    keyEnd = start + key.length;
  }
  const after = text[skipSpace(text, keyEnd, end)];
  if (after === ":") return key;
  if (after === "=" && lang === "python" && !region) return key;
  return null;
}

/** Widens a removal to its whole line when nothing else lives there, leaving comments alone. */
function widenToLine(text: string, range: TextRange): TextRange {
  let lineStart = range.start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = range.end;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
  if (text.slice(lineStart, range.start).trim() !== "" || text.slice(range.end, lineEnd).trim() !== "") return range;
  return { start: lineStart, end: Math.min(lineEnd + 1, text.length) };
}

function skipBlanks(text: string, from: number): number {
  let i = from;
  while (text[i] === " " || text[i] === "\t") i++;
  return i;
}

function rangeTouchesComment(regions: Region[], range: TextRange): boolean {
  return regions.some((r) => r.kind === "comment" && r.start < range.end && r.end > range.start);
}

function removalFor(text: string, entry: Entry, regions: Region[]): TextRange {
  if (entry.commaAfter !== null) {
    const range = widenToLine(text, { start: entry.start, end: entry.commaAfter + 1 });
    // With a comment after the comma, drop the gap too so the comment sits at the old indent.
    if (range.start === entry.start && regionAt(regions, skipBlanks(text, range.end))?.kind === "comment") range.end = skipBlanks(text, range.end);
    return range;
  }
  if (entry.commaBefore !== null) {
    const withComma = { start: entry.commaBefore, end: entry.end };
    if (!rangeTouchesComment(regions, withComma)) return widenToLine(text, withComma);
  }
  return widenToLine(text, { start: entry.start, end: entry.end });
}

/** Finds the rejected parameters that sit beside the model in the same call or object. */
export function removalsNear(text: string, file: string, offset: number, params: string[]): ParamRemoval[] {
  const lang = langFor(file);
  if (lang === "other") return [];
  const regions = lexRegions(text, lang);
  const pairs = pairBrackets(text, regions);
  const pair = innermostPair(pairs, offset, lang === "python" ? "({" : "{(", text);
  if (!pair) return [];
  const out: ParamRemoval[] = [];
  for (const entry of splitEntries(text, pair, pairs, regions, lang)) {
    if (entry.key && params.includes(entry.key)) out.push({ param: entry.key, ...removalFor(text, entry, regions) });
  }
  return out;
}

/** Sibling keys in a YAML mapping, found by indentation. Multi-line values are left for a person. */
export function yamlRemovalsNear(text: string, offset: number, params: string[]): { removals: ParamRemoval[]; manual: string[] } {
  const lines = text.split("\n");
  let cursor = 0;
  let modelLine = 0;
  const starts = lines.map((line) => {
    const start = cursor;
    cursor += line.length + 1;
    return start;
  });
  for (let i = 0; i < starts.length; i++) if ((starts[i] as number) <= offset) modelLine = i;
  const indentOf = (line: string): number => (/^\s*(?:-\s+)?/.exec(line)?.[0].length ?? 0);
  const indent = indentOf(lines[modelLine] as string);
  const removals: ParamRemoval[] = [];
  const manual: string[] = [];

  const visit = (i: number): boolean => {
    const line = lines[i] as string;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return true;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) return false;
    if (lineIndent === indent) {
      const key = /^\s*(?:-\s+)?["']?([A-Za-z_][\w-]*)["']?\s*:/.exec(line)?.[1];
      if (key && params.includes(key)) {
        const nextIndent = i + 1 < lines.length ? indentOf(lines[i + 1] as string) : 0;
        const value = line.slice(line.indexOf(":") + 1).trim();
        if (line.trimStart().startsWith("- ") || value === "" || /^[|>]/.test(value) || (nextIndent > indent && (lines[i + 1] as string).trim() !== "")) manual.push(key);
        else removals.push({ param: key, start: starts[i] as number, end: Math.min((starts[i] as number) + line.length + 1, text.length) });
      }
    }
    return true;
  };
  for (let i = modelLine - 1; i >= 0 && visit(i); i--);
  for (let i = modelLine + 1; i < lines.length && visit(i); i++);
  return { removals, manual };
}
