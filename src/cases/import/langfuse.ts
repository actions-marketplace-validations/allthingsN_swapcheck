import type { ChatMessage, TestCase } from "../../types.ts";
import { hashOf } from "../../util/hash.ts";
import { asObject, contractChecksFromOutput, maybeParseJson, normalizeMessage, normalizeMessages, normalizeTools, num, outputFromMessage, str, textOfContent, untilLastUser, type OutputFacts } from "./shared.ts";

function generations(records: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const object = asObject(record);
    if (!object) continue;
    if (Array.isArray(object.data)) out.push(...generations(object.data));
    else if (Array.isArray(object.observations)) out.push(...generations(object.observations));
    else if (String(object.type ?? "").toUpperCase() === "GENERATION") out.push(object);
  }
  return out;
}

function inputMessages(raw: unknown): ChatMessage[] {
  const input = maybeParseJson(raw);
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return normalizeMessages(input);
  const object = asObject(input);
  if (Array.isArray(object?.messages)) return normalizeMessages(object.messages);
  const single = normalizeMessage(object);
  return single ? [single] : [];
}

function outputFacts(raw: unknown): OutputFacts | undefined {
  const output = maybeParseJson(raw);
  if (output === null || output === undefined) return undefined;
  if (typeof output === "string") return { text: output, toolNames: [] };
  const object = asObject(output);
  if (object && (object.role !== undefined || object.tool_calls !== undefined)) return outputFromMessage(normalizeMessage({ role: "assistant", ...object }));
  return { text: textOfContent(output), toolNames: [] };
}

function caseFromGeneration(generation: Record<string, unknown>, position: number): TestCase | undefined {
  const messages = untilLastUser(inputMessages(generation.input));
  if (messages.length === 0) return undefined;
  const parameters = asObject(maybeParseJson(generation.modelParameters)) ?? {};
  const inputObject = asObject(maybeParseJson(generation.input));
  const tools = normalizeTools(inputObject?.tools ?? parameters.tools);
  const id = str(generation.id) ?? hashOf([messages, position]);
  const testCase: TestCase = {
    id: `langfuse:${id}`, origin: "trace", accepted: true, messages,
    checks: contractChecksFromOutput(outputFacts(generation.output), tools !== undefined, parameters.response_format !== undefined),
    tags: ["langfuse"],
  };
  if (tools) testCase.tools = tools;
  const maxTokens = num(parameters.max_tokens) ?? num(parameters.maxTokens);
  if (maxTokens !== undefined) testCase.max_tokens = maxTokens;
  const temperature = num(parameters.temperature);
  if (temperature !== undefined) testCase.params = { temperature };
  return testCase;
}

/** Reads GENERATION observations from a Langfuse export, flat or nested under traces. */
export function parseLangfuse(records: unknown[]): TestCase[] {
  return generations(records).map(caseFromGeneration).filter((testCase): testCase is TestCase => testCase !== undefined);
}
