import type { ChatMessage, TestCase } from "../../types.ts";
import { hashOf } from "../../util/hash.ts";
import { asObject, contractChecksFromOutput, maybeParseJson, normalizeRole, normalizeMessage, normalizeTools, num, outputFromMessage, str, textOfContent, untilLastUser, type OutputFacts } from "./shared.ts";

type Attributes = Record<string, unknown>;

function otlpValue(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return value;
  if ("stringValue" in object) return object.stringValue;
  if ("intValue" in object) return Number(object.intValue);
  if ("doubleValue" in object) return object.doubleValue;
  if ("boolValue" in object) return object.boolValue;
  if ("arrayValue" in object) return (asObject(object.arrayValue)?.values as unknown[] | undefined ?? []).map(otlpValue);
  if ("kvlistValue" in object) return attributesOf(asObject(object.kvlistValue)?.values);
  return value;
}

function attributesOf(raw: unknown): Attributes {
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((item) => asObject(item)).filter((item): item is Record<string, unknown> => item !== undefined && typeof item.key === "string").map((item) => [item.key as string, otlpValue(item.value)]));
  }
  return asObject(raw) ?? {};
}

function collectSpans(records: unknown[]): Array<Record<string, unknown>> {
  const spans: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const object = asObject(record);
    if (!object) continue;
    if (Array.isArray(object.resourceSpans)) {
      for (const resource of object.resourceSpans) {
        for (const scope of (asObject(resource)?.scopeSpans as unknown[] | undefined) ?? []) {
          for (const span of (asObject(scope)?.spans as unknown[] | undefined) ?? []) {
            const parsed = asObject(span);
            if (parsed) spans.push(parsed);
          }
        }
      }
    } else if (Array.isArray(object.spans)) {
      spans.push(...collectSpans(object.spans));
    } else {
      spans.push(object);
    }
  }
  return spans;
}

/** The semantic-convention message shape: role plus a list of typed parts. */
function fromSemconvMessage(raw: unknown): ChatMessage | undefined {
  const object = asObject(raw);
  if (!object) return undefined;
  if (!Array.isArray(object.parts)) return normalizeMessage(raw);
  const role = normalizeRole(object.role);
  if (!role) return undefined;
  const parts = object.parts.map((part) => asObject(part)).filter((part): part is Record<string, unknown> => part !== undefined);
  const text = parts.filter((part) => part.type === "text").map((part) => textOfContent(part.content)).join("\n");
  const toolCalls = parts.filter((part) => part.type === "tool_call");
  const response = parts.find((part) => part.type === "tool_call_response");
  const message: ChatMessage = { role: response && role !== "assistant" ? "tool" : role, content: response ? textOfContent(response.response ?? response.result) : text };
  if (response && str(response.id)) message.tool_call_id = response.id as string;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((part, index) => ({ id: str(part.id) ?? `call_${index}`, name: str(part.name) ?? "", arguments: maybeParseJson(part.arguments) ?? {} }));
  }
  return message;
}

function semconvMessages(value: unknown): ChatMessage[] {
  const parsed = maybeParseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(fromSemconvMessage).filter((message): message is ChatMessage => message !== undefined);
}

function indexedMessages(attributes: Attributes, prefix: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < 1000; index++) {
    const role = normalizeRole(attributes[`${prefix}.${index}.role`]);
    const content = attributes[`${prefix}.${index}.content`];
    if (!role && content === undefined) break;
    messages.push({ role: role ?? "assistant", content: textOfContent(maybeParseJson(content)) });
  }
  return messages;
}

const EVENT_ROLES: Record<string, ChatMessage["role"]> = {
  "gen_ai.system.message": "system", "gen_ai.user.message": "user", "gen_ai.assistant.message": "assistant", "gen_ai.tool.message": "tool",
};

function messagesFromEvents(span: Record<string, unknown>): { input: ChatMessage[]; output?: ChatMessage } {
  const input: ChatMessage[] = [];
  let output: ChatMessage | undefined;
  for (const raw of Array.isArray(span.events) ? span.events : []) {
    const event = asObject(raw);
    const name = str(event?.name) ?? "";
    const attributes = attributesOf(event?.attributes);
    if (name === "gen_ai.choice") {
      const message = asObject(maybeParseJson(attributes.message));
      output = { role: "assistant", content: textOfContent(message?.content ?? attributes.content) };
    } else if (EVENT_ROLES[name]) {
      input.push({ role: EVENT_ROLES[name]!, content: textOfContent(maybeParseJson(attributes.content)) });
    }
  }
  return { input, output };
}

function caseFromSpan(span: Record<string, unknown>, position: number): TestCase | undefined {
  const attributes = attributesOf(span.attributes);
  const events = messagesFromEvents(span);
  const system = semconvMessages(attributes["gen_ai.system_instructions"]);
  let input = semconvMessages(attributes["gen_ai.input.messages"]);
  if (input.length === 0) input = indexedMessages(attributes, "gen_ai.prompt");
  if (input.length === 0) input = events.input;
  if (system.length > 0) input = [...system.map((m) => ({ ...m, role: "system" as const })), ...input];
  const messages = untilLastUser(input);
  if (messages.length === 0) return undefined;

  const outputs = semconvMessages(attributes["gen_ai.output.messages"]);
  const fallbackOutput = indexedMessages(attributes, "gen_ai.completion")[0] ?? events.output;
  const finish = Array.isArray(attributes["gen_ai.response.finish_reasons"]) ? str((attributes["gen_ai.response.finish_reasons"] as unknown[])[0]) : undefined;
  const output: OutputFacts | undefined = outputFromMessage(outputs[0] ?? fallbackOutput, finish);

  const tools = normalizeTools(maybeParseJson(attributes["gen_ai.tool.definitions"]));
  const jsonRequested = str(attributes["gen_ai.output.type"]) === "json" || str(attributes["gen_ai.openai.request.response_format"]) === "json_object";
  const checks = contractChecksFromOutput(output, tools !== undefined, jsonRequested);
  const id = str(span.spanId) ?? str(span.span_id) ?? str(asObject(span.context)?.span_id) ?? hashOf([messages, position]);
  const testCase: TestCase = { id: `otel:${id}`, origin: "trace", accepted: true, messages, checks, tags: ["otel"] };
  if (tools) testCase.tools = tools;
  const maxTokens = num(attributes["gen_ai.request.max_tokens"]);
  if (maxTokens !== undefined) testCase.max_tokens = maxTokens;
  const temperature = num(attributes["gen_ai.request.temperature"]);
  if (temperature !== undefined) testCase.params = { temperature };
  return testCase;
}

/** Reads GenAI spans as OTLP JSON or flat span objects, in current or older attribute forms. */
export function parseOtel(records: unknown[]): TestCase[] {
  return collectSpans(records).map(caseFromSpan).filter((testCase): testCase is TestCase => testCase !== undefined);
}
