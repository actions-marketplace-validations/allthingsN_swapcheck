/**
 * Calibration of the whole method through the real runner, with the mock provider and seeded noise.
 *
 * The rate mix and the targeted scenarios were set before the method was tuned. One scenario that
 * still misses the target (a single 0.6 drop in a 10-case suite) is reported at the end of this
 * file instead of being targeted or removed. A run ending in NOT_ENOUGH_EVIDENCE never counts as
 * a catch or as a clean result, so declining to answer cannot improve the numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Check, ProviderRequest, RegistrySnapshot, SwapReport, TestCase } from "../src/types.ts";
import { createMockProvider } from "../src/providers/index.ts";
import { runComparison } from "../src/testing/runner.ts";
import { seededRandom } from "../src/testing/stats.ts";

const FALSE_ALARM_TARGET = 0.05;
const DETECTION_TARGET = 0.8;
const NULL_SUITES = 1000;
const REGRESSION_SUITES = 400;
const RUNS = 5;

const snapshot: RegistrySnapshot = {
  version: 1, generated_at: "2026-11-08T00:00:00Z", events: [],
  models: ["baseline", "candidate"].map((id) => ({
    id, provider: "acme", route: "acme-api", name: id, status: "active" as const,
    capabilities: { tools: true, structured_output: true, reasoning: false, vision: false, audio: false, pdf: false },
    limit: { context: 100000, output: 4096 }, cost: { input: 1, output: 2 }, source: "calibration",
  })),
};

/** Most cases are stable, some are flaky, a few are noisy. */
function drawBaseRate(random: () => number): number {
  const u = random();
  if (u < 0.6) return 0.97 + random() * 0.03;
  if (u < 0.9) return 0.85 + random() * 0.12;
  return 0.6 + random() * 0.25;
}

interface SimCase { id: string; base: number; candidate: number; usesTool: boolean; tokens: number }

function buildSuite(random: () => number, size: number, seeded: number, drop: number): SimCase[] {
  const cases: SimCase[] = Array.from({ length: size }, (_, index) => {
    const base = drawBaseRate(random);
    return { id: `c${index}`, base, candidate: base, usesTool: random() < 0.3, tokens: 40 + Math.floor(random() * 200) };
  });
  const remaining = [...cases];
  for (let i = 0; i < seeded; i++) {
    const [picked] = remaining.splice(Math.floor(random() * remaining.length), 1);
    picked!.candidate = Math.max(0, picked!.base - drop);
  }
  return cases;
}

function toTestCase(sim: SimCase): TestCase {
  const checks: Check[] = [{ type: "json_valid" }];
  if (sim.usesTool) checks.push({ type: "tool_called", name: "lookup" });
  return { id: sim.id, origin: "team", accepted: true, messages: [{ role: "user", content: sim.id }], checks, max_tokens: 512 };
}

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function behavior(byId: Map<string, SimCase>, rateOf: (sim: SimCase) => number, random: () => number) {
  return (req: ProviderRequest) => {
    const sim = byId.get(req.messages[req.messages.length - 1]!.content)!;
    const pass = random() < rateOf(sim);
    const outputTokens = Math.max(1, Math.round(sim.tokens * Math.exp(0.25 * gaussian(random))));
    return {
      text: pass ? '{"ok":true}' : "not json at all",
      tool_calls: pass && sim.usesTool ? [{ id: "1", name: "lookup", arguments: {} }] : [],
      usage: { input_tokens: 20, output_tokens: outputTokens },
      latency_ms: 100 + random() * 50,
    };
  };
}

async function simulate(seed: number, size: number, seeded: number, drop: number): Promise<{ report: SwapReport; seededIds: Set<string> }> {
  const random = seededRandom(seed);
  const suite = buildSuite(random, size, seeded, drop);
  const byId = new Map(suite.map((sim) => [sim.id, sim]));
  const providers = {
    baseline: createMockProvider(behavior(byId, (sim) => sim.base, random), "baseline"),
    candidate: createMockProvider(behavior(byId, (sim) => sim.candidate, random), "candidate"),
  };
  const report = await runComparison({
    baseline: "baseline", candidates: ["candidate"], cases: suite.map(toTestCase), runs: RUNS, budgetUsd: 1000,
    snapshot, registryGeneratedAt: snapshot.generated_at, providerFor: (model) => providers[model as "baseline" | "candidate"], concurrency: 1,
    now: new Date("2026-11-09T00:00:00Z"),
  });
  return { report, seededIds: new Set(suite.filter((sim) => sim.candidate !== sim.base).map((sim) => sim.id)) };
}

interface Tally { suites: number; regressed: number; changed: number; noEvidence: number; clean: number; caught: number; seededTotal: number; seededConfirmed: number }

async function tally(suites: number, seedBase: number, size: number, seeded: number, drop: number): Promise<Tally> {
  const t: Tally = { suites, regressed: 0, changed: 0, noEvidence: 0, clean: 0, caught: 0, seededTotal: 0, seededConfirmed: 0 };
  for (let index = 0; index < suites; index++) {
    const { report, seededIds } = await simulate(seedBase + index, size, seeded, drop);
    const candidate = report.candidates[0]!;
    if (candidate.verdict === "REGRESSED") t.regressed++;
    if (candidate.verdict === "CHANGED") t.changed++;
    if (candidate.verdict === "NOT_ENOUGH_EVIDENCE") t.noEvidence++;
    if (candidate.verdict === "NO_CHANGE_DETECTED") t.clean++;
    const confirmedSeeded = candidate.cases.filter((row) => row.confirmed && seededIds.has(row.case_id)).length;
    t.seededTotal += seededIds.size;
    t.seededConfirmed += confirmedSeeded;
    // A catch must point at a seeded case, or be a confirmed suite-wide drop on an all-case regression.
    const suiteWide = seeded === size && candidate.verdict === "REGRESSED";
    if (candidate.verdict === "REGRESSED" && (confirmedSeeded > 0 || suiteWide)) t.caught++;
  }
  return t;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

for (const size of [10, 20, 40]) {
  test(`false alarms on a model versus itself stay under 5% (${size} cases)`, { timeout: 600_000 }, async () => {
    const suites = size === 40 ? NULL_SUITES / 2 : NULL_SUITES;
    const t = await tally(suites, 1_000_000 + size * 1000, size, 0, 0);
    const falseAlarms = (t.regressed + t.changed) / t.suites;
    console.log(`[calibration] null ${size} cases: false alarms ${pct(falseAlarms)} (REGRESSED ${pct(t.regressed / t.suites)}, CHANGED ${pct(t.changed / t.suites)}), NOT_ENOUGH_EVIDENCE ${pct(t.noEvidence / t.suites)}, NO_CHANGE_DETECTED ${pct(t.clean / t.suites)} over ${t.suites} suites`);
    assert.ok(falseAlarms < FALSE_ALARM_TARGET, `false-alarm rate ${pct(falseAlarms)}`);
    assert.ok(t.noEvidence / t.suites < 0.02, "the clean result must come from measuring, not from declining to answer");
  });
}

const SCENARIOS: Array<{ name: string; size: number; seeded: number; drop: number }> = [
  { name: "1 of 20 cases drops 0.8", size: 20, seeded: 1, drop: 0.8 },
  { name: "2 of 20 cases drop 0.7", size: 20, seeded: 2, drop: 0.7 },
  { name: "4 of 20 cases drop 0.6", size: 20, seeded: 4, drop: 0.6 },
  { name: "all 20 cases drop 0.3", size: 20, seeded: 20, drop: 0.3 },
  { name: "1 of 10 cases drops 0.8", size: 10, seeded: 1, drop: 0.8 },
  { name: "2 of 10 cases drop 0.7", size: 10, seeded: 2, drop: 0.7 },
  { name: "all 10 cases drop 0.3", size: 10, seeded: 10, drop: 0.3 },
  { name: "1 of 40 cases drops 0.8", size: 40, seeded: 1, drop: 0.8 },
  { name: "4 of 40 cases drop 0.6", size: 40, seeded: 4, drop: 0.6 },
];

SCENARIOS.forEach((scenario, index) => {
  test(`seeded regressions are caught at least 80% of the time: ${scenario.name}`, { timeout: 600_000 }, async () => {
    const suites = scenario.size === 40 ? REGRESSION_SUITES / 2 : REGRESSION_SUITES;
    const t = await tally(suites, 2_000_000 + index * 100_000, scenario.size, scenario.seeded, scenario.drop);
    console.log(`[calibration] ${scenario.name}: caught ${pct(t.caught / t.suites)} of ${t.suites} suites; per-seeded-case recall ${pct(t.seededConfirmed / t.seededTotal)}; NOT_ENOUGH_EVIDENCE ${pct(t.noEvidence / t.suites)}`);
    assert.ok(t.caught / t.suites >= DETECTION_TARGET, `caught ${pct(t.caught / t.suites)}`);
  });
});

test("reported, not targeted: one moderate drop in a small suite", { timeout: 600_000 }, async () => {
  const t = await tally(REGRESSION_SUITES, 3_000_000, 10, 1, 0.6);
  console.log(`[calibration] KNOWN LIMIT 1 of 10 cases drops 0.6: caught ${pct(t.caught / t.suites)} of ${t.suites} suites`);
  assert.ok(t.caught / t.suites > 0.4);
});
