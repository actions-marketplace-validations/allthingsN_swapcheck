import type { TestCase } from "../../types.ts";
import { hashOf } from "../../util/hash.ts";
import { asObject, contractChecksFromOutput, maybeParseJson, normalizeMessage, normalizeMessages, normalizeTools, num, outputFromMessage, str, untilLastUser } from "./shared.ts";

function messagesOf(record: Record<string, unknown>): unknown {
  const direct = maybeParseJson(record.messages);
  if (Array.isArray(direct)) return direct;
  const proxy = asObject(maybeParseJson(record.proxy_server_request));
  const fromProxy = maybeParseJson(proxy?.messages);
  if (Array.isArray(fromProxy)) return fromProxy;
  const input = maybeParseJson(record.input);
  return Array.isArray(input) ? input : [];
}

function caseFromRecord(raw: unknown, position: number): TestCase | undefined {
  const record = asObject(raw);
  if (!record) return undefined;
  const nested = asObject(maybeParseJson(record.payload));
  const source = nested && !record.messages ? nested : record;
  const messages = untilLastUser(normalizeMessages(messagesOf(source)));
  if (messages.length === 0) return undefined;

  const proxy = asObject(maybeParseJson(source.proxy_server_request));
  const modelParameters = asObject(maybeParseJson(source.model_parameters)) ?? asObject(maybeParseJson(source.optional_params)) ?? asObject(maybeParseJson(source.litellm_params)) ?? proxy ?? {};
  const tools = normalizeTools(maybeParseJson(modelParameters.tools ?? proxy?.tools));
  const responseFormat = asObject(modelParameters.response_format ?? proxy?.response_format);

  const response = asObject(maybeParseJson(source.response));
  const choice = asObject(Array.isArray(response?.choices) ? response.choices[0] : undefined);
  const output = outputFromMessage(normalizeMessage({ role: "assistant", ...asObject(choice?.message) }), str(choice?.finish_reason));

  const jsonRequested = responseFormat !== undefined;
  const id = str(source.request_id) ?? str(source.id) ?? str(source.litellm_call_id) ?? hashOf([messages, position]);
  const testCase: TestCase = { id: `litellm:${id}`, origin: "trace", accepted: true, messages, checks: contractChecksFromOutput(output, tools !== undefined, jsonRequested), tags: ["litellm"] };
  if (tools) testCase.tools = tools;
  if (responseFormat?.type === "json_object") testCase.response_format = { type: "json_object" };
  const maxTokens = num(modelParameters.max_tokens);
  if (maxTokens !== undefined) testCase.max_tokens = maxTokens;
  const temperature = num(modelParameters.temperature);
  if (temperature !== undefined) testCase.params = { temperature };
  return testCase;
}

/** Reads LiteLLM standard logging payloads and spend-log rows. */
export function parseLitellm(records: unknown[]): TestCase[] {
  return records.flatMap((record) => {
    const object = asObject(record);
    return object && Array.isArray(object.data) ? object.data : [record];
  }).map(caseFromRecord).filter((testCase): testCase is TestCase => testCase !== undefined);
}
