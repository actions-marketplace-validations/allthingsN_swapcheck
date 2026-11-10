import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, canonicalRoute, firstPartyRoute, isLookalike, isModelKey, isPriceKey, recognize, vendorOfId } from "../../src/scan/ids.ts";
import { snapshot } from "./helpers.ts";

const index = buildIndex(snapshot());

const VALID: Array<[string, string]> = [
  ["gpt-4o", "openai"], ["gpt-4", "openai"], ["gpt-4.1-mini", "openai"], ["gpt-5.1-codex", "openai"], ["gpt-3.5-turbo-0125", "openai"], ["gpt-oss-120b", "openai"],
  ["chatgpt-4o-latest", "openai"], ["o1", "openai"], ["o3-mini", "openai"], ["o4-mini-2025-04-16", "openai"], ["text-embedding-3-small", "openai"],
  ["claude-3-5-sonnet-20241022", "anthropic"], ["claude-opus-4-1", "anthropic"], ["claude-instant-1.2", "anthropic"], ["claude-3-opus-latest", "anthropic"],
  ["gemini-1.5-pro", "google"], ["gemini-2.5-flash-lite", "google"], ["gemini-pro", "google"], ["gemini-flash-latest", "google"], ["gemma-3-27b", "google"],
  ["grok-3", "xai"], ["grok-4-fast", "xai"], ["grok-beta", "xai"], ["grok-code-fast-1", "xai"],
  ["llama-3.3-70b-versatile", "meta"], ["llama3-70b-8192", "meta"], ["llama-guard-3-8b", "meta"],
  ["mistral-large-latest", "mistral"], ["mistral-small-2402", "mistral"], ["open-mixtral-8x7b", "mistral"], ["codestral-latest", "mistral"], ["pixtral-large-2411", "mistral"], ["mistral-nemo", "mistral"],
  ["deepseek-chat", "deepseek"], ["deepseek-reasoner", "deepseek"], ["deepseek-r1", "deepseek"], ["deepseek-v3", "deepseek"],
  ["kimi-k2-0711-preview", "moonshot"], ["kimi-latest", "moonshot"], ["moonshot-v1-8k", "moonshot"],
  ["qwen-max", "alibaba"], ["qwen2.5-72b", "alibaba"], ["qwen3-coder", "alibaba"], ["qwen-2.5-turbo", "alibaba"],
  ["glm-4", "zhipu"], ["glm-4.5", "zhipu"], ["chatglm-6b", undefined as unknown as string],
  ["command-r-plus", "cohere"],
].filter(([, vendor]) => vendor !== undefined) as Array<[string, string]>;

for (const [id, vendor] of VALID) {
  test(`pattern accepts ${id}`, () => assert.equal(vendorOfId(id), vendor));
}

for (const id of ["claude-code", "claude-cli", "claude-desktop", "gemini-cli", "gemini-api", "llama-index", "llama-cpp", "llama-stack", "mistral-common", "mistral-inference", "qwen-agent", "deepseek-sdk", "grok-client", "kimi-cli", "GPT-4", "Claude-3", "gpt", "gpt-", "gpt-four", "o2", "o5-mini", "command", "glm"]) {
  test(`pattern rejects ${id}`, () => assert.equal(vendorOfId(id), undefined));
}

for (const value of ["https://api.openai.com/v1/gpt-4", "gpt-4.png", "gpt-4o.json", "claude-3.md", "./gpt-4", "../models/gpt-4", "/opt/gpt-4", "~/gpt-4", "@anthropic-ai/sdk", "@ai-sdk/openai", "gpt 4", "gpt-4 is great", "a", "", "x".repeat(201), "gpt-${v}", "gpt-4\n", "-gpt-4", "models//gpt-4"]) {
  test(`lookalike rejected: ${JSON.stringify(value.slice(0, 40))}`, () => assert.equal(isLookalike(value), true));
}

test("known model outside model context is accepted", () => {
  assert.deepEqual(recognize("gpt-4o", index, false), { model: "gpt-4o", known: true, vendor: "openai", fixedRoute: undefined });
});

test("pattern-only model requires model context", () => {
  assert.equal(recognize("gpt-9-turbo", index, false), null);
  assert.equal(recognize("gpt-9-turbo", index, true)?.known, false);
});

test("a short known ID needs model context", () => {
  assert.equal(recognize("o1", index, false), null);
  assert.equal(recognize("o1", index, true)?.known, true);
});

test("URL-like and filename strings are rejected even in model context", () => {
  assert.equal(recognize("https://x.test/gpt-4o", index, true), null);
  assert.equal(recognize("gpt-4o.json", index, true), null);
  assert.equal(recognize("gpt-4o mini", index, true), null);
});

test("package names are not models in model context", () => {
  for (const value of ["openai", "anthropic", "@anthropic-ai/sdk", "openai/resources", "google/generative-ai", "anthropic/messages"]) {
    assert.equal(recognize(value, index, true), null, value);
  }
});

test("module paths are not Bedrock IDs", () => {
  for (const value of ["openai.chat", "anthropic.messages", "amazon.com", "google.com", "cohere.ai", "meta.json", "mistral.chat.complete"]) {
    assert.equal(recognize(value, index, true), null, value);
  }
});

test("bedrock IDs fix the route", () => {
  for (const id of ["anthropic.claude-3-5-sonnet-20241022-v2:0", "meta.llama3-70b-instruct-v1:0", "amazon.titan-text-lite-v1", "mistral.mistral-large-2402-v1:0", "cohere.command-r-v1:0"]) {
    assert.equal(recognize(id, index, true)?.fixedRoute, "aws-bedrock", id);
  }
});

test("bedrock cross-region prefix resolves to the known base ID", () => {
  const rec = recognize("us.anthropic.claude-3-haiku-20240307-v1:0", index, false);
  assert.equal(rec?.model, "anthropic.claude-3-haiku-20240307-v1:0");
  assert.equal(rec?.known, true);
  assert.equal(rec?.fixedRoute, "aws-bedrock");
});

test("bedrock ARN yields the model part", () => {
  const rec = recognize("arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-haiku-20240307-v1:0", index, true);
  assert.equal(rec?.model, "anthropic.claude-3-haiku-20240307-v1:0");
  assert.equal(rec?.fixedRoute, "aws-bedrock");
});

test("vertex publisher paths and @ forms fix the route", () => {
  assert.equal(recognize("publishers/google/models/gemini-2.5-pro", index, true)?.model, "gemini-2.5-pro");
  assert.equal(recognize("publishers/google/models/gemini-2.5-pro", index, true)?.fixedRoute, "google-vertex");
  assert.equal(recognize("projects/p/locations/us/publishers/anthropic/models/claude-sonnet-4@20250514", index, true)?.fixedRoute, "google-vertex");
  assert.equal(recognize("claude-3-5-sonnet-v2@20241022", index, true)?.fixedRoute, "google-vertex");
});

test("gemini resource names drop the models/ prefix", () => {
  const rec = recognize("models/gemini-2.0-flash", index, true);
  assert.equal(rec?.model, "gemini-2.0-flash");
  assert.equal(rec?.known, true);
});

test("router forms keep a route only when the prefix names one", () => {
  assert.equal(recognize("openrouter/anthropic/claude-sonnet-4-5", index, true)?.fixedRoute, "openrouter");
  assert.equal(recognize("openrouter/anthropic/claude-sonnet-4-5", index, true)?.model, "claude-sonnet-4-5");
  assert.equal(recognize("bedrock/anthropic.claude-3-haiku-20240307-v1:0", index, true)?.fixedRoute, "aws-bedrock");
  assert.equal(recognize("vertex_ai/gemini-2.5-pro", index, true)?.fixedRoute, "google-vertex");
  assert.equal(recognize("azure/gpt-4o", index, true)?.fixedRoute, "azure-openai");
  assert.equal(recognize("anthropic/claude-sonnet-4-5", index, true)?.fixedRoute, undefined);
  assert.equal(recognize("anthropic/claude-sonnet-4-5", index, true)?.model, "claude-sonnet-4-5");
});

test("hugging-face style router names accept capitals", () => {
  const rec = recognize("meta-llama/Llama-3.3-70B-Instruct", index, true);
  assert.equal(rec?.model, "Llama-3.3-70B-Instruct");
  assert.equal(rec?.vendor, "meta");
});

test("provider:model form", () => {
  assert.equal(recognize("openai:gpt-4o", index, true)?.model, "gpt-4o");
  assert.equal(recognize("google-vertex:gemini-2.5-pro", index, true)?.fixedRoute, "google-vertex");
  assert.equal(recognize("bedrock:anthropic.claude-3-haiku-20240307-v1:0", index, true)?.fixedRoute, "aws-bedrock");
});

test("fine-tuned IDs are kept whole", () => {
  assert.equal(recognize("ft:gpt-4o-mini:acme::abc123", index, true)?.model, "ft:gpt-4o-mini:acme::abc123");
  assert.equal(recognize("ft:gpt-4o-mini:acme::abc123", index, true)?.vendor, "openai");
});

test("a 1M-context suffix is stripped", () => {
  assert.equal(recognize("claude-sonnet-4-5[1m]", index, false)?.model, "claude-sonnet-4-5");
});

test("event-only models count as known", () => {
  assert.equal(buildIndex({ ...snapshot(), models: [] }).known.has("gpt-3.5-turbo"), true);
});

for (const key of ["model", "models", "model_id", "modelId", "modelName", "MODEL", "OPENAI_MODEL", "default-model", "engine", "azure_deployment", "deployment_name", "llm", "chatModel", "inference_profile_id"]) {
  test(`model key: ${key}`, () => assert.equal(isModelKey(key), true));
}

for (const key of ["model_path", "modelDir", "model_type", "modelProvider", "model_version", "model_kwargs", "model_config", "name", "title", "className", "version", "data", "x".repeat(100)]) {
  test(`not a model key: ${key.slice(0, 20)}`, () => assert.equal(isModelKey(key), false));
}

test("price keys", () => {
  assert.equal(isPriceKey("MODEL_PRICES"), true);
  assert.equal(isPriceKey("inputCost"), true);
  assert.equal(isPriceKey("model"), false);
});

test("canonicalRoute adopts the registry's own name for a platform", () => {
  const custom = buildIndex({ ...snapshot(), models: [{ ...snapshot().models[0]!, route: "amazon-bedrock-converse" }], events: [] });
  assert.equal(canonicalRoute(custom, "aws-bedrock"), "amazon-bedrock-converse");
  assert.equal(canonicalRoute(index, "aws-bedrock"), "aws-bedrock");
});

test("firstPartyRoute prefers the vendor's API over a platform listing", () => {
  assert.equal(firstPartyRoute(index, "claude-3-5-sonnet-20241022", "anthropic"), "anthropic-api");
  assert.equal(firstPartyRoute(index, "gemini-2.5-pro", "google"), "google-vertex");
  assert.equal(firstPartyRoute(index, "gpt-9", "openai"), "openai-api");
  assert.equal(firstPartyRoute(index, "mystery", undefined), undefined);
});
