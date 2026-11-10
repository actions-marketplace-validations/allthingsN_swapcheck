import assert from "node:assert/strict";
import { test } from "node:test";
import { findReplacements } from "../../src/find.ts";
import type { RegistryModel, RegistrySnapshot } from "../../src/types.ts";
import { NOW, requirements, snapshot } from "./helpers.ts";

const find = (model: string, overrides = requirements(), policy = {}, opts: { limit?: number; route?: string; snap?: RegistrySnapshot } = {}) =>
  findReplacements(model, overrides, opts.snap ?? snapshot(), policy, { now: NOW, ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.route !== undefined ? { route: opts.route } : {}) });

const reasonFor = (result: ReturnType<typeof find>, model: string): string | undefined => result.rejected.find((r) => r.model === model)?.reason;

const model = (id: string, overrides: Partial<RegistryModel> = {}): RegistryModel => ({
  id,
  provider: "openai",
  route: "openai-api",
  name: id,
  release_date: "2025-01-01",
  status: "active",
  capabilities: { tools: true, structured_output: true, reasoning: false, vision: false, audio: false, pdf: false },
  limit: { context: 100000, output: 8000 },
  cost: { input: 1, output: 4 },
  source: "s",
  ...overrides,
});

test("the provider-named successor is first", () => {
  const result = find("claude-3-5-sonnet-20241022");
  assert.equal(result.shortlist[0]?.model, "claude-sonnet-4-5");
  assert.equal(result.shortlist[0]?.reason, "provider_successor");
});

test("an inferred successor is not treated as provider named", () => {
  const result = find("gpt-3.5-turbo");
  assert.notEqual(result.shortlist[0]?.reason, "provider_successor");
});

test("the shortlist holds one of each slot, five by default", () => {
  const result = find("claude-3-5-sonnet-20241022");
  assert.equal(result.shortlist.length, 5);
  assert.deepEqual(result.shortlist.map((s) => s.reason), ["provider_successor", "same_vendor", "cheapest", "other_vendor", "other_vendor"]);
});

test("the model itself is never offered or recorded as rejected", () => {
  const result = find("gpt-4o");
  assert.ok(!result.shortlist.some((s) => s.model === "gpt-4o"));
  assert.ok(!result.rejected.some((r) => r.model === "gpt-4o"));
});

test("closest same-vendor prefers the family, then the nearest price", () => {
  const snap: RegistrySnapshot = {
    ...snapshot(),
    events: [],
    models: [
      model("gpt-base", { family: "alpha", cost: { input: 1, output: 10 } }),
      model("gpt-other-family", { family: "beta", cost: { input: 1, output: 10 }, release_date: "2026-06-01" }),
      model("gpt-same-far", { family: "alpha", cost: { input: 1, output: 100 } }),
      model("gpt-same-near", { family: "alpha", cost: { input: 1, output: 12 } }),
    ],
  };
  assert.equal(find("gpt-base", requirements(), {}, { snap }).shortlist.find((s) => s.reason === "same_vendor")?.model, "gpt-same-near");
});

test("the cheapest slot takes the lowest priced qualifier and ignores unpriced rows", () => {
  const result = find("claude-3-5-sonnet-20241022");
  const cheapest = result.shortlist.find((s) => s.reason === "cheapest");
  // gemini-2.0-flash is cheaper but is rerouted within 90 days, and llama-free has no price.
  assert.equal(cheapest?.model, "gpt-4o-mini");
});

test("other-vendor slots come from two different vendors, none the current vendor", () => {
  const result = find("claude-3-5-sonnet-20241022");
  const others = result.shortlist.filter((s) => s.reason === "other_vendor");
  assert.equal(others.length, 2);
  assert.notEqual(others[0]?.provider, others[1]?.provider);
  assert.ok(others.every((s) => s.provider !== "anthropic"));
});

test("rank: newest release, then lowest cost, then ID", () => {
  const snap: RegistrySnapshot = {
    ...snapshot(),
    events: [],
    models: [
      model("gpt-base"),
      model("grok-older", { provider: "xai", release_date: "2024-01-01", cost: { input: 1, output: 1 } }),
      model("grok-newest", { provider: "xai", release_date: "2026-01-01", cost: { input: 1, output: 90 } }),
      model("deepseek-v9-pricey", { provider: "deepseek", release_date: "2025-06-01", cost: { input: 1, output: 9 } }),
      model("deepseek-v9-cheap", { provider: "deepseek", release_date: "2025-06-01", cost: { input: 1, output: 2 } }),
    ],
  };
  const others = find("gpt-base", requirements(), {}, { snap, limit: 10 }).shortlist;
  assert.equal(others.filter((s) => s.reason === "other_vendor")[0]?.model, "grok-newest");
  assert.equal(others.filter((s) => s.reason === "other_vendor")[1]?.model, "deepseek-v9-cheap");
  assert.equal(others.find((s) => s.reason === "cheapest")?.model, "grok-older");
});

test("a capability flag never promotes a model", () => {
  const base = [model("gpt-base"), model("grok-a", { provider: "xai", release_date: "2026-01-01" }), model("grok-b", { provider: "xai", release_date: "2025-01-01", capabilities: { tools: true, structured_output: true, reasoning: true, vision: true, audio: true, pdf: true } })];
  const shortlist = find("gpt-base", requirements(), {}, { snap: { ...snapshot(), events: [], models: base } }).shortlist;
  assert.deepEqual(shortlist.map((s) => s.model), ["grok-a", "grok-b"]);
});

for (const [flag, label, id] of [
  ["tools", "tool calling", "llama-free"],
  ["structured_output", "structured output", "claude-3-5-sonnet-20241022"],
  ["vision", "image input", "deepseek-chat"],
  ["audio", "audio input", "gpt-4o"],
  ["pdf", "PDF input", "gpt-4.1"],
] as Array<[keyof ReturnType<typeof requirements>, string, string]>) {
  test(`a model missing ${flag} is removed with a reason`, () => {
    const result = find("grok-4", requirements({ [flag]: true }));
    assert.ok(!result.shortlist.some((s) => s.model === id));
    assert.match(reasonFor(result, id) ?? "", new RegExp(label));
  });
}

test("context and output limits remove models", () => {
  const context = find("gpt-4o", requirements({ min_context: 500_000 }));
  assert.match(reasonFor(context, "claude-sonnet-4-5") ?? "", /context of 200000 tokens is below the required 500000/);
  const output = find("gpt-4o", requirements({ min_output: 20_000 }));
  assert.match(reasonFor(output, "deepseek-chat") ?? "", /maximum output of 8192 tokens is below the required 20000/);
});

test("a limit exactly at the requirement passes", () => {
  const result = find("gpt-4o", requirements({ min_output: 8192 }));
  assert.equal(reasonFor(result, "deepseek-chat"), undefined);
});

test("a model retiring within 90 days is removed", () => {
  assert.match(reasonFor(find("gpt-4o"), "mistral-large-2402") ?? "", /retirement on 2026-12-20, within 90 days/);
});

test("the 90-day boundary is inclusive", () => {
  const events = (effective: string) => [{ id: "e", type: "retirement" as const, provider: "openai", route: "openai-api", model: "gpt-x", effective, source: "s", confidence: "high" as const, first_seen: "2026-01-01", last_verified: "2026-01-01" }];
  const snap = (effective: string): RegistrySnapshot => ({ ...snapshot(), events: events(effective), models: [model("gpt-base"), model("gpt-x")] });
  assert.ok(reasonFor(find("gpt-base", requirements(), {}, { snap: snap("2027-02-07") }), "gpt-x"));
  assert.equal(reasonFor(find("gpt-base", requirements(), {}, { snap: snap("2027-02-08") }), "gpt-x"), undefined);
});

test("an undated retirement also removes a model", () => {
  const snap: RegistrySnapshot = { ...snapshot(), models: [model("gpt-base"), model("gpt-x")], events: [{ id: "e", type: "retirement", provider: "openai", route: "openai-api", model: "gpt-x", source: "s", confidence: "high", first_seen: "2026-01-01", last_verified: "2026-01-01" }] };
  assert.match(reasonFor(find("gpt-base", requirements(), {}, { snap }), "gpt-x") ?? "", /no date yet/);
});

test("a retirement on another route does not remove the model", () => {
  const snap: RegistrySnapshot = { ...snapshot(), models: [model("gpt-base"), model("gpt-x")], events: [{ id: "e", type: "retirement", provider: "openai", route: "azure-openai", model: "gpt-x", effective: "2026-11-20", source: "s", confidence: "high", first_seen: "2026-01-01", last_verified: "2026-01-01" }] };
  assert.equal(reasonFor(find("gpt-base", requirements(), {}, { snap }), "gpt-x"), undefined);
});

test("a rejected successor is not offered", () => {
  const result = find("claude-3-5-sonnet-20241022", requirements({ audio: true }));
  assert.ok(!result.shortlist.some((s) => s.reason === "provider_successor"));
  assert.match(reasonFor(result, "claude-sonnet-4-5") ?? "", /audio/);
});

test("deprecated and retired models are removed", () => {
  assert.match(reasonFor(find("gpt-4o"), "gpt-3.5-turbo") ?? "", /status is deprecated/);
});

test("policy: providers", () => {
  const result = find("gpt-4o", requirements(), { providers: ["OpenAI"] });
  assert.ok(result.shortlist.every((s) => s.provider === "openai"));
  assert.match(reasonFor(result, "claude-sonnet-4-5") ?? "", /provider anthropic is not allowed/);
});

test("policy: regions and licenses need the model to declare them", () => {
  const snap: RegistrySnapshot = { ...snapshot(), events: [], models: [model("gpt-base"), model("gpt-eu", { region: ["eu"], license: "mit" }), model("gpt-us", { region: ["us"], license: "proprietary" }), model("gpt-none")] };
  const regions = find("gpt-base", requirements(), { regions: ["eu"] }, { snap });
  assert.deepEqual(regions.shortlist.map((s) => s.model), ["gpt-eu"]);
  assert.match(reasonFor(regions, "gpt-none") ?? "", /regions are unknown/);
  assert.match(reasonFor(regions, "gpt-us") ?? "", /not offered in a region/);
  const licenses = find("gpt-base", requirements(), { licenses: ["MIT"] }, { snap });
  assert.deepEqual(licenses.shortlist.map((s) => s.model), ["gpt-eu"]);
  assert.match(reasonFor(licenses, "gpt-none") ?? "", /license is unknown/);
});

test("policy: maximum output price", () => {
  const result = find("gpt-4o", requirements(), { max_usd_per_million_output: 1 });
  assert.ok(result.shortlist.every((s) => s.estimated_usd_per_million_output <= 1));
  assert.match(reasonFor(result, "o1") ?? "", /above the policy limit/);
});

test("every model is either shortlisted, rejected, or an unselected qualifier", () => {
  const snap = snapshot();
  const result = find("gpt-4o", requirements({ tools: true }), {}, { snap, limit: 100 });
  const accounted = new Set([...result.shortlist.map((s) => s.model), ...result.rejected.map((r) => r.model), "gpt-4o"]);
  for (const row of snap.models) assert.ok(accounted.has(row.id), row.id);
});

test("limit trims in slot order", () => {
  const result = find("claude-3-5-sonnet-20241022", requirements(), {}, { limit: 2 });
  assert.deepEqual(result.shortlist.map((s) => s.reason), ["provider_successor", "same_vendor"]);
});

test("a larger limit fills with remaining qualifiers", () => {
  const result = find("claude-3-5-sonnet-20241022", requirements(), {}, { limit: 8 });
  assert.equal(result.shortlist.length, 8);
  assert.equal(new Set(result.shortlist.map((s) => s.model)).size, 8);
});

test("no qualifiers yields an empty shortlist and full reasons", () => {
  const result = find("gpt-4o", requirements({ min_context: 1e9 }));
  assert.deepEqual(result.shortlist, []);
  assert.ok(result.rejected.length > 0);
});

test("an unknown current model still works, with no cost change", () => {
  const result = find("gpt-9-unknown");
  assert.ok(result.shortlist.length > 0);
  assert.ok(result.shortlist.every((s) => s.estimated_cost_change === null));
});

test("estimated cost change compares output price", () => {
  const entry = find("gpt-4o").shortlist.find((s) => s.model === "gpt-4.1");
  assert.ok(Math.abs((entry?.estimated_cost_change ?? 0) - -0.2) < 1e-9);
});

test("a current model with no price has null cost change", () => {
  const snap: RegistrySnapshot = { ...snapshot(), events: [], models: [model("gpt-base", { cost: { input: 0, output: 0 } }), model("gpt-x")] };
  assert.equal(find("gpt-base", requirements(), {}, { snap }).shortlist[0]?.estimated_cost_change, null);
});

test("route: one row per model, preferring the requested route", () => {
  const rows = [model("gpt-base", { route: "azure-openai" }), model("gpt-x", { route: "openai-api" }), model("gpt-x", { route: "azure-openai" })];
  const snap: RegistrySnapshot = { ...snapshot(), events: [], models: rows };
  const result = find("gpt-base", requirements(), {}, { snap, route: "azure-openai" });
  assert.deepEqual(result.shortlist.map((s) => [s.model, s.route]), [["gpt-x", "azure-openai"]]);
  assert.match(reasonFor(result, "gpt-x") ?? "", /openai-api route was not chosen/);
});

test("route: without a request, the first-party route wins", () => {
  const rows = [model("gpt-base"), model("gpt-x", { route: "azure-openai" }), model("gpt-x", { route: "openai-api" })];
  const shortlist = find("gpt-base", requirements(), {}, { snap: { ...snapshot(), events: [], models: rows } }).shortlist;
  assert.equal(shortlist[0]?.route, "openai-api");
});

test("the successor for the requested route is preferred", () => {
  const snap = snapshot();
  snap.events.push({ id: "b", type: "retirement", provider: "anthropic", route: "aws-bedrock", model: "claude-3-5-sonnet-20241022", to: "claude-opus-4-5", successor_basis: "provider_named", source: "s", confidence: "high", first_seen: "2026-01-01", last_verified: "2026-01-01" });
  assert.equal(find("claude-3-5-sonnet-20241022", requirements(), {}, { snap, route: "aws-bedrock" }).shortlist[0]?.model, "claude-opus-4-5");
  assert.equal(find("claude-3-5-sonnet-20241022", requirements(), {}, { snap, route: "anthropic-api" }).shortlist[0]?.model, "claude-sonnet-4-5");
});

test("result carries the requirements and is untested", () => {
  const reqs = requirements({ tools: true, evidence: ["a.py:1 passes tools"] });
  const result = find("gpt-4o", reqs);
  assert.deepEqual(result.requirements, reqs);
  assert.equal(result.tested, false);
  assert.equal(result.model, "gpt-4o");
});

test("entries include provenance and release date", () => {
  const entry = find("claude-3-5-sonnet-20241022").shortlist[0];
  assert.equal(entry?.source, "https://example.test/m");
  assert.equal(entry?.release_date, "2025-09-29");
  assert.equal(entry?.capabilities.tools, true);
});
