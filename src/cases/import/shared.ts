import type { Check, ChatMessage, ChatRole, ToolCall, ToolDefinition } from "../../types.ts";
import { isRefusal } from "../../testing/checks.ts";
import { SwapcheckError } from "../../util/errors.ts";

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const ROLE_NAMES: Record<string, ChatRole> = {
  system: "system", developer: "system", user: "user", human: "user",
  assistant: "assistant", ai: "assistant", model: "assistant", tool: "tool", function: "tool",
};

export function normalizeRole(role: unknown): ChatRole | undefined {
  return typeof role === "string" ? ROLE_NAMES[role.toLowerCase()] : undefined;
}

/** Text of a message content that may be a string, an array of parts, or an object. */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const object = asObject(part);
      return str(object?.text) ?? str(object?.content) ?? "";
    }).filter((text) => text !== "").join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  raw.forEach((item, index) => {
    const call = asObject(item);
    const fn = asObject(call?.function) ?? call;
    const name = str(fn?.name);
    if (!name) return;
    const args = fn?.arguments ?? fn?.args ?? fn?.input;
    const id = str(call?.id) ?? `call_${index}`;
    if (typeof args === "string") {
      try {
        calls.push({ id, name, arguments: JSON.parse(args) });
      } catch {
        calls.push({ id, name, arguments: null, raw_arguments: args });
      }
    } else {
      calls.push({ id, name, arguments: args ?? {} });
    }
  });
  return calls.length ? calls : undefined;
}

export function normalizeMessage(raw: unknown): ChatMessage | undefined {
  const object = asObject(raw);
  const role = normalizeRole(object?.role);
  if (!object || !role) return undefined;
  const message: ChatMessage = { role, content: textOfContent(object.content) };
  const toolCalls = normalizeToolCalls(object.tool_calls);
  if (toolCalls) message.tool_calls = toolCalls;
  const toolCallId = str(object.tool_call_id);
  if (toolCallId) message.tool_call_id = toolCallId;
  return message;
}

export function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMessage).filter((message): message is ChatMessage => message !== undefined);
}

export function normalizeTools(raw: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: ToolDefinition[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      tools.push({ name: item, parameters: { type: "object" } });
      continue;
    }
    const object = asObject(item);
    const fn = asObject(object?.function) ?? object;
    const name = str(fn?.name);
    if (!name) continue;
    const tool: ToolDefinition = { name, parameters: asObject(fn?.parameters) ?? asObject(fn?.input_schema) ?? { type: "object" } };
    const description = str(fn?.description);
    if (description) tool.description = description;
    tools.push(tool);
  }
  return tools.length ? tools : undefined;
}

/** Trims a trace to the input of the logged decision: nothing after the last user turn is kept. */
export function untilLastUser(messages: ChatMessage[]): ChatMessage[] {
  let last = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") last = index;
  });
  return last >= 0 ? messages.slice(0, last + 1) : [];
}

export interface OutputFacts {
  text: string;
  toolNames: string[];
  finishReason?: string;
}

/** Contract checks inferred from a logged response: what the app relied on, not its exact words. */
export function contractChecksFromOutput(output: OutputFacts | undefined, hasTools: boolean, jsonRequested: boolean): Check[] {
  const checks: Check[] = [];
  const refused = output !== undefined && isRefusal({ text: output.text, finish_reason: output.finishReason });
  if (!refused) checks.push({ type: "no_refusal" });
  let outputIsJson = false;
  if (output?.text) {
    try {
      JSON.parse(output.text);
      outputIsJson = true;
    } catch {
      outputIsJson = false;
    }
  }
  if (jsonRequested || outputIsJson) checks.push({ type: "json_valid" });
  if (hasTools) checks.push({ type: "tool_args_valid" });
  for (const name of new Set(output?.toolNames ?? [])) checks.push({ type: "tool_called", name });
  return checks.length > 0 ? checks : [{ type: "refusal" }];
}

export function parseJsonOrLines(text: string, file: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Not one JSON document, so read it as JSON Lines.
  }
  const records: unknown[] = [];
  trimmed.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new SwapcheckError(`Line ${index + 1} of ${file} is not valid JSON. Expected a JSON document or JSON Lines.`);
    }
  });
  return records;
}

export function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function outputFromMessage(message: ChatMessage | undefined, finishReason?: string): OutputFacts | undefined {
  if (!message) return undefined;
  return { text: message.content, toolNames: (message.tool_calls ?? []).map((call) => call.name), finishReason };
}
