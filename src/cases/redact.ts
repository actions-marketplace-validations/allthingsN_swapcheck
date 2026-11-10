import { redactSecrets } from "../util/redact.ts";

export interface RedactionResult<T> {
  value: T;
  count: number;
}

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const PHONE = /(?<![\d.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b|(?<![\d.])\+\d{10,15}\b/g;

function passesLuhn(digits: string): boolean {
  let total = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
    double = !double;
  }
  return total % 10 === 0;
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export function redactText(input: string, env: NodeJS.ProcessEnv = process.env): RedactionResult<string> {
  let count = 0;
  const swap = (pattern: RegExp, replacement: string, accept: (match: string) => boolean = () => true) => (text: string): string =>
    text.replace(pattern, (match) => {
      if (!accept(match)) return match;
      count++;
      return replacement;
    });

  const beforeSecrets = countOf(input, "[REDACTED]");
  let text = redactSecrets(input, env);
  count += countOf(text, "[REDACTED]") - beforeSecrets;
  text = swap(EMAIL, "[EMAIL]")(text);
  text = swap(SSN, "[SSN]")(text);
  text = swap(CARD, "[CARD]", (match) => passesLuhn(match.replace(/[ -]/g, "")))(text);
  text = swap(PHONE, "[PHONE]")(text);
  return { value: text, count };
}

/** Redacts every string in a JSON-like value, including object keys that could hold data. */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): RedactionResult<T> {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const result = redactText(node, env);
      count += result.count;
      return result.value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Array<[string, unknown]> = [];
      const used = new Set<string>();
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        let name = walk(key) as string;
        // Two keys can redact to the same placeholder; neither value may be lost.
        for (let n = 2; used.has(name); n++) name = `${walk(key) as string}#${n}`;
        used.add(name);
        out.push([name, walk(item)]);
      }
      return Object.fromEntries(out);
    }
    return node;
  };
  return { value: walk(value) as T, count };
}
