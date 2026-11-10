import type { ChatMessage, Provider, ToolCall } from "../types.ts";
import {
  asString, maxTokensOf, parseToolArguments, postJson, stripVendorPrefix, toNumber, toRecord, toolNameFor, trimBaseUrl,
  type BudgetedRequest, type NormalizedResponse, type ProviderConfig,
} from "./shared.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const PARAM_NAMES: Record<string, string> = { temperature: "temperature", top_p: "topP", top_k: "topK", seed: "seed", stop: "stopSequences", stop_sequences: "stopSequences" };
// The OpenAPI subset Gemini's classic schema field accepts.
const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "anyOf", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]);
const MAX_SCHEMA_DEPTH = 32;

function sanitizeSchema(schema: unknown, depth = 0): unknown {
  if (depth > MAX_SCHEMA_DEPTH || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(toRecord(value)).map(([name, sub]) => [name, sanitizeSchema(sub, depth + 1)]));
    } else if (key === "items") {
      out.items = sanitizeSchema(value, depth + 1);
    } else if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map((sub) => sanitizeSchema(sub, depth + 1));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parsedResponse(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Plain text results are wrapped below.
  }
  return { content: text };
}

function toContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  messages.forEach((message, index) => {
    if (message.role === "system") return;
    let role = "user";
    let parts: unknown[];
    if (message.role === "tool") {
      parts = [{ functionResponse: { name: toolNameFor(messages, index), response: parsedResponse(message.content) } }];
    } else if (message.role === "assistant") {
      role = "model";
      parts = message.content ? [{ text: message.content }] : [];
      for (const call of message.tool_calls ?? []) parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
    } else {
      parts = [{ text: message.content }];
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  });
  return contents;
}

export function createGeminiProvider(config: ProviderConfig): Provider {
  const baseUrl = trimBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  return {
    name: "gemini",
    async complete(req: BudgetedRequest): Promise<NormalizedResponse> {
      const model = stripVendorPrefix(req.model, ["google", "gemini"]).replace(/^models\//, "");
      const dropped: string[] = [];
      const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokensOf(req) };
      for (const [key, value] of Object.entries(req.params ?? {})) {
        const name = PARAM_NAMES[key];
        if (!name) dropped.push(key);
        else generationConfig[name] = name === "stopSequences" && !Array.isArray(value) ? [value] : value;
      }
      if (req.response_format) {
        generationConfig.responseMimeType = "application/json";
        if (req.response_format.type === "json_schema") generationConfig.responseSchema = sanitizeSchema(req.response_format.schema);
      }
      const body: Record<string, unknown> = { contents: toContents(req.messages), generationConfig };
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (req.tools?.length) {
        body.tools = [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: sanitizeSchema(tool.parameters) })) }];
      }

      // The key goes in a header because URLs end up in logs and proxies.
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const { json, latencyMs } = await postJson(url, { "x-goog-api-key": config.apiKey }, body, req, "Gemini", config);
      const candidate = toRecord(Array.isArray(json.candidates) ? json.candidates[0] : undefined);
      const parts = Array.isArray(toRecord(candidate.content).parts) ? (toRecord(candidate.content).parts as unknown[]).map(toRecord) : [];
      const toolCalls: ToolCall[] = parts
        .filter((part) => part.functionCall)
        .map((part, index) => {
          const call = toRecord(part.functionCall);
          return parseToolArguments(asString(call.id) ?? `call_${index}`, asString(call.name) ?? "", call.args);
        });
      const usage = toRecord(json.usageMetadata);
      const response: NormalizedResponse = {
        text: parts.filter((part) => !part.thought).map((part) => asString(part.text) ?? "").join(""),
        tool_calls: toolCalls,
        // Thinking tokens are billed at the output rate.
        usage: { input_tokens: toNumber(usage.promptTokenCount), output_tokens: toNumber(usage.candidatesTokenCount) + toNumber(usage.thoughtsTokenCount) },
        latency_ms: latencyMs,
        served_model: asString(json.modelVersion),
        finish_reason: asString(candidate.finishReason) ?? asString(toRecord(json.promptFeedback).blockReason),
      };
      if (dropped.length) response.dropped_params = dropped;
      return response;
    },
  };
}
