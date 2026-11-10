import type { ChatMessage, Provider, ToolCall } from "../types.ts";
import {
  asString, maxTokensOf, parseToolArguments, postJson, stripVendorPrefix, toNumber, toRecord, trimBaseUrl,
  type BudgetedRequest, type NormalizedResponse, type ProviderConfig,
} from "./shared.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
// Current API versions reject sampling parameters, so they are dropped and recorded.
const REJECTED = new Set(["temperature", "top_p", "top_k"]);
const JSON_ONLY_INSTRUCTION = "Respond with a single JSON object and nothing else.";

type ContentBlock = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: ContentBlock[] };

function assistantBlocks(message: ChatMessage): ContentBlock[] {
  const blocks: ContentBlock[] = message.content ? [{ type: "text", text: message.content }] : [];
  for (const call of message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
  }
  return blocks;
}

/** Anthropic carries tool results inside user turns, and consecutive same-role turns must merge. */
function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: ContentBlock[]): void => {
    const last = wire[wire.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else wire.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content }]);
    else if (message.role === "assistant") push("assistant", assistantBlocks(message));
    else push("user", [{ type: "text", text: message.content }]);
  }
  return wire;
}

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const baseUrl = trimBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  return {
    name: "anthropic",
    async complete(req: BudgetedRequest): Promise<NormalizedResponse> {
      const dropped: string[] = [];
      const body: Record<string, unknown> = {
        model: stripVendorPrefix(req.model, ["anthropic"]),
        max_tokens: maxTokensOf(req),
        messages: toWireMessages(req.messages),
      };
      for (const [key, value] of Object.entries(req.params ?? {})) {
        if (REJECTED.has(key)) dropped.push(key);
        else if (key === "stop_sequences" || key === "stop") body.stop_sequences = Array.isArray(value) ? value : [value];
        else dropped.push(key);
      }
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content);
      if (req.response_format?.type === "json_schema") {
        body.output_config = { format: { type: "json_schema", schema: req.response_format.schema } };
      } else if (req.response_format?.type === "json_object") {
        // The API has no schema-free JSON mode, so the nearest equivalent is an instruction.
        system.push(JSON_ONLY_INSTRUCTION);
        dropped.push("response_format:json_object (sent as an instruction)");
      }
      if (system.length) body.system = system.join("\n\n");
      if (req.tools?.length) {
        body.tools = req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
      }

      const headers = { "x-api-key": config.apiKey, "anthropic-version": API_VERSION };
      const { json, latencyMs } = await postJson(`${baseUrl}/v1/messages`, headers, body, req, "Anthropic", config);
      const blocks = Array.isArray(json.content) ? json.content.map(toRecord) : [];
      const toolCalls: ToolCall[] = blocks
        .filter((block) => block.type === "tool_use")
        .map((block, index) => parseToolArguments(asString(block.id) ?? `call_${index}`, asString(block.name) ?? "", block.input));
      const usage = toRecord(json.usage);
      const response: NormalizedResponse = {
        text: blocks.filter((block) => block.type === "text").map((block) => asString(block.text) ?? "").join(""),
        tool_calls: toolCalls,
        usage: { input_tokens: toNumber(usage.input_tokens), output_tokens: toNumber(usage.output_tokens) },
        latency_ms: latencyMs,
        served_model: asString(json.model),
        finish_reason: asString(json.stop_reason),
      };
      if (dropped.length) response.dropped_params = dropped;
      return response;
    },
  };
}
