import { escapeMarkdown } from "../report/markdown.ts";
import { redactSecrets } from "../util/redact.ts";

export interface Styler {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
}

const paint = (code: number, text: string): string => `\u001b[${code}m${text}\u001b[0m`;

const PLAIN: Styler = { bold: (t) => t, dim: (t) => t, red: (t) => t, yellow: (t) => t, green: (t) => t };
const COLOR: Styler = {
  bold: (t) => paint(1, t),
  dim: (t) => paint(2, t),
  red: (t) => paint(31, t),
  yellow: (t) => paint(33, t),
  green: (t) => paint(32, t),
};

export function wantsColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv, noColorFlag: boolean): boolean {
  if (noColorFlag || !stream.isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return env.TERM !== "dumb";
}

export function stylerFor(color: boolean): Styler {
  return color ? COLOR : PLAIN;
}

/** Strips control characters so text from a scanned repo or the registry cannot drive the terminal. */
export function clean(text: unknown, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  const out = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

export function emit(text: string): void {
  process.stdout.write(redactSecrets(text.endsWith("\n") ? text : `${text}\n`));
}

export function note(text: string): void {
  process.stderr.write(redactSecrets(text.endsWith("\n") ? text : `${text}\n`));
}

export function emitJson(value: unknown): void {
  emit(JSON.stringify(value, null, 2));
}

/** Pads columns to the widest visible cell. Cells must be unstyled; style whole rows afterwards. */
export function alignRows(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat((widths[i] as number) - [...cell].length + gap)))
      .join("")
      .trimEnd(),
  );
}

export function usd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.0001) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function pct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  const rounded = Math.round(fraction * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Escapes text for a Markdown table cell or paragraph, including mentions and raw HTML. */
export function mdEscape(text: unknown, maxLength = 500): string {
  return escapeMarkdown(clean(text, maxLength), maxLength);
}

/** A Markdown link only for plain http(s) URLs. Anything else is shown as escaped text. */
export function mdLink(label: string, url: string | undefined): string {
  if (!url) return mdEscape(label);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return mdEscape(url);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return mdEscape(url);
  const safe = parsed.href.replace(/[()\\\s<>"']/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `[${mdEscape(label)}](${safe})`;
}
