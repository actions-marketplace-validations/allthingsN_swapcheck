import type { Check, TestCase } from "../../types.ts";
import { SwapcheckError } from "../../util/errors.ts";
import { asObject, normalizeMessages, normalizeTools, num, str } from "./shared.ts";

const PARAM_NAMES = ["temperature", "top_p", "seed"];

function stringList(value: unknown, id: string, field: string): string[] {
  if (value === undefined) return [];
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
    throw new SwapcheckError(`The Modelpin scenario ${id} has a ${field} that is not a list of strings.`);
  }
  return items.filter((item) => item !== "");
}

/** Reads one Modelpin scenario. Canned tool results cannot apply to a single-decision replay, so they are noted and left out. */
export function parseModelpinScenario(data: unknown, file: string): TestCase {
  const scenario = asObject(data);
  const id = str(scenario?.id);
  if (!scenario || !id) throw new SwapcheckError(`${file} is not a Modelpin scenario: it has no id.`);
  const input = asObject(scenario.input);
  const messages = normalizeMessages(input?.messages);
  if (!input || messages.length === 0) throw new SwapcheckError(`The Modelpin scenario ${id} has no input.messages.`);
  const assertions = asObject(scenario.assertions);
  const tools = normalizeTools(input.tools);
  const checks: Check[] = [
    ...stringList(assertions?.must_contain, id, "must_contain").map((text): Check => ({ type: "contains", text })),
    ...stringList(assertions?.must_not_contain, id, "must_not_contain").map((text): Check => ({ type: "not_contains", text })),
  ];
  if (tools) checks.push({ type: "tool_args_valid" });
  if (checks.length === 0) checks.push({ type: "no_refusal" }, { type: "meaning" });

  const testCase: TestCase = { id: `modelpin:${id}`, origin: "imported", accepted: true, messages, checks, tags: ["modelpin"] };
  if (tools) testCase.tools = tools;
  if (input.tool_results !== undefined) testCase.tags!.push("tool-results-not-replayed");
  const maxTokens = num(input.max_tokens);
  if (maxTokens !== undefined) testCase.max_tokens = maxTokens;
  const params: Record<string, unknown> = {};
  for (const name of PARAM_NAMES) if (input[name] !== undefined) params[name] = input[name];
  if (Object.keys(params).length > 0) testCase.params = params;
  return testCase;
}
