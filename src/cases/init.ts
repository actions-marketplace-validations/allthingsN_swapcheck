import { readFile, stat } from "node:fs/promises";
import type { Check, ScanFinding, ScanResult, SwapcheckConfig, TestCase, ToolDefinition } from "../types.ts";
import { hashOf } from "../util/hash.ts";
import { insideRoot, realInsideRoot } from "../util/paths.ts";
import { loadCases, saveCases } from "./load.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const CONTEXT_LINES = 40;
const MAX_DRAFTS = 200;
const DRAFT_FILE = "generated-drafts";
const MAX_PROMPT_CHARS = 4000;

const JSON_MODE = /response_format|json_object|json_schema|responseSchema|response_mime_type|responseMimeType|output_config/;
const TOOLS_USE = /\btools\s*[=:]|\bfunctions\s*[=:]|tool_choice|functionDeclarations/;
const TOOL_NAME = /["']?name["']?\s*[:=]\s*["']([A-Za-z_][A-Za-z0-9_-]{0,63})["']/g;
const SYSTEM_PROMPT = /["']?(?:system|instructions|system_instruction)["']?\s*[:=]\s*(?:"""([\s\S]{1,4000}?)"""|"([^"\n{}$]{1,4000})"|'([^'\n{}$]{1,4000})')/;
const CONTENT_PROMPT = /["']?(?:content|prompt)["']?\s*[:=]\s*(?:"""([\s\S]{1,4000}?)"""|"([^"\n{}$]{1,4000})"|'([^'\n{}$]{1,4000})')/;

interface SiteFacts {
  usesJson: boolean;
  tools: string[];
  prompt?: string;
  system?: string;
}

async function readContext(root: string, finding: ScanFinding): Promise<string> {
  try {
    const file = insideRoot(root, finding.file);
    if (!(await realInsideRoot(root, file)) || (await stat(file)).size > MAX_SOURCE_BYTES) return "";
    const lines = (await readFile(file, "utf8")).split("\n");
    return lines.slice(Math.max(0, finding.line - 1 - CONTEXT_LINES), finding.line + CONTEXT_LINES).join("\n");
  } catch {
    return "";
  }
}

function firstGroup(match: RegExpExecArray | null): string | undefined {
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.trim() ? value.trim().slice(0, MAX_PROMPT_CHARS) : undefined;
}

function factsFrom(source: string): SiteFacts {
  const tools = TOOLS_USE.test(source) ? [...new Set([...source.matchAll(TOOL_NAME)].map((match) => match[1]!))].slice(0, 8) : [];
  return { usesJson: JSON_MODE.test(source), tools, prompt: firstGroup(CONTENT_PROMPT.exec(source)), system: firstGroup(SYSTEM_PROMPT.exec(source)) };
}

function contractChecks(facts: SiteFacts): Check[] {
  const checks: Check[] = [{ type: "no_refusal" }];
  if (facts.usesJson) checks.push({ type: "json_valid" });
  if (facts.tools.length > 0) checks.push({ type: "tool_args_valid" });
  return checks;
}

function toolDefinition(name: string): ToolDefinition {
  return { name, description: "Tool found near the model call. Replace with the real definition.", parameters: { type: "object" } };
}

function draftFor(finding: ScanFinding, facts: SiteFacts): TestCase {
  const fallback = facts.usesJson
    ? 'Return a JSON object with one key, "status", whose value is "ok".'
    : "Reply with a one-sentence summary of what you can help with.";
  const messages: TestCase["messages"] = [];
  if (facts.system) messages.push({ role: "system", content: facts.system });
  messages.push({ role: "user", content: facts.prompt ?? fallback });
  const draft: TestCase = {
    id: `draft-${hashOf([finding.file, finding.line, finding.model])}`,
    origin: "generated",
    accepted: false,
    messages,
    checks: contractChecks(facts),
    tags: ["contract", `source:${finding.file}:${finding.line}`, `model:${finding.model}`],
  };
  if (facts.tools.length > 0) draft.tools = facts.tools.map(toolDefinition);
  if (facts.usesJson) draft.response_format = { type: "json_object" };
  return draft;
}

function starterDrafts(): TestCase[] {
  const make = (id: string, content: string, checks: Check[], extra: Partial<TestCase> = {}): TestCase => ({
    id, origin: "generated", accepted: false, messages: [{ role: "user", content }], checks, tags: ["contract", "starter"], ...extra,
  });
  return [
    make("starter-json", 'Return a JSON object with the keys "status" and "count". Set status to "ok" and count to 3.', [
      { type: "json_schema", schema: { type: "object", required: ["status", "count"], properties: { status: { type: "string", enum: ["ok"] }, count: { type: "integer" } } } },
    ], { response_format: { type: "json_object" } }),
    make("starter-label", "Classify this message as bug, feature or question. Reply with only the label.\n\nMessage: The app crashes when I log in.", [{ type: "label_in", labels: ["bug", "feature", "question"] }]),
    make("starter-summary", "Summarize in one sentence: Our office will be closed on Monday and will reopen on Tuesday at 9am.", [{ type: "no_refusal" }, { type: "contains", text: "Monday", ignore_case: true }, { type: "max_tokens_output", max: 200 }]),
  ];
}

/** Drafts contract-only cases from the scan. Existing cases are kept and never overwritten. */
export async function initCases(root: string, scan: ScanResult, config: SwapcheckConfig): Promise<{ written: string[]; cases: number; contract_only: boolean }> {
  const existing = await loadCases(root, config.cases);
  const existingIds = new Set(existing.map((testCase) => testCase.id));
  const drafts = new Map<string, TestCase>();
  for (const finding of scan.findings.filter((item) => item.kind === "code").slice(0, MAX_DRAFTS)) {
    const draft = draftFor(finding, factsFrom(await readContext(root, finding)));
    if (!existingIds.has(draft.id)) drafts.set(draft.id, draft);
  }
  if (drafts.size === 0 && existing.length === 0) for (const draft of starterDrafts()) drafts.set(draft.id, draft);

  const hasRealSuite = existing.some((testCase) => testCase.origin !== "generated");
  const fresh = [...drafts.values()];
  if (fresh.length === 0) return { written: [], cases: 0, contract_only: !hasRealSuite };
  const previous = existing.filter((testCase) => testCase.origin === "generated" && !testCase.accepted);
  const written = await saveCases(root, config.cases, DRAFT_FILE, [...previous, ...fresh]);
  return { written: [written], cases: fresh.length, contract_only: !hasRealSuite };
}
