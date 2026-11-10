import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegistrySnapshot } from "../../src/types.ts";
import { createAnthropicProvider, createGeminiProvider, createMockProvider, createOpenAIProvider, ProviderError, resolveProvider, vendorOf, type BudgetedRequest, type NormalizedResponse } from "../../src/providers/index.ts";
import { jsonResponse, noSleep, snapshot } from "./helpers.ts";

const SECRET = "sk-test-abcdefghijklmnop1234";
const empty: RegistrySnapshot = { version: 1, generated_at: "x", events: [], models: [] };

interface Captured { url: string; init: RequestInit }
function capture(responses: Array<Response | Error>): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const request: BudgetedRequest = {
  model: "m", max_tokens: 50,
  messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }],
  tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: { id: { type: "string" } } } }],
  params: { temperature: 0.2, top_p: 0.5, top_k: 4 },
};
const bodyOf = (call: Captured): Record<string, any> => JSON.parse(String(call.init.body));
const headersOf = (call: Captured): Record<string, string> => call.init.headers as Record<string, string>;

const openAiReply = { model: "m", choices: [{ finish_reason: "stop", message: { content: "hi", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"id":"a"}' } }, { id: "c2", type: "function", function: { name: "lookup", arguments: "{bad" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } };

test("OpenAI normalizes tools, usage and unparseable arguments", async () => {
  const { fetchImpl, calls } = capture([jsonResponse(openAiReply)]);
  const res = await createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete({ ...request, response_format: { type: "json_schema", schema: { type: "object" }, name: "out" } });
  const body = bodyOf(calls[0]!);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(headersOf(calls[0]!).authorization, `Bearer ${SECRET}`);
  assert.equal(body.max_completion_tokens, 50);
  assert.deepEqual(body.tools[0], { type: "function", function: { name: "lookup", description: "d", parameters: request.tools![0]!.parameters } });
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } });
  assert.equal(res.text, "hi");
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 4 });
  assert.deepEqual(res.tool_calls[0], { id: "c1", name: "lookup", arguments: { id: "a" } });
  assert.equal(res.tool_calls[1]!.raw_arguments, "{bad");
  assert.deepEqual((res as NormalizedResponse).dropped_params, ["top_k"]);
});

test("OpenAI reasoning models drop sampling parameters and record it", async () => {
  const { fetchImpl, calls } = capture([jsonResponse(openAiReply)]);
  const res = await createOpenAIProvider({ apiKey: SECRET, fetchImpl }).complete({ ...request, model: "gpt-5-mini", params: { temperature: 0.1, seed: 2 } });
  const body = bodyOf(calls[0]!);
  assert.equal(body.temperature, undefined);
  assert.equal(body.seed, 2);
  assert.deepEqual((res as NormalizedResponse).dropped_params, ["temperature"]);
});

test("compatible endpoints use max_tokens and a custom base URL", async () => {
  const { fetchImpl, calls } = capture([jsonResponse(openAiReply)]);
  await createOpenAIProvider({ apiKey: SECRET, baseUrl: "https://proxy.example/v1/", fetchImpl }).complete(request);
  assert.equal(calls[0]!.url, "https://proxy.example/v1/chat/completions");
  assert.equal(bodyOf(calls[0]!).max_tokens, 50);
});

test("providers refuse plain HTTP to a remote host", async () => {
  const { fetchImpl, calls } = capture([jsonResponse(openAiReply)]);
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, baseUrl: "http://proxy.example/v1", fetchImpl }).complete(request), /not HTTPS/);
  assert.equal(calls.length, 0);
});

test("Anthropic drops sampling parameters, maps system and tools", async () => {
  const reply = { model: "claude-x", stop_reason: "tool_use", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "lookup", input: { id: "a" } }], usage: { input_tokens: 9, output_tokens: 2 } };
  const { fetchImpl, calls } = capture([jsonResponse(reply)]);
  const res = await createAnthropicProvider({ apiKey: SECRET, fetchImpl }).complete({ ...request, model: "anthropic/claude-x", response_format: { type: "json_schema", schema: { type: "object" } } });
  const body = bodyOf(calls[0]!);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(headersOf(calls[0]!)["x-api-key"], SECRET);
  assert.ok(headersOf(calls[0]!)["anthropic-version"]);
  assert.equal(body.model, "claude-x");
  assert.equal(body.system, "be brief");
  for (const name of ["temperature", "top_p", "top_k"]) assert.equal(body[name], undefined);
  assert.deepEqual(body.tools[0].input_schema, request.tools![0]!.parameters);
  assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: { type: "object" } } });
  assert.deepEqual((res as NormalizedResponse).dropped_params, ["temperature", "top_p", "top_k"]);
  assert.deepEqual(res.tool_calls, [{ id: "t1", name: "lookup", arguments: { id: "a" } }]);
  assert.equal(res.served_model, "claude-x");
});

test("Anthropic merges tool results into a user turn", async () => {
  const reply = { model: "c", content: [{ type: "text", text: "done" }], usage: {} };
  const { fetchImpl, calls } = capture([jsonResponse(reply)]);
  await createAnthropicProvider({ apiKey: SECRET, fetchImpl }).complete({
    model: "c",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "x", arguments: {} }, { id: "b", name: "y", arguments: {} }] },
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "2" },
    ],
  });
  const messages = bodyOf(calls[0]!).messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[2].role, "user");
  assert.deepEqual(messages[2].content.map((block: { tool_use_id: string }) => block.tool_use_id), ["a", "b"]);
});

test("Gemini sends the key in a header and never the URL", async () => {
  const reply = { modelVersion: "gemini-x-001", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hey" }, { functionCall: { name: "lookup", args: { id: "z" } } }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, thoughtsTokenCount: 3 } };
  const { fetchImpl, calls } = capture([jsonResponse(reply)]);
  const res = await createGeminiProvider({ apiKey: SECRET, fetchImpl }).complete({ ...request, model: "gemini-x", tools: [{ name: "lookup", parameters: { type: "object", additionalProperties: false, properties: {} } }], response_format: { type: "json_schema", schema: { type: "object", $schema: "x", properties: {} } } });
  const body = bodyOf(calls[0]!);
  assert.ok(!calls[0]!.url.includes(SECRET));
  assert.ok(!calls[0]!.url.includes("key="));
  assert.equal(headersOf(calls[0]!)["x-goog-api-key"], SECRET);
  assert.equal(body.generationConfig.maxOutputTokens, 50);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.generationConfig.topK, 4);
  assert.equal(body.generationConfig.responseSchema.$schema, undefined);
  assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.equal(body.systemInstruction.parts[0].text, "be brief");
  assert.deepEqual(res.usage, { input_tokens: 6, output_tokens: 5 });
  assert.equal(res.tool_calls[0]!.name, "lookup");
  assert.equal(res.served_model, "gemini-x-001");
});

test("429 and 5xx retry within the bound and honor Retry-After", async () => {
  const waits: number[] = [];
  const { fetchImpl, calls } = capture([new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), new Response("oops", { status: 503 }), jsonResponse(openAiReply)]);
  const res = await createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: async (ms) => { waits.push(ms); } }).complete(request);
  assert.equal(calls.length, 3);
  assert.equal(waits[0], 2000);
  assert.equal(res.text, "hi");
});

test("retries stop at the attempt limit and keep billing unknown", async () => {
  const { fetchImpl, calls } = capture([new Response("bad", { status: 500 })]);
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.billing, "unknown");
    assert.match(error.message, /HTTP 500/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("a Retry-After beyond the limit fails with a sentence instead of waiting", async () => {
  const { fetchImpl, calls } = capture([new Response("x", { status: 429, headers: { "retry-after": "3600" } })]);
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete(request), /asked Swapcheck to wait 3600 seconds/);
  assert.equal(calls.length, 1);
});

test("a 400 is not retried and the billing is none", async () => {
  const { fetchImpl, calls } = capture([new Response('{"error":"bad"}', { status: 400 })]);
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete(request), (error: unknown) => error instanceof ProviderError && error.billing === "none");
  assert.equal(calls.length, 1);
});

test("beforeRetry is called before each retry and can stop it", async () => {
  const { fetchImpl, calls } = capture([new Response("x", { status: 500 })]);
  const attempts: number[] = [];
  const budgeted: BudgetedRequest = { ...request, beforeRetry: (attempt) => { attempts.push(attempt); throw new Error("over budget"); } };
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete(budgeted), /over budget/);
  assert.deepEqual(attempts, [1]);
  assert.equal(calls.length, 1);
});

test("timeouts retry and then report a sentence", async () => {
  const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
  })) as unknown as typeof fetch;
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep, timeoutMs: 5 }).complete(request), /timed out after/);
});

test("errors never contain the API key", async () => {
  const { fetchImpl } = capture([new Response(`bad key ${SECRET}`, { status: 401 })]);
  await assert.rejects(createOpenAIProvider({ apiKey: SECRET, fetchImpl, sleep: noSleep }).complete(request), (error: Error) => {
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
});

test("a missing key names the environment variable", () => {
  assert.throws(() => resolveProvider("gpt-4o", undefined, empty, {}), /OPENAI_API_KEY/);
  assert.throws(() => resolveProvider("claude-sonnet", undefined, empty, {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => resolveProvider("gemini-pro", undefined, empty, {}), /GEMINI_API_KEY or GOOGLE_API_KEY/);
  assert.throws(() => resolveProvider("x/y", "openrouter", empty, {}), /OPENROUTER_API_KEY/);
});

test("resolveProvider routes by vendor, route and environment", async () => {
  const { fetchImpl, calls } = capture([jsonResponse(openAiReply)]);
  await resolveProvider("mistralai/mistral-x", "openrouter", empty, { OPENROUTER_API_KEY: SECRET }, fetchImpl).complete({ ...request, model: "mistralai/mistral-x" });
  assert.match(calls[0]!.url, /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(bodyOf(calls[0]!).model, "mistralai/mistral-x");
  assert.equal(resolveProvider("gemini-pro", undefined, empty, { GOOGLE_API_KEY: SECRET }).name, "gemini");
  assert.equal(resolveProvider("anything", undefined, empty, { SWAPCHECK_OPENAI_BASE_URL: "http://localhost:8080/v1" }).name, "openai-compatible endpoint");
  assert.throws(() => resolveProvider("claude-x", "aws-bedrock", empty, { ANTHROPIC_API_KEY: SECRET }), /cannot call the aws-bedrock route/);
  assert.throws(() => resolveProvider("mystery", undefined, empty, {}), /does not know how to reach/);
});

test("vendorOf uses the registry, then the id", () => {
  assert.equal(vendorOf("base-model", snapshot), "acme");
  assert.equal(vendorOf("claude-3", empty), "anthropic");
  assert.equal(vendorOf("gpt-4o", empty), "openai");
  assert.equal(vendorOf("o3-mini", empty), "openai");
  assert.equal(vendorOf("gemini-2.0", empty), "google");
  assert.equal(vendorOf("meta-llama/llama-3", empty), "meta");
  assert.equal(vendorOf("whatever", empty), "unknown");
});

test("the mock provider fills defaults and counts calls", async () => {
  const seen: number[] = [];
  const provider = createMockProvider((_req, index) => { seen.push(index); return { text: "abcdefgh" }; }, "mine");
  const res = await provider.complete({ model: "z", messages: [] });
  await provider.complete({ model: "z", messages: [] });
  assert.equal(provider.name, "mine");
  assert.equal(res.usage.output_tokens, 2);
  assert.equal(res.served_model, "z");
  assert.deepEqual(res.tool_calls, []);
  assert.deepEqual(seen, [0, 1]);
});
