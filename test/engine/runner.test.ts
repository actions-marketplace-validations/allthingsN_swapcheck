import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderRequest, ProviderResponse, TestCase } from "../../src/types.ts";
import { createMockProvider, ProviderError, type BudgetedRequest } from "../../src/providers/index.ts";
import { BudgetLedger, estimateMaxCost, worstCaseUsd } from "../../src/testing/budget.ts";
import { replayMessages, runComparison, type RunOptions } from "../../src/testing/runner.ts";
import { decideCandidateVerdict, decideCaseVerdict } from "../../src/testing/verdict.ts";
import { makeCase, makeCases, snapshot } from "./helpers.ts";

type Handler = (req: ProviderRequest, index: number) => Partial<ProviderResponse> | Promise<Partial<ProviderResponse>>;

function options(handlers: Record<string, Handler>, extra: Partial<RunOptions> = {}): RunOptions {
  const providers = new Map(Object.entries(handlers).map(([model, handler]) => [model, createMockProvider(handler, model)]));
  return {
    baseline: "base-model", candidates: Object.keys(handlers).filter((model) => model !== "base-model"), cases: makeCases(12), runs: 5, budgetUsd: 100,
    snapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: (model) => providers.get(model)!, concurrency: 2, now: new Date("2026-11-09T00:00:00Z"), ...extra,
  };
}

const good: Handler = () => ({ text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 5 } });
const bad: Handler = () => ({ text: "not json", usage: { input_tokens: 10, output_tokens: 5 } });
const caseOf = (req: ProviderRequest): string => req.messages[req.messages.length - 1]!.content.replace("prompt:", "");

test("identical models report no change detected, with hashes and no text", async () => {
  const report = await runComparison(options({ "base-model": good, "cand-model": good }));
  assert.equal(report.candidates[0]!.verdict, "NO_CHANGE_DETECTED");
  assert.match(report.candidates[0]!.reason, /covers only those cases/);
  assert.equal(report.schema, "swapcheck.report/v1");
  assert.equal(report.stopped_early, false);
  assert.ok(report.runs.every((run) => run.output_text === undefined));
  assert.match(report.candidates[0]!.cases[0]!.case_hash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(report).includes("prompt:case-0"));
});

test("text is stored only when requested and is redacted", async () => {
  const secret = "sk-ant-abcdefghijklmnop";
  const report = await runComparison(options({ "base-model": () => ({ text: `{"key":"${secret}"}` }), "cand-model": good }, { includeText: true, cases: makeCases(6) }));
  const text = report.runs.find((run) => run.model === "base-model")!.output_text!;
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(!text.includes(secret));
});

test("a full collapse is confirmed as a regression", async () => {
  const report = await runComparison(options({ "base-model": good, "cand-model": bad }));
  const candidate = report.candidates[0]!;
  assert.equal(candidate.verdict, "REGRESSED");
  assert.ok(candidate.cases.some((row) => row.confirmed));
  assert.equal(candidate.cases[0]!.baseline_runs, 10);
  assert.equal(candidate.cases[0]!.candidate_runs, 5);
  assert.ok(candidate.cases[0]!.failed_checks.includes("json_valid#0"));
  assert.ok(candidate.suite_pass_rate.candidate < candidate.suite_pass_rate.baseline);
  assert.ok(candidate.suite_pass_rate.ci95[1] < 0);
});

test("a single regressed case is confirmed only on that case", async () => {
  const report = await runComparison(options({ "base-model": good, "cand-model": (req) => (caseOf(req) === "case-3" ? bad(req, 0) : good(req, 0)) }));
  const candidate = report.candidates[0]!;
  assert.equal(candidate.verdict, "REGRESSED");
  assert.deepEqual(candidate.cases.filter((row) => row.confirmed).map((row) => row.case_id), ["case-3"]);
  assert.equal(candidate.cases.find((row) => row.case_id === "case-3")!.verdict, "REGRESSED");
});

test("a drop that does not reproduce on the fresh sample is not confirmed", async () => {
  let callsToCase = 0;
  const flaky: Handler = (req) => {
    if (caseOf(req) !== "case-1") return good(req, 0);
    callsToCase++;
    return callsToCase <= 5 ? bad(req, 0) : good(req, 0);
  };
  const report = await runComparison(options({ "base-model": good, "cand-model": flaky }, { concurrency: 1 }));
  const candidate = report.candidates[0]!;
  const row = candidate.cases.find((entry) => entry.case_id === "case-1")!;
  assert.equal(row.confirmed, false);
  assert.notEqual(candidate.verdict, "REGRESSED");
});

test("confirmation re-runs happen on a fresh sample of N for both models", async () => {
  const calls = new Map<string, number>();
  const track = (handler: Handler, name: string): Handler => (req, index) => {
    const key = `${name}:${caseOf(req)}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return handler(req, index);
  };
  await runComparison(options({ "base-model": track(good, "base"), "cand-model": track((req) => (caseOf(req) === "case-0" ? bad(req, 0) : good(req, 0)), "cand") }));
  assert.equal(calls.get("base:case-0"), 15);
  assert.equal(calls.get("cand:case-0"), 10);
  assert.equal(calls.get("base:case-5"), 10);
  assert.equal(calls.get("cand:case-5"), 5);
});

test("the noise estimate compares two baseline samples", async () => {
  let call = 0;
  const report = await runComparison(options({ "base-model": () => (call++ < 5 ? { text: '{"a":1}' } : { text: "x" }), "cand-model": good }, { cases: [makeCase("only")], concurrency: 1 }));
  assert.equal(report.noise.flagged_cases, 1);
  assert.equal(report.noise.false_change_rate, 1);
});

test("too few cases gives not enough evidence", async () => {
  const report = await runComparison(options({ "base-model": good, "cand-model": good }, { cases: makeCases(3) }));
  assert.equal(report.candidates[0]!.verdict, "NOT_ENOUGH_EVIDENCE");
  assert.match(report.candidates[0]!.reason, /at least 6/);
});

test("a confirmed drop is reported even when the suite is small", async () => {
  const report = await runComparison(options({ "base-model": good, "cand-model": bad }, { cases: makeCases(2) }));
  assert.equal(report.candidates[0]!.verdict, "REGRESSED");
});

test("an error rate above 20% gives not enough evidence", async () => {
  const failing: Handler = () => { throw new ProviderError("boom", "unknown"); };
  const report = await runComparison(options({ "base-model": good, "cand-model": failing }));
  assert.equal(report.candidates[0]!.verdict, "NOT_ENOUGH_EVIDENCE");
  assert.equal(report.candidates[0]!.error_rate, 1);
  assert.match(report.candidates[0]!.reason, /calls failed/);
  assert.match(report.candidates[0]!.reason, /Most common error: boom/);
  assert.ok(report.runs.some((run) => run.error === "boom"));
});

test("the budget is enforced before each call and stops cleanly", async () => {
  let calls = 0;
  // Usage close to the worst case, so settling a reservation does not free much of the budget.
  const counting: Handler = (req) => { calls++; return { text: '{"ok":true}', usage: { input_tokens: 60, output_tokens: 64 } }; };
  const cases = makeCases(12);
  const oneCall = worstCaseUsd({ messages: cases[0]!.messages, max_tokens: 64 }, { input: 1, output: 2 });
  const budget = oneCall * 30;
  const report = await runComparison(options({ "base-model": counting, "cand-model": counting, "cand-b": counting }, { cases, budgetUsd: budget, concurrency: 4 }));
  assert.equal(report.stopped_early, true);
  assert.ok(report.spent_usd <= budget);
  assert.ok(calls <= 32, `${calls} calls`);
  for (const candidate of report.candidates) assert.equal(candidate.verdict, "NOT_ENOUGH_EVIDENCE");
  assert.match(report.candidates[0]!.reason, /budget/i);
  assert.equal(report.candidates.length, 2);
  assert.ok(report.limits.some((limit) => /budget was reached/.test(limit)));
});

test("reservations cover concurrent calls so spend cannot overshoot", async () => {
  const cases = makeCases(10);
  const oneCall = worstCaseUsd({ messages: cases[0]!.messages, max_tokens: 64 }, { input: 1, output: 2 });
  let inFlight = 0;
  let maxInFlight = 0;
  const slow: Handler = async (req, index) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return { ...good(req, index), usage: { input_tokens: 40, output_tokens: 64 } };
  };
  const budget = oneCall * 7;
  const report = await runComparison(options({ "base-model": slow, "cand-model": slow }, { cases, budgetUsd: budget, concurrency: 8 }));
  assert.ok(report.spent_usd <= budget, `${report.spent_usd} > ${budget}`);
  assert.ok(maxInFlight <= 8);
});

test("retries count toward the budget and failed attempts keep their charge", async () => {
  const cases = [makeCase("one")];
  const worst = worstCaseUsd({ messages: cases[0]!.messages, max_tokens: 64 }, { input: 1, output: 2 });
  let attempts = 0;
  const provider = createMockProvider(() => ({ text: "{}" }));
  const retrying = {
    name: "retrying",
    async complete(req: BudgetedRequest): Promise<ProviderResponse> {
      attempts++;
      req.beforeRetry?.(1);
      attempts++;
      req.beforeRetry?.(2);
      attempts++;
      return provider.complete(req);
    },
  };
  const report = await runComparison({ ...options({ "base-model": good }, { cases, candidates: [], runs: 1, budgetUsd: worst * 2.5 }), providerFor: () => retrying });
  assert.equal(report.stopped_early, true);
  assert.equal(attempts, 2);
  assert.ok(report.spent_usd >= worst * 2 - 1e-12);
});

test("a rejected request is released from the budget", async () => {
  const rejecting: Handler = () => { throw new ProviderError("HTTP 400", "none", 400); };
  const report = await runComparison(options({ "base-model": rejecting }, { cases: [makeCase("a")], candidates: [] }));
  assert.equal(report.spent_usd, 0);
});

test("an unknown price is refused unless overridden, and the override is stated", async () => {
  const opts = options({ "base-model": good, "mystery-model": good }, { cases: makeCases(6) });
  await assert.rejects(runComparison(opts), /price of mystery-model is not known.*budget override/);
  const report = await runComparison({ ...opts, allowUnknownPrices: true });
  assert.ok(report.limits.some((limit) => limit.includes("mystery-model") && limit.includes("override")));
});

test("candidates that break policy are refused before anything is spent", async () => {
  let calls = 0;
  const counting: Handler = (req, index) => { calls++; return good(req, index); };
  const run = (policy: RunOptions["policy"]): Promise<unknown> => runComparison(options({ "base-model": counting, "other-vendor": counting }, { policy }));
  await assert.rejects(run({ providers: ["acme"] }), /refused by policy.*othercorp/);
  await assert.rejects(run({ regions: ["us"] }), /allowed regions/);
  await assert.rejects(run({ licenses: ["commercial"] }), /allowed licenses/);
  await assert.rejects(run({ max_usd_per_million_output: 10 }), /above the policy limit/);
  assert.equal(calls, 0);
});

test("only accepted cases run, and none at all is a clear error", async () => {
  const drafts = makeCases(3).map((testCase): TestCase => ({ ...testCase, accepted: false, origin: "generated" }));
  await assert.rejects(runComparison(options({ "base-model": good }, { cases: drafts, candidates: [] })), /no accepted cases/);
  const seen = new Set<string>();
  const report = await runComparison(options({ "base-model": (req, index) => { seen.add(caseOf(req)); return good(req, index); } }, { cases: [...drafts, makeCase("real")], candidates: [] }));
  assert.deepEqual([...seen], ["real"]);
  assert.equal(report.case_count, 1);
});

test("replay stops at the last user message and ignores later logged turns", () => {
  const logged = [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: "old reply" },
    { role: "user" as const, content: "two" },
    { role: "assistant" as const, content: "logged final reply" },
    { role: "user" as const, content: "three" },
    { role: "assistant" as const, content: "should be cut" },
  ];
  assert.deepEqual(replayMessages(logged).map((m) => m.content), ["one", "old reply", "two", "logged final reply", "three"]);
});

test("replay keeps tool results a case supplies, and drops a logged reply after them", () => {
  const withTool = [
    { role: "user" as const, content: "go" },
    { role: "assistant" as const, content: "", tool_calls: [{ id: "1", name: "x", arguments: {} }] },
    { role: "tool" as const, content: "result", tool_call_id: "1" },
  ];
  assert.equal(replayMessages(withTool).length, 3);
  assert.equal(replayMessages([...withTool, { role: "assistant" as const, content: "logged" }]).length, 1);
  assert.equal(replayMessages([withTool[0]!, withTool[1]!]).length, 1);
});

test("the provider never receives logged turns past the decision point", async () => {
  let lastMessages: ProviderRequest["messages"] = [];
  const testCase = makeCase("multi", undefined, { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, { role: "assistant", content: "later" }] });
  await runComparison(options({ "base-model": (req) => { lastMessages = req.messages; return { text: "{}" }; } }, { cases: [testCase], candidates: [] }));
  assert.deepEqual(lastMessages.map((m) => m.content), ["a", "b", "c"]);
});

test("tool calls are recorded by checks and never executed", async () => {
  let fnExecuted = false;
  const testCase = makeCase("tool", [{ type: "tool_called", name: "dangerous" }], { tools: [{ name: "dangerous", parameters: { type: "object" } }] });
  const report = await runComparison(options({ "base-model": () => ({ text: "", tool_calls: [{ id: "1", name: "dangerous", arguments: { execute: () => { fnExecuted = true; } } }] }) }, { cases: [testCase], candidates: [] }));
  assert.equal(fnExecuted, false);
  assert.equal(report.runs[0]!.passed, true);
});

test("a served-model mismatch is added to the limits; dated aliases are not", async () => {
  const mismatch: Handler = (req, index) => ({ ...good(req, index), served_model: "different-model" });
  const report = await runComparison(options({ "base-model": good, "cand-model": mismatch }, { cases: makeCases(6) }));
  assert.ok(report.limits.some((limit) => limit.includes("cand-model -> different-model")));
  assert.equal(report.runs.find((run) => run.model === "cand-model")!.served_model, "different-model");

  const dated: Handler = (req, index) => ({ ...good(req, index), served_model: `${req.model}-2026-01-15` });
  const aliasReport = await runComparison(options({ "base-model": dated }, { cases: makeCases(1), candidates: [] }));
  assert.ok(!aliasReport.limits.some((limit) => limit.includes("different model")));
});

test("parameters a provider dropped are recorded in the limits", async () => {
  const report = await runComparison(options({ "base-model": () => ({ text: "{}", dropped_params: ["temperature"] } as Partial<ProviderResponse>) }, { cases: makeCases(1), candidates: [] }));
  assert.ok(report.limits.some((limit) => limit.includes("base-model: temperature")));
});

test("vendors seen lists the companies that received data, including the judge", async () => {
  const judge = Object.assign(createMockProvider(() => ({ text: '{"pass":true}' })), { model: "judge-model" });
  const cases = [makeCase("a", [{ type: "meaning" }])];
  const report = await runComparison(options({ "base-model": good, "other-vendor": good }, { cases, judge }));
  assert.deepEqual(report.vendors_seen, ["acme", "othercorp"]);
});

test("meaning checks are skipped with no judge and that is stated", async () => {
  const report = await runComparison(options({ "base-model": () => ({ text: "x" }), "cand-model": () => ({ text: "x" }) }, { cases: [makeCase("a", [{ type: "meaning" }])] }));
  assert.ok(report.limits.some((limit) => /meaning checks were skipped because no judge/.test(limit)));
  assert.equal(report.candidates[0]!.verdict, "NOT_ENOUGH_EVIDENCE");
});

test("judge calls are charged to the budget", async () => {
  let judgeCalls = 0;
  const judge = Object.assign(createMockProvider(() => { judgeCalls++; return { text: '{"pass":true}', usage: { input_tokens: 100, output_tokens: 100 } }; }), { model: "judge-model" });
  const report = await runComparison(options({ "base-model": () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 } }) }, { cases: [makeCase("a", [{ type: "meaning" }])], candidates: [], judge }));
  assert.equal(judgeCalls, 10);
  const modelCost = report.runs.reduce((total, run) => total + run.cost_usd, 0);
  assert.ok(report.spent_usd > modelCost);
});

test("a judge with no listed price needs the override", async () => {
  const judge = createMockProvider(() => ({ text: '{"pass":true}' }));
  await assert.rejects(runComparison(options({ "base-model": good }, { cases: [makeCase("a")], candidates: [], judge })), /price of the judge model/);
});

test("a missing key fails before anything is spent", async () => {
  let calls = 0;
  await assert.rejects(runComparison({
    ...options({ "base-model": good, "cand-model": good }),
    providerFor: (model) => {
      if (model === "cand-model") throw new Error("Set OPENAI_API_KEY");
      return createMockProvider(() => { calls++; return { text: "{}" }; });
    },
  }), /OPENAI_API_KEY/);
  assert.equal(calls, 0);
});

test("reports always list the coverage limits", async () => {
  const report = await runComparison(options({ "base-model": good }, { cases: makeCases(1), candidates: [] }));
  assert.ok(report.limits.some((limit) => /Only the 1 case tested/.test(limit)));
  assert.ok(report.limits.some((limit) => /cannot see changes to a consumer product/.test(limit)));
});

test("stale registries are noted in the limits", async () => {
  const report = await runComparison(options({ "base-model": good }, { cases: makeCases(1), candidates: [], registryGeneratedAt: "2026-10-01T00:00:00Z" }));
  assert.ok(report.limits.some((limit) => /days old/.test(limit)));
});

test("results reproduce for the same inputs", async () => {
  const random = (): Handler => {
    const counters = new Map<string, number>();
    return (req) => {
      const key = caseOf(req);
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return count % 3 === 0 ? { text: "bad" } : { text: "{}" };
    };
  };
  const a = await runComparison(options({ "base-model": random(), "cand-model": random() }, { concurrency: 1 }));
  const b = await runComparison(options({ "base-model": random(), "cand-model": random() }, { concurrency: 1 }));
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.id, b.id);
});

test("verdict wording never claims safety or improvement", () => {
  const base = { caseCount: 10, evaluatedCases: 10, confirmedCases: 0, suiteConfirmed: false, errorRate: 0, baselineErrorRate: 0, unfinished: false, changeSignals: [] };
  const inputs = [
    base,
    { ...base, confirmedCases: 2 },
    { ...base, suiteConfirmed: true },
    { ...base, errorRate: 0.5 },
    { ...base, baselineErrorRate: 0.5 },
    { ...base, unfinished: true },
    { ...base, evaluatedCases: 2 },
    { ...base, changeSignals: [{ key: "tokens", p: 0.001, description: "Output length differs" }] },
  ];
  for (const input of inputs) {
    const { reason } = decideCandidateVerdict(input);
    assert.doesNotMatch(reason, /\b(safe|safely|better|improved|guarantee)/i, reason);
  }
});

test("verdict precedence follows the design", () => {
  const base = { caseCount: 10, evaluatedCases: 10, confirmedCases: 0, suiteConfirmed: false, errorRate: 0, baselineErrorRate: 0, unfinished: false, changeSignals: [] as Array<{ key: string; p: number; description: string }> };
  assert.equal(decideCandidateVerdict(base).verdict, "NO_CHANGE_DETECTED");
  assert.equal(decideCandidateVerdict({ ...base, changeSignals: [{ key: "x", p: 0, description: "d" }] }).verdict, "CHANGED");
  assert.equal(decideCandidateVerdict({ ...base, confirmedCases: 1, changeSignals: [{ key: "x", p: 0, description: "d" }] }).verdict, "REGRESSED");
  assert.equal(decideCandidateVerdict({ ...base, confirmedCases: 1, unfinished: true }).verdict, "REGRESSED");
  assert.equal(decideCandidateVerdict({ ...base, confirmedCases: 1, errorRate: 0.3 }).verdict, "NOT_ENOUGH_EVIDENCE");
  assert.equal(decideCandidateVerdict({ ...base, unfinished: true }).verdict, "NOT_ENOUGH_EVIDENCE");
  assert.equal(decideCaseVerdict({ complete: true, confirmed: false, escalated: true, confirmationComplete: false, qValue: 1 }), "NOT_ENOUGH_EVIDENCE");
  assert.equal(decideCaseVerdict({ complete: true, confirmed: false, escalated: true, confirmationComplete: true, qValue: 0.05 }), "CHANGED");
});

test("the ledger settles to actual cost and keeps worst case for unknown billing", () => {
  const ledger = new BudgetLedger(1);
  const first = ledger.reserve(0.5);
  ledger.settle(first, 0.1);
  assert.ok(Math.abs(ledger.spentUsd - 0.1) < 1e-12);
  const second = ledger.reserve(0.5);
  ledger.keepWorstCase(second);
  assert.ok(Math.abs(ledger.spentUsd - 0.6) < 1e-12);
  assert.equal(ledger.unknownBillingUsd, 0.5);
  assert.throws(() => ledger.reserve(0.5), /budget was reached/);
});

test("estimateMaxCost includes noise, confirmation and retries", () => {
  const cases = makeCases(2);
  const noNoise = estimateMaxCost({ cases, models: ["base-model", "cand-model"], runs: 5, snapshot, includeNoise: false });
  const withNoise = estimateMaxCost({ cases, models: ["base-model", "cand-model"], runs: 5, snapshot, includeNoise: true });
  assert.equal(withNoise.max_calls, 2 * 5 * (3 + 2) * 3);
  assert.equal(noNoise.max_calls, 2 * 5 * (2 + 2) * 3);
  assert.ok(withNoise.max_usd > noNoise.max_usd);
  assert.deepEqual(withNoise.unknown_prices, []);
  assert.ok(withNoise.lines.some((line) => /retried/.test(line)));
});

test("estimateMaxCost ignores unaccepted cases and lists unknown prices", () => {
  const drafts = makeCases(2).map((testCase) => ({ ...testCase, accepted: false }));
  const estimate = estimateMaxCost({ cases: [...drafts, makeCase("x")], models: ["base-model", "mystery"], runs: 1, snapshot, includeNoise: true });
  assert.deepEqual(estimate.unknown_prices, ["mystery"]);
  assert.equal(estimate.max_calls, (3 + 2) * 3);
  assert.ok(estimate.lines.some((line) => /cannot be bounded/.test(line)));
});

test("the worst case uses the stated default when a case sets no max_tokens", () => {
  const withDefault = worstCaseUsd({ messages: [] }, { input: 0, output: 1_000_000 });
  assert.equal(withDefault, 1024);
});
