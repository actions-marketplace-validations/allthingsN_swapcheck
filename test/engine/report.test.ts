import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CandidateResult, ExposureItem, SwapReport } from "../../src/types.ts";
import { exitCodeFor, renderMarkdown, renderSarifExposure, renderSarifReport, saveReport } from "../../src/report/index.ts";
import { escapeMarkdown } from "../../src/report/markdown.ts";
import { createMockProvider } from "../../src/providers/index.ts";
import { runComparison } from "../../src/testing/runner.ts";
import { validateJsonSchema } from "../../src/testing/checks.ts";
import { makeCases, snapshot } from "./helpers.ts";

const metric = { baseline: 100, candidate: 120, delta: 0.2, ci95: [1, 2] as [number, number] };

function candidate(extra: Partial<CandidateResult> = {}): CandidateResult {
  return {
    model: "cand-model", verdict: "NO_CHANGE_DETECTED", reason: "No difference beyond the measured noise was detected.", cases: [],
    suite_pass_rate: { baseline: 0.9, candidate: 0.8, ci95: [-0.2, 0], p_value: 0.04 }, latency_ms_p50: metric, cost_usd_per_case: metric, error_rate: 0, spent_usd: 1, ...extra,
  };
}

function report(extra: Partial<SwapReport> = {}): SwapReport {
  return {
    schema: "swapcheck.report/v1", id: "2026-11-09-abc", created_at: "2026-11-09T00:00:00.000Z", swapcheck_version: "0.1.0", registry_generated_at: "2026-11-08",
    baseline_model: "base-model", runs_per_case: 5, case_count: 12, case_origins: { team: 12, trace: 0, imported: 0, generated: 0 },
    noise: { false_change_rate: 0, flagged_cases: 0 }, candidates: [candidate()], spent_usd: 1.5, budget_usd: 5, stopped_early: false, vendors_seen: ["acme"],
    limits: ["Only the 12 cases tested are covered."], runs: [], ...extra,
  };
}

test("Markdown has a candidate table with deltas and then limits", () => {
  const markdown = renderMarkdown(report());
  assert.match(markdown, /\| Candidate \| Verdict \| Pass rate \| Cost per run \| Latency p50 \|/);
  assert.match(markdown, /NO CHANGE DETECTED/);
  assert.match(markdown, /90\.0% to 80\.0%/);
  assert.match(markdown, /\+20\.0%/);
  assert.ok(markdown.indexOf("### Limits") > markdown.indexOf("| Candidate |"));
});

test("Markdown wording never claims the candidate is safe", () => {
  assert.doesNotMatch(renderMarkdown(report()), /\b(safe|better|guarantee)/i);
});

test("Markdown neutralizes links, HTML, mentions and table breaks from models and cases", () => {
  const hostile = "[click](https://evil.example) <img src=x onerror=alert(1)> @octocat #777 www.evil.example | owner/repo#333 deadbeefcafe ![x](y) `code`\n## heading";
  const markdown = renderMarkdown(report({
    baseline_model: hostile,
    limits: [hostile],
    candidates: [candidate({ model: hostile, reason: hostile, verdict: "REGRESSED", cases: [{ case_id: hostile, case_hash: "x", baseline_passes: 10, baseline_runs: 10, candidate_passes: 0, candidate_runs: 5, p_value: 0.001, q_value: 0.01, confirmed: true, verdict: "REGRESSED", failed_checks: [] }] })],
  }));
  for (const forbidden of ["](", "<img", "@octocat", "&#64;octocat", "https://", "www.evil", "![", "#777", "&#35;777", "repo#333", "deadbeefcafe", "`code`", "\n## heading"]) {
    assert.ok(!markdown.includes(forbidden), `found ${forbidden}`);
  }
  const row = markdown.split("\n").find((line) => line.includes("REGRESSED") && line.startsWith("|"))!;
  assert.equal(row.split("|").length - 2, 5, "a pipe in untrusted text must not add a table column");
});

test("escapeMarkdown redacts secrets and caps length", () => {
  assert.ok(!escapeMarkdown("key sk-ant-abcdefghijklmnop").includes("sk-ant"));
  assert.ok(escapeMarkdown("z".repeat(500)).length <= 120);
});

test("Markdown shows baseline-only reports without a table", () => {
  assert.match(renderMarkdown(report({ candidates: [] })), /Baseline only/);
});

test("SARIF for exposure is valid 2.1.0 with locations and levels", () => {
  const items: ExposureItem[] = [
    { model: "m1", route: "r", locations: [{ file: "src\\a.ts", line: 3 }], events: [], status: "retired" },
    { model: "m2", route: "r", locations: [{ file: "b.py", line: 9 }], events: [], status: "retiring", days_until: 12 },
    { model: "m3", route: "r", locations: [], events: [], status: "unknown" },
    { model: "ok", route: "r", locations: [{ file: "c.py", line: 1 }], events: [], status: "ok" },
  ];
  const sarif = renderSarifExposure(items) as { version: string; $schema: string; runs: Array<{ tool: { driver: { name: string; rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; level: string; message: { text: string }; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }> }> }> };
  assert.equal(sarif.version, "2.1.0");
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  const [run] = sarif.runs;
  assert.equal(run!.tool.driver.name, "swapcheck");
  assert.equal(run!.results.length, 3);
  assert.equal(run!.results[0]!.level, "error");
  assert.equal(run!.results[1]!.level, "warning");
  assert.equal(run!.results[2]!.ruleId, "model-unknown");
  assert.equal(run!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri, "src/a.ts");
  assert.match(run!.results[1]!.message.text, /12 days/);
  const ruleIds = new Set(run!.tool.driver.rules.map((rule) => rule.id));
  assert.ok(run!.results.every((result) => ruleIds.has(result.ruleId)));
});

test("SARIF for reports maps every verdict to a declared rule", () => {
  const verdicts: CandidateResult["verdict"][] = ["REGRESSED", "CHANGED", "NOT_ENOUGH_EVIDENCE", "NO_CHANGE_DETECTED"];
  const sarif = renderSarifReport(report({ candidates: verdicts.map((verdict) => candidate({ verdict })) })) as { runs: Array<{ tool: { driver: { rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; level: string; locations: unknown[] }> }> };
  const [run] = sarif.runs;
  const ruleIds = new Set(run!.tool.driver.rules.map((rule) => rule.id));
  assert.deepEqual(run!.results.map((result) => result.level), ["error", "warning", "warning", "note"]);
  assert.ok(run!.results.every((result) => ruleIds.has(result.ruleId) && result.locations.length === 1));
});

test("exit codes follow the design", () => {
  assert.equal(exitCodeFor(report()), 0);
  assert.equal(exitCodeFor(report({ candidates: [candidate({ verdict: "CHANGED" })] })), 0);
  assert.equal(exitCodeFor(report({ candidates: [candidate({ verdict: "REGRESSED" })] })), 1);
  assert.equal(exitCodeFor(report({ candidates: [candidate({ verdict: "NOT_ENOUGH_EVIDENCE" })] })), 3);
  assert.equal(exitCodeFor(report({ stopped_early: true })), 3);
  assert.equal(exitCodeFor(report({ stopped_early: true, candidates: [candidate({ verdict: "REGRESSED" })] })), 1);
});

test("saveReport writes redacted JSON under swapcheck/reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swapcheck-report-"));
  const written = await saveReport(root, report({ limits: ["leak sk-ant-abcdefghijklmnop"] }));
  assert.equal(written, path.join("swapcheck", "reports", "2026-11-09-abc.json"));
  const stored = await readFile(path.join(root, written), "utf8");
  assert.ok(!stored.includes("sk-ant-abcdefghijklmnop"));
  assert.equal(JSON.parse(stored).schema, "swapcheck.report/v1");
  await rm(root, { recursive: true });
});

test("saveReport refuses an id that would escape the reports folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swapcheck-report-"));
  await assert.rejects(saveReport(root, report({ id: "../../../escape" })), /outside the project/);
  await rm(root, { recursive: true });
});

const schema: unknown = JSON.parse(readFileSync(new URL("../../docs/report.schema.json", import.meta.url), "utf8"));

test("a real report validates against docs/report.schema.json", async () => {
  const good = createMockProvider(() => ({ text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2 } }));
  const actual = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases: makeCases(8), runs: 3, budgetUsd: 10, snapshot, registryGeneratedAt: snapshot.generated_at, providerFor: () => good, includeText: true });
  const result = validateJsonSchema(JSON.parse(JSON.stringify(actual)), schema);
  assert.deepEqual(result.errors, []);
});

test("the schema rejects drift in the report shape", () => {
  assert.equal(validateJsonSchema({ ...report(), surprise: 1 }, schema).valid, false);
  const { limits: _limits, ...withoutLimits } = report();
  assert.equal(validateJsonSchema(withoutLimits, schema).valid, false);
  assert.equal(validateJsonSchema(report({ limits: [] }), schema).valid, true, "the subset validator does not cover minItems, so empty limits are enforced by the runner");
});
