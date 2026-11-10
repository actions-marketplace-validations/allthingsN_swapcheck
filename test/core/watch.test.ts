import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedRegistry } from "../../src/registry/client.ts";
import type { ExposureItem, LockFile, RegistryEvent, ScanFinding, ScanResult } from "../../src/types.ts";
import { computeExposure, daysUntil, dueItems, watchLock } from "../../src/watch.ts";
import { NOW, snapshot } from "./helpers.ts";

const finding = (model: string, route: string | undefined, file = "a.py", line = 1, kind: ScanFinding["kind"] = "code"): ScanFinding => {
  const f: ScanFinding = { model, file, line, column: 1, kind, known: true };
  if (route !== undefined) f.route = route;
  return f;
};

const scan = (...findings: ScanFinding[]): ScanResult => ({ root: "/x", files_scanned: 1, findings, unresolved: [] });

const event = (overrides: Partial<RegistryEvent>): RegistryEvent => ({
  id: "x",
  type: "retirement",
  provider: "p",
  route: "r",
  model: "m",
  source: "s",
  confidence: "high",
  first_seen: "2026-01-01",
  last_verified: "2026-01-01",
  ...overrides,
});

const exposureWith = (events: RegistryEvent[], now = NOW): ExposureItem => computeExposure(scan(finding("m", "r")), { ...snapshot(), events }, now)[0]!;

test("daysUntil counts calendar days in UTC", () => {
  assert.equal(daysUntil("2026-11-10", new Date("2026-11-09T23:59:00Z")), 1);
  assert.equal(daysUntil("2026-11-09", new Date("2026-11-09T00:00:00Z")), 0);
  assert.equal(daysUntil("2026-11-09", new Date("2026-11-09T23:59:59Z")), 0);
  assert.equal(daysUntil("2026-11-08", new Date("2026-11-09T00:00:00Z")), -1);
  assert.equal(daysUntil("nonsense", NOW), null);
});

test("daysUntil is stable across a leap day and DST changes", () => {
  assert.equal(daysUntil("2028-03-01", new Date("2028-02-28T12:00:00Z")), 2);
  assert.equal(daysUntil("2026-11-02", new Date("2026-10-31T12:00:00Z")), 2);
});

test("future retirement is retiring with days_until", () => {
  const [item] = computeExposure(scan(finding("claude-3-5-sonnet-20241022", "anthropic-api")), snapshot(), NOW);
  assert.equal(item?.status, "retiring");
  assert.equal(item?.days_until, 30);
});

test("past retirement is retired with negative days", () => {
  const [item] = computeExposure(scan(finding("gpt-3.5-turbo", "openai-api")), snapshot(), NOW);
  assert.equal(item?.status, "retired");
  assert.ok((item?.days_until ?? 0) < 0);
});

test("retirement effective today is still retiring at zero days", () => {
  const item = exposureWith([event({ effective: "2026-11-09" })]);
  assert.equal(item.status, "retiring");
  assert.equal(item.days_until, 0);
});

test("reroute before and after its date", () => {
  assert.equal(exposureWith([event({ type: "reroute", effective: "2026-12-01" })]).status, "reroute_scheduled");
  assert.equal(exposureWith([event({ type: "reroute", effective: "2026-01-01" })]).status, "rerouted");
});

test("alias moves behave like reroutes", () => {
  assert.equal(exposureWith([event({ type: "alias_move", effective: "2026-12-01" })]).status, "reroute_scheduled");
  assert.equal(exposureWith([event({ type: "alias_move", effective: "2026-01-01" })]).status, "rerouted");
});

test("upcoming price and parameter changes", () => {
  assert.equal(exposureWith([event({ type: "price_change", effective: "2026-12-01" })]).status, "repricing");
  assert.equal(exposureWith([event({ type: "parameter_change", effective: "2026-12-01" })]).status, "parameter_change");
});

test("a price change already in effect is not exposure", () => {
  const [item] = computeExposure(scan(finding("gpt-4.1", "openai-api")), snapshot(), NOW);
  assert.equal(item?.status, "ok");
  assert.equal(item?.days_until, undefined);
  assert.equal(item?.events.length, 1);
});

test("informational events alone do not change the status", () => {
  const item = exposureWith([event({ type: "new_model", effective: "2026-12-01" }), event({ type: "capability_change" })]);
  assert.equal(item.status, "unknown");
  assert.equal(item.events.length, 2);
});

test("undated retirement is retiring without days", () => {
  const item = exposureWith([event({})]);
  assert.equal(item.status, "retiring");
  assert.equal(item.days_until, undefined);
});

test("most urgent: soonest dated event wins", () => {
  const item = exposureWith([event({ id: "late", effective: "2027-06-01" }), event({ id: "soon", effective: "2026-12-01" }), event({ id: "mid", effective: "2027-01-01" })]);
  assert.equal(item.days_until, 22);
  assert.deepEqual(item.events.map((e) => e.id), ["soon", "mid", "late"]);
});

test("most urgent: something that already landed beats anything pending", () => {
  const item = exposureWith([event({ id: "soon", type: "price_change", effective: "2026-11-10" }), event({ id: "gone", effective: "2026-01-01" })]);
  assert.equal(item.status, "retired");
  assert.equal(item.events[0]?.id, "gone");
});

test("most urgent: retired beats rerouted among landed events", () => {
  const item = exposureWith([event({ id: "a", type: "reroute", effective: "2026-10-01" }), event({ id: "b", effective: "2026-01-01" })]);
  assert.equal(item.status, "retired");
});

test("most urgent: a same-day tie goes to the more severe change", () => {
  const item = exposureWith([event({ id: "p", type: "price_change", effective: "2026-12-01" }), event({ id: "r", effective: "2026-12-01" })]);
  assert.equal(item.status, "retiring");
});

test("most urgent: a dated change outranks an undated one", () => {
  const item = exposureWith([event({ id: "undated" }), event({ id: "dated", type: "price_change", effective: "2027-06-01" })]);
  assert.equal(item.status, "repricing");
});

test("route separation: an event on another route does not apply", () => {
  const [item] = computeExposure(scan(finding("claude-3-5-sonnet-20241022", "aws-bedrock")), snapshot(), NOW);
  assert.equal(item?.status, "ok");
  assert.deepEqual(item?.events, []);
});

test("route separation: same model on two routes stays two entries", () => {
  const items = computeExposure(scan(finding("claude-3-5-sonnet-20241022", "anthropic-api", "a.py"), finding("claude-3-5-sonnet-20241022", "aws-bedrock", "b.py")), snapshot(), NOW);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.route, i.status]), [["anthropic-api", "retiring"], ["aws-bedrock", "ok"]]);
});

test("a finding with no route gets no events", () => {
  const [item] = computeExposure(scan(finding("claude-3-5-sonnet-20241022", undefined)), snapshot(), NOW);
  assert.equal(item?.route, "unknown");
  assert.equal(item?.status, "unknown");
});

test("an unknown model is unknown", () => {
  assert.equal(computeExposure(scan(finding("gpt-9", "openai-api")), snapshot(), NOW)[0]?.status, "unknown");
});

test("catalog status fills in when no event exists", () => {
  const snap = snapshot();
  snap.events = [];
  assert.equal(computeExposure(scan(finding("gpt-3.5-turbo", "openai-api")), snap, NOW)[0]?.status, "retiring");
  snap.models[0]!.status = "retired";
  assert.equal(computeExposure(scan(finding("gpt-4o", "openai-api")), snap, NOW)[0]?.status, "retired");
});

test("docs findings are not exposure", () => {
  assert.deepEqual(computeExposure(scan(finding("gpt-4o", "openai-api", "a.md", 1, "docs")), snapshot(), NOW), []);
});

test("locations are merged and deduplicated", () => {
  const [item] = computeExposure(scan(finding("gpt-4o", "openai-api", "a.py", 1), finding("gpt-4o", "openai-api", "a.py", 1), finding("gpt-4o", "openai-api", "b.py", 9)), snapshot(), NOW);
  assert.deepEqual(item?.locations, [{ file: "a.py", line: 1 }, { file: "b.py", line: 9 }]);
});

test("items sort by urgency, unaffected models last, then by name", () => {
  const items = computeExposure(scan(finding("gpt-4o", "openai-api"), finding("gpt-3.5-turbo", "openai-api"), finding("claude-3-5-sonnet-20241022", "anthropic-api"), finding("deepseek-chat", "deepseek-api")), snapshot(), NOW);
  assert.deepEqual(items.map((i) => i.model), ["gpt-3.5-turbo", "claude-3-5-sonnet-20241022", "deepseek-chat", "gpt-4o"]);
});

test("dueItems respects the window and always includes what already landed", () => {
  const items = computeExposure(scan(finding("gpt-3.5-turbo", "openai-api"), finding("claude-3-5-sonnet-20241022", "anthropic-api"), finding("gpt-4o-mini", "openai-api"), finding("gpt-4o", "openai-api")), snapshot(), NOW);
  assert.deepEqual(dueItems(items, 25).map((i) => i.model), ["gpt-3.5-turbo", "gpt-4o-mini"]);
  assert.deepEqual(dueItems(items, 30).map((i) => i.model), ["gpt-3.5-turbo", "gpt-4o-mini", "claude-3-5-sonnet-20241022"]);
  assert.deepEqual(dueItems(items, 0).map((i) => i.model), ["gpt-3.5-turbo"]);
});

test("dueItems: an undated change is not inside any window", () => {
  assert.deepEqual(dueItems([{ model: "m", route: "r", locations: [], events: [], status: "retiring" }], 365), []);
});

test("dueItems: retired without a date is still due", () => {
  assert.equal(dueItems([{ model: "m", route: "r", locations: [], events: [], status: "retired" }], 0).length, 1);
});

test("watchLock reports registry metadata and evaluates each route", () => {
  const lock: LockFile = {
    version: 1,
    models: [
      { id: "claude-3-5-sonnet-20241022", route: "anthropic-api", status: "ok", verified_at: null, baseline: null },
      { id: "claude-3-5-sonnet-20241022", route: "aws-bedrock", status: "ok", verified_at: null, baseline: null },
    ],
  };
  const loaded: LoadedRegistry = { snapshot: snapshot(), source: "cache", age_days: 8 };
  const result = watchLock(lock, loaded, { failWithinDays: 45, now: NOW });
  assert.equal(result.registry_generated_at, "2026-11-01T00:00:00Z");
  assert.equal(result.registry_age_days, 8);
  assert.equal(result.registry_source, "cache");
  assert.deepEqual(result.items.map((i) => [i.route, i.status]), [["anthropic-api", "retiring"], ["aws-bedrock", "ok"]]);
  assert.deepEqual(result.due.map((i) => i.route), ["anthropic-api"]);
  assert.deepEqual(result.items[0]?.locations, []);
});

test("watchLock: an event outside the window is not due", () => {
  const lock: LockFile = { version: 1, models: [{ id: "claude-3-5-sonnet-20241022", route: "anthropic-api", status: "ok", verified_at: null, baseline: null }] };
  const result = watchLock(lock, { snapshot: snapshot(), source: "bundled", age_days: 1 }, { failWithinDays: 10, now: NOW });
  assert.equal(result.due.length, 0);
});

test("watchLock with an empty lock", () => {
  const result = watchLock({ version: 1, models: [] }, { snapshot: snapshot(), source: "remote", age_days: 0 }, { failWithinDays: 30, now: NOW });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.due, []);
});
