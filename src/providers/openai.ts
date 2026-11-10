import type { ChatMessage, Provider, ToolCall } from "../types.ts";
import {
  asString, maxTokensOf, parseToolArguments, postJson, stringifyToolArguments, stripVendorPrefix, toNumber, toRecord, trimBaseUrl,
  type BudgetedRequest, type NormalizedResponse, type ProviderConfig,
} from "./shared.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const PASSTHROUGH = ["temperature", "top_p", "seed", "stop", "frequency_penalty", "presence_penalty", "reasoning_effort"];
const SAMPLING = new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty"]);

export interface OpenAIConfig extends ProviderConfig {
  label?: string;
  /** Keep the "vendor/model" id, as routers such as OpenRouter expect. */
  keepVendorPrefix?: boolean;
}

// These models reject max_tokens and sampling parameters on OpenAI's own API.
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.tool_call_id ?? "", content: message.content };
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: stringifyToolArguments(call) } })),
    };
  }
  return { role: message.role, content: message.content };
}

function toWireResponseFormat(format: NonNullable<BudgetedRequest["response_format"]>): Record<string, unknown> {
  if (format.type === "json_object") return { type: "json_object" };
  return { type: "json_schema", json_schema: { name: format.name ?? "response", schema: format.schema } };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => asString(toRecord(part).text) ?? "").join("");
}

function toolCallsOf(message: Record<string, unknown>): ToolCall[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((raw, index) => {
    const call = toRecord(raw);
    const fn = toRecord(call.function);
    return parseToolArguments(asString(call.id) ?? `call_${index}`, asString(fn.name) ?? "", fn.arguments);
  });
}

export function createOpenAIProvider(config: OpenAIConfig): Provider {
  const baseUrl = trimBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  const isOpenAI = baseUrl === DEFAULT_BASE_URL;
  const label = config.label ?? "OpenAI";
  return {
    name: label.toLowerCase(),
    async complete(req: BudgetedRequest): Promise<NormalizedResponse> {
      const model = config.keepVendorPrefix ? req.model : stripVendorPrefix(req.model, ["openai"]);
      const reasoning = isOpenAI && isReasoningModel(model);
      const dropped: string[] = [];
      const params: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(req.params ?? {})) {
        if (!PASSTHROUGH.includes(key) || (reasoning && SAMPLING.has(key))) dropped.push(key);
        else params[key] = value;
      }
      const body: Record<string, unknown> = { ...params, model, messages: req.messages.map(toWireMessage) };
      body[isOpenAI ? "max_completion_tokens" : "max_tokens"] = maxTokensOf(req);
      if (req.tools?.length) {
        body.tools = req.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      }
      if (req.response_format) body.response_format = toWireResponseFormat(req.response_format);

      const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
      const { json, latencyMs } = await postJson(`${baseUrl}/chat/completions`, headers, body, req, label, config);
      const choice = toRecord(Array.isArray(json.choices) ? json.choices[0] : undefined);
      const message = toRecord(choice.message);
      const usage = toRecord(json.usage);
      const response: NormalizedResponse = {
        text: textOf(message.content),
        tool_calls: toolCallsOf(message),
        usage: { input_tokens: toNumber(usage.prompt_tokens), output_tokens: toNumber(usage.completion_tokens) },
        latency_ms: latencyMs,
        served_model: asString(json.model),
        finish_reason: asString(choice.finish_reason),
      };
      if (dropped.length) response.dropped_params = dropped;
      return response;
    },
  };
}
