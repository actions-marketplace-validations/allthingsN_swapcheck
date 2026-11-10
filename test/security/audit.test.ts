import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { gitDiff, log, runAction, sanitizeMarkdown, staleRegistryWarning } from "../../src/action/main.ts";
import { resolveRepo } from "../../src/bump/github.ts";
import { applyBump, planBump, type BumpPlan } from "../../src/bump/plan.ts";
import { saveCases } from "../../src/cases/load.ts";
import { importCases } from "../../src/cases/import/index.ts";
import { redactDeep, redactText } from "../../src/cases/redact.ts";
import { mdEscape } from "../../src/cli/output.ts";
import { writeLock } from "../../src/lock.ts";
import { callTool } from "../../src/mcp/tools.ts";
import { createMockProvider } from "../../src/providers/index.ts";
import { postJson } from "../../src/providers/shared.ts";
import { loadRegistry, validateSnapshot, type LoadRegistryOptions } from "../../src/registry/client.ts";
import { saveReport } from "../../src/report/index.ts";
import { lexJs } from "../../src/scan/lexer.ts";
import { scanProject, walkTokens, lexSource } from "../../src/scan/scan.ts";
import { compileSafeRegex, evaluateCheck, REGEX_TIME_LIMIT_MS } from "../../src/testing/checks.ts";
import { estimateMaxCost, priceOf } from "../../src/testing/budget.ts";
import { runComparison, type RunOptions } from "../../src/testing/runner.ts";
import type { Check, ProviderRequest, ProviderResponse, RegistryModel, RegistrySnapshot, SwapReport, TestCase } from "../../src/types.ts";
import { sha256 } from "../../src/util/hash.ts";
import { redactSecrets } from "../../src/util/redact.ts";
import { snapshot as coreSnapshot } from "../core/helpers.ts";
import { makeCase, makeCases, snapshot as engineSnapshot } from "../engine/helpers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function tempBase(): { base: string; root: string; done: () => void } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "swapcheck-audit-")));
  const root = path.join(base, "root");
  mkdirSync(root);
  return { base, root, done: () => rmSync(base, { recursive: true, force: true }) };
}

const onlyCase: TestCase = makeCase("one");
const posix = { skip: process.platform === "win32" };

// ---- 1: writes under the project root ----

test("audit 1: cases import refuses a planted symlink at the predictable file name", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    const suite = JSON.stringify({ version: 1, cases: [{ id: "a", messages: [{ role: "user", content: "hi" }], oracle: { kind: "json" } }] });
    writeFileSync(path.join(root, "suite.json"), suite);
    writeFileSync(path.join(base, "victim"), "ORIGINAL");
    const dir = path.join(root, "swapcheck/cases");
    mkdirSync(dir, { recursive: true });
    symlinkSync(path.join(base, "victim"), path.join(dir, `imported-modelbump-${sha256(suite).slice(0, 12)}.json`));
    await assert.rejects(importCases("modelbump", "suite.json", root, "swapcheck/cases"), /symbolic link/);
    assert.equal(readFileSync(path.join(base, "victim"), "utf8"), "ORIGINAL");
  } finally {
    done();
  }
});

test("audit 1: a report is never written through a planted symlink", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    writeFileSync(path.join(base, "victim"), "ORIGINAL");
    mkdirSync(path.join(root, "swapcheck/reports"), { recursive: true });
    symlinkSync(path.join(base, "victim"), path.join(root, "swapcheck/reports/r1.json"));
    await assert.rejects(saveReport(root, { id: "r1" } as SwapReport), /symbolic link/);
    assert.equal(readFileSync(path.join(base, "victim"), "utf8"), "ORIGINAL");
  } finally {
    done();
  }
});

test("audit 1: no folder is created outside the root through a symlinked parent", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    mkdirSync(path.join(base, "outside"));
    symlinkSync(path.join(base, "outside"), path.join(root, "swapcheck"));
    await assert.rejects(saveCases(root, "swapcheck/cases/deep", "x", [onlyCase]), /outside the project/);
    await assert.rejects(saveReport(root, { id: "r1" } as SwapReport), /outside the project/);
    assert.deepEqual(readdirSync(path.join(base, "outside")), []);
  } finally {
    done();
  }
});

test("audit 1: a dangling symlinked folder is refused, not created through", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    symlinkSync(path.join(base, "gone"), path.join(root, "swapcheck"));
    await assert.rejects(saveCases(root, "swapcheck/cases", "x", [onlyCase]), /outside the project/);
    assert.equal(existsSync(path.join(base, "gone")), false);
  } finally {
    done();
  }
});

test("audit 1: an atomic save replaces the file, keeps its mode and leaves no temp file", posix, async () => {
  const { root, done } = tempBase();
  try {
    await saveCases(root, "swapcheck/cases", "x", [onlyCase]);
    const file = path.join(root, "swapcheck/cases/x.json");
    chmodSync(file, 0o640);
    const inodeBefore = statSync(file).ino;
    await saveCases(root, "swapcheck/cases", "x", [makeCase("two")]);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.notEqual(statSync(file).ino, inodeBefore);
    assert.match(readFileSync(file, "utf8"), /"two"/);
    assert.deepEqual(readdirSync(path.dirname(file)), ["x.json"]);
  } finally {
    done();
  }
});

test("audit 1: models.lock is refused when it is any symlink", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    writeFileSync(path.join(root, "real.lock"), "ORIGINAL");
    symlinkSync(path.join(root, "real.lock"), path.join(root, "models.lock"));
    await assert.rejects(writeLock(root, { version: 1, models: [] }), /symbolic link/);
    assert.equal(readFileSync(path.join(root, "real.lock"), "utf8"), "ORIGINAL");
    assert.equal(existsSync(path.join(base, "outside")), false);
  } finally {
    done();
  }
});

test("audit 1: a bump refuses a source file that became a symlink after planning", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    writeFileSync(path.join(base, "victim.ts"), "before");
    symlinkSync(path.join(base, "victim.ts"), path.join(root, "a.ts"));
    const plan: BumpPlan = { from: "a", to: "b", rejected_params: [], skipped: [], lock: { version: 1, models: [] }, changes: [{ file: "a.ts", before: "before", after: "after", executable: false, replacements: 1, removed_params: [] }] };
    await assert.rejects(applyBump(root, plan), /symbolic link/);
    assert.equal(readFileSync(path.join(base, "victim.ts"), "utf8"), "before");
    assert.equal(lstatSync(path.join(root, "a.ts")).isSymbolicLink(), true);
  } finally {
    done();
  }
});

// ---- 2: model IDs reaching source ----

const PAYLOAD = `gpt-5"; require('child_process').execSync(process.env.PAYLOAD); "`;

function modelRow(id: string, overrides: Partial<RegistryModel> = {}): RegistryModel {
  return { id, provider: "acme", route: "acme-api", name: "M", status: "active", capabilities: { tools: true, structured_output: true, reasoning: false, vision: false, audio: false, pdf: false }, limit: { context: 1000, output: 100 }, cost: { input: 1, output: 2 }, source: "fixture", ...overrides } as RegistryModel;
}

const eventRow = (model: string, to?: string): unknown => ({ id: "e1", type: "reroute", provider: "acme", route: "acme-api", model, ...(to === undefined ? {} : { to }), source: "fixture", confidence: "high", first_seen: "2026-11-01", last_verified: "2026-11-01" });

test("audit 2: validateSnapshot rejects an injection payload in id, model or to", () => {
  const base = { version: 1, generated_at: "2026-11-01T00:00:00Z", models: [], events: [] };
  assert.ok(validateSnapshot({ ...base, events: [eventRow("gpt-4.1", "gpt-5")] }));
  assert.equal(validateSnapshot({ ...base, events: [eventRow("gpt-4.1", PAYLOAD)] }), null);
  assert.equal(validateSnapshot({ ...base, events: [eventRow(PAYLOAD)] }), null);
  assert.equal(validateSnapshot({ ...base, models: [modelRow(PAYLOAD)] }), null);
  assert.equal(validateSnapshot({ ...base, models: [modelRow("gpt-5\n")] }), null);
});

test("audit 2: real ID shapes from OpenRouter, Bedrock, Vertex and others still validate", () => {
  const ids = [
    "gpt-4.1", "o3-mini", "anthropic/claude-3.5-sonnet:beta", "openai/gpt-4o", "meta-llama/llama-3.3-70b-instruct:free", "~anthropic/claude-sonnet-latest",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "anthropic.claude-3-haiku-20240307-v1:0", "claude-3-5-sonnet@20240620", "publishers/google/models/gemini-1.5-pro@001",
    "projects/p/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet@20240620", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "accounts/fireworks/models/llama-v3p1-70b-instruct", "ft:gpt-4o-mini-2024-07-18:acme:name:abc123", "claude-sonnet-4-5[1m]", "models/gemini-2.5-flash", "@cf/meta/llama-3.1-8b-instruct",
  ];
  assert.ok(validateSnapshot({ version: 1, generated_at: "2026-11-01T00:00:00Z", events: ids.map((id) => eventRow("gpt-4.1", id)), models: ids.map((id) => modelRow(id)) }));
});

test("audit 2: planBump refuses a hostile target and writes nothing", async () => {
  const { root, done } = tempBase();
  try {
    writeFileSync(path.join(root, "app.ts"), 'create({ model: "gpt-4.1" })\n');
    const scan = await scanProject(root, coreSnapshot());
    await assert.rejects(planBump({ root, from: "gpt-4.1", to: PAYLOAD, snapshot: coreSnapshot(), scan }), /not a valid model ID/);
    assert.equal(readFileSync(path.join(root, "app.ts"), "utf8"), 'create({ model: "gpt-4.1" })\n');
  } finally {
    done();
  }
});

// ---- 3: regex ----

test("audit 3: a nested quantifier hidden after [^] is refused at compile time", () => {
  assert.throws(() => compileSafeRegex("[^](a+)+b]"), /nested quantifiers/);
  assert.throws(() => compileSafeRegex("[](a+)+"), /nested quantifiers/);
});

const regexResponse = (text: string): ProviderResponse => ({ text, tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 1, served_model: "m", finish_reason: "stop" });

test("audit 3: hostile patterns are stopped and recorded as skipped, never passed", async () => {
  const shapes: Array<[string, string]> = [
    ["^(a{1,100})+$", `${"a".repeat(40)}!`],
    ["^(a|\\x61)+$", `${"a".repeat(40)}!`],
    ["^(\\w|a)+$", `${"a".repeat(40)}!`],
    ["\\d+\\s*\\d+\\s*\\d+\\s*\\d+\\s*x", "1".repeat(20_000)],
  ];
  const started = performance.now();
  const outcomes = await Promise.all(shapes.map(([pattern, text]) => evaluateCheck({ type: "regex", pattern }, 0, regexResponse(text), { testCase: onlyCase })));
  assert.ok(performance.now() - started < REGEX_TIME_LIMIT_MS * 4, "the shapes ran past the limit");
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "skip");
    assert.match(outcome.detail ?? "", /did not finish/);
  }
});

test("audit 3: ordinary patterns still pass and fail", async () => {
  const pass = await evaluateCheck({ type: "regex", pattern: "^he.*o$", flags: "i" }, 0, regexResponse("HELLO"), { testCase: onlyCase });
  const fail = await evaluateCheck({ type: "regex", pattern: "^bye" }, 0, regexResponse("hello"), { testCase: onlyCase });
  assert.equal(pass.status, "pass");
  assert.equal(fail.status, "fail");
});

test("audit 3: a timed-out regex is listed in the report limits", async () => {
  const testCase = makeCase("one", [{ type: "regex", pattern: "\\d+\\s*\\d+\\s*\\d+\\s*\\d+\\s*x" }]);
  const provider = createMockProvider(() => ({ text: "1".repeat(20_000), usage: { input_tokens: 5, output_tokens: 5 } }));
  const report = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases: [testCase], runs: 1, budgetUsd: 100, snapshot: engineSnapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, concurrency: 4 });
  assert.ok(report.limits.some((limit) => /A check was skipped: A regex check did not finish/.test(limit)));
  assert.equal(report.candidates[0]!.cases[0]!.candidate_runs, 0, "a timed-out check must not count as a scored pass");
});

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });

test("audit 3: the time limit also stops the polynomial pattern under Bun", { skip: bun.status !== 0 && "bun is not installed" }, () => {
  const { base, done } = tempBase();
  try {
    const script = path.join(base, "probe.ts");
    const checks = path.join(REPO, "src/testing/checks.ts");
    writeFileSync(script, `import { testRegexWithTimeLimit } from ${JSON.stringify(checks)};\nconst r = await testRegexWithTimeLimit(/\\d+\\s*\\d+\\s*\\d+\\s*\\d+\\s*x/, "1".repeat(20000));\nconsole.log(typeof Bun !== "undefined" ? "bun" : "other", r);\n`);
    const started = performance.now();
    const result = spawnSync("bun", [script], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.stdout.trim(), "bun null", result.stderr);
    assert.ok(performance.now() - started < 10_000);
  } finally {
    done();
  }
});

// ---- 4: redirects ----

async function listen(handler: http.RequestListener): Promise<{ url: string; hits: () => number; close: () => void }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => count, close: () => server.close() };
}

test("audit 4: a provider redirect is not followed, is not retried, and says so", async () => {
  const other = await listen((_req, res) => res.end("{}"));
  const first = await listen((_req, res) => {
    res.writeHead(307, { location: `${other.url}/stolen` });
    res.end();
  });
  try {
    await assert.rejects(postJson(`${first.url}/v1/messages`, { "x-api-key": "secret" }, {}, { model: "m", messages: [] }, "TestLabel", { sleep: async () => {} }), /redirect.*API key/s);
    assert.equal(other.hits(), 0);
    assert.equal(first.hits(), 1);
  } finally {
    first.close();
    other.close();
  }
});

// ---- 5: route pricing ----

const twoRoutes = (): RegistrySnapshot => ({ version: 1, generated_at: "2026-11-08T00:00:00Z", events: [], models: [modelRow("dual", { route: "cheap", cost: { input: 0.01, output: 0.01 } }), modelRow("dual", { route: "dear", cost: { input: 60, output: 120 } }), modelRow("other", { route: "acme-api", cost: { input: 1, output: 2 } })] });

test("audit 5: price follows the route, and an unknown route gets the highest price", () => {
  assert.deepEqual(priceOf("dual", twoRoutes(), "dear"), { input: 60, output: 120 });
  assert.deepEqual(priceOf("dual", twoRoutes(), "cheap"), { input: 0.01, output: 0.01 });
  assert.deepEqual(priceOf("dual", twoRoutes(), "not-listed"), { input: 60, output: 120 });
  assert.deepEqual(priceOf("dual", twoRoutes()), { input: 60, output: 120 });
  assert.equal(priceOf("missing", twoRoutes()), undefined);
});

test("audit 5: the run budget is charged at the routed rate", async () => {
  const provider = createMockProvider(() => ({ text: '{"a":1}', usage: { input_tokens: 1000, output_tokens: 1000 } }));
  const report = await runComparison({ baseline: "dual", candidates: ["other"], cases: makeCases(1), runs: 1, budgetUsd: 100, snapshot: twoRoutes(), registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, routeFor: (model) => (model === "dual" ? "dear" : undefined), concurrency: 1 });
  assert.ok(report.spent_usd >= 2 * ((1000 * 60 + 1000 * 120) / 1_000_000) - 1e-9, `spent ${report.spent_usd}`);
});

test("audit 5: the announced maximum uses the routed price", () => {
  const dear = estimateMaxCost({ cases: makeCases(1), models: ["dual"], runs: 1, snapshot: twoRoutes(), includeNoise: false, routeFor: () => "dear" });
  const cheap = estimateMaxCost({ cases: makeCases(1), models: ["dual"], runs: 1, snapshot: twoRoutes(), includeNoise: false, routeFor: () => "cheap" });
  assert.ok(dear.max_usd > cheap.max_usd * 100);
});

// ---- 6: missing usage ----

for (const [label, usage] of [["zero", { input_tokens: 0, output_tokens: 0 }], ["negative", { input_tokens: -5, output_tokens: -5 }], ["non-numeric", { input_tokens: Number.NaN, output_tokens: "9" }], ["partly zero", { input_tokens: 10, output_tokens: 0 }]] as const) {
  test(`audit 6: ${label} usage keeps the worst-case charge`, async () => {
    const provider = createMockProvider(() => ({ text: '{"a":1}', usage: usage as unknown as ProviderResponse["usage"] }));
    const report = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases: makeCases(2), runs: 1, budgetUsd: 100, snapshot: engineSnapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, concurrency: 1 });
    assert.ok(report.spent_usd > 0, "the reservation was refunded");
    assert.ok(report.limits.some((limit) => /held at worst case/.test(limit)));
  });
}

test("audit 6: missing usage from the judge also keeps the worst-case charge", async () => {
  const provider = createMockProvider(() => ({ text: "ok", usage: { input_tokens: 5, output_tokens: 5 } }));
  const judge = Object.assign(createMockProvider(() => ({ text: '{"pass":true}', usage: { input_tokens: 0, output_tokens: 0 } })), { model: "base-model" });
  const testCase = makeCase("one", [{ type: "meaning" }]);
  const report = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases: [testCase], runs: 1, budgetUsd: 100, snapshot: engineSnapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, judge, concurrency: 1 });
  assert.ok(report.limits.some((limit) => /held at worst case/.test(limit)));
});

// ---- 7: MCP budget ----

function mcpProject(yaml: string): { root: string; done: () => void } {
  const { root, done } = tempBase();
  writeFileSync(path.join(root, "swapcheck.yaml"), yaml);
  mkdirSync(path.join(root, "swapcheck/cases"), { recursive: true });
  writeFileSync(path.join(root, "swapcheck/cases/a.json"), JSON.stringify({ version: 1, cases: [makeCase("one")] }));
  return { root, done };
}

const mcpContext = (cwd: string, extra: Record<string, string> = {}) => ({
  cwd, offline: true, registry: { snapshot: engineSnapshot, source: "bundled" as const, age_days: 0 },
  env: { SWAPCHECK_MCP_ALLOW_SPEND: "1", SWAPCHECK_OPENAI_BASE_URL: "http://127.0.0.1:1/v1", ...extra } as NodeJS.ProcessEnv,
});

test("audit 7: an agent cannot raise the MCP budget above the repo limit", async () => {
  const { root, done } = mcpProject("budget:\n  max_usd_per_run: 0.000001\n");
  try {
    const result = await callTool("test", { from: "base-model", to: ["cand-model"], max_usd: 1_000_000, runs: 1 }, mcpContext(root)) as { budget_usd: number; max_usd: number };
    assert.equal(result.budget_usd, 0.000001);
    assert.equal(result.max_usd, 0.000001);
  } finally {
    done();
  }
});

test("audit 7: SWAPCHECK_MCP_MAX_USD lowers the budget, and the agent can lower it further", async () => {
  const { root, done } = mcpProject("budget:\n  max_usd_per_run: 100\n");
  try {
    const capped = await callTool("test", { from: "base-model", to: ["cand-model"], max_usd: 50, runs: 1 }, mcpContext(root, { SWAPCHECK_MCP_MAX_USD: "2.5" })) as { budget_usd: number };
    assert.equal(capped.budget_usd, 2.5);
    const lower = await callTool("test", { from: "base-model", to: ["cand-model"], max_usd: 1, runs: 1 }, mcpContext(root, { SWAPCHECK_MCP_MAX_USD: "2.5" })) as { budget_usd: number };
    assert.equal(lower.budget_usd, 1);
  } finally {
    done();
  }
});

test("audit 7: an unreadable SWAPCHECK_MCP_MAX_USD refuses to run rather than ignoring the cap", async () => {
  const { root, done } = mcpProject("budget:\n  max_usd_per_run: 100\n");
  try {
    await assert.rejects(callTool("test", { from: "base-model", to: ["cand-model"], max_usd: 50 }, mcpContext(root, { SWAPCHECK_MCP_MAX_USD: "lots" })), /SWAPCHECK_MCP_MAX_USD/);
  } finally {
    done();
  }
});

// ---- 8: paid modes and events ----

async function captured(run: () => Promise<number> | void): Promise<{ code: number | void; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  // The test runner reports over stdout in binary, and that must still reach it.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk !== "string") return original(chunk);
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), out };
  } finally {
    process.stdout.write = original;
  }
}

async function actionUnder(eventName: string, mode: string): Promise<{ code: number | void; out: string }> {
  const { root, done } = tempBase();
  try {
    return await captured(() => runAction({ GITHUB_EVENT_NAME: eventName, GITHUB_WORKSPACE: root, INPUT_MODE: mode, "INPUT_MAX-USD": "1", SWAPCHECK_REGISTRY_URL: "http://127.0.0.1:1/none" }));
  } finally {
    done();
  }
}

for (const event of ["workflow_run", "issue_comment", "pull_request_target", "repository_dispatch", ""]) {
  for (const mode of ["check", "bump"]) {
    test(`audit 8: ${mode} is refused under ${event || "an empty event name"}`, async () => {
      const { code, out } = await actionUnder(event, mode);
      assert.equal(code, 2);
      assert.match(out, /refuses to run/);
    });
  }
}

for (const event of ["pull_request", "push", "schedule", "workflow_dispatch", "merge_group", "release"]) {
  test(`audit 8: check is not refused under ${event}`, async () => {
    assert.doesNotMatch((await actionUnder(event, "check")).out, /refuses to run/);
  });
}

// ---- 9: rollback and staleness ----

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signedSnapshot = (generated: string): { body: string; signature: string } => {
  const body = JSON.stringify({ version: 1, generated_at: generated, models: [], events: [] });
  return { body, signature: sign(null, Buffer.from(body), keys.privateKey).toString("base64") };
};
const REGISTRY_URL = "https://registry.test/snapshot.json";
const NOW = new Date("2026-11-09T00:00:00Z");
const OLD = "2024-01-01T00:00:00Z";
const NEW = "2026-11-08T00:00:00Z";

function registryFetch(file: { body: string; signature: string }): typeof fetch & { calls: () => number } {
  let calls = 0;
  const impl = (async (input: string | URL | Request) => {
    calls++;
    return new Response(String(input).endsWith(".sig") ? file.signature : file.body, { status: 200 });
  }) as typeof fetch & { calls: () => number };
  impl.calls = () => calls;
  return impl;
}

const registryOptions = (cacheDir: string, extra: LoadRegistryOptions): LoadRegistryOptions => ({ url: REGISTRY_URL, cacheDir, now: NOW, publicKeyPem, loadBundled: async () => JSON.parse(signedSnapshot(OLD).body), ...extra });

test("audit 9: a signed remote older than the bundled snapshot is rejected", async () => {
  const { root, done } = tempBase();
  try {
    const loaded = await loadRegistry(registryOptions(root, { fetchImpl: registryFetch(signedSnapshot(OLD)), loadBundled: async () => JSON.parse(signedSnapshot(NEW).body) }));
    assert.equal(loaded.source, "bundled");
    assert.equal(loaded.snapshot.generated_at, NEW);
  } finally {
    done();
  }
});

test("audit 9: a signed remote older than the cache is rejected and does not replace it", async () => {
  const { root, done } = tempBase();
  try {
    await loadRegistry(registryOptions(root, { fetchImpl: registryFetch(signedSnapshot(NEW)), now: new Date("2026-11-08T12:00:00Z") }));
    const later = new Date("2026-11-20T00:00:00Z");
    const loaded = await loadRegistry(registryOptions(root, { fetchImpl: registryFetch(signedSnapshot("2026-01-01T00:00:00Z")), now: later }));
    assert.equal(loaded.source, "cache");
    assert.equal(loaded.snapshot.generated_at, NEW);
    const again = await loadRegistry(registryOptions(root, { fetchImpl: registryFetch(signedSnapshot("2026-01-01T00:00:00Z")), now: later, offline: true }));
    assert.equal(again.snapshot.generated_at, NEW);
  } finally {
    done();
  }
});

test("audit 9: a planted fresh meta.json cannot pin an old signed cache", async () => {
  const { root, done } = tempBase();
  try {
    const dir = path.join(root, sha256(REGISTRY_URL).slice(0, 16));
    mkdirSync(dir, { recursive: true });
    const old = signedSnapshot(OLD);
    writeFileSync(path.join(dir, "snapshot.json"), old.body);
    writeFileSync(path.join(dir, "snapshot.json.sig"), old.signature);
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ fetched_at: NOW.toISOString() }));
    const fetchImpl = registryFetch(signedSnapshot(NEW));
    const loaded = await loadRegistry(registryOptions(root, { fetchImpl }));
    assert.equal(loaded.source, "remote");
    assert.equal(loaded.snapshot.generated_at, NEW);
    assert.ok(fetchImpl.calls() > 0);
  } finally {
    done();
  }
});

test("audit 9: the Action warns only for snapshots older than 7 days", () => {
  assert.match(staleRegistryWarning("2026-11-01T00:00:00Z", NOW) ?? "", /8 days old/);
  assert.equal(staleRegistryWarning("2026-11-02T00:00:01Z", NOW), undefined);
});

// ---- 10: scanner limits ----

const TWO_MB = 2 * 1024 * 1024;
const fill = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));
const lines = (text: string): string => `${text}${"\n".repeat(Math.ceil(text.length / 900))}`;

const hostile: Record<string, string> = {
  "regex-rescan.ts": lines(fill("/[", TWO_MB * 0.9)),
  "deep-strings.ts": lines(`${fill("(", 500_000)}\n${fill('"x",', 1_200_000)}`),
  "deep-brackets.py": lines(`${fill("[", 500_000)}\n${fill("'x',", 1_200_000)}`),
  "deep.json": lines(`${fill("[", 500_000)}\n${fill('"x",', 1_200_000)}`),
  // Nested unterminated templates used to decode the whole tail once per level and run out of memory.
  "templates.ts": lines(`${fill("`${", 1024)}${fill("\\a", 1_800_000)}`),
  "fstrings.py": lines(`${fill('f"{', 1536)}${fill("\\a", 1_800_000)}`),
};

for (const [name, source] of Object.entries(hostile)) {
  test(`audit 10: a 2 MB hostile ${name} finishes in a few seconds`, async () => {
    const { root, done } = tempBase();
    try {
      writeFileSync(path.join(root, name), source.slice(0, TWO_MB));
      const started = performance.now();
      const result = await scanProject(root, coreSnapshot());
      const seconds = (performance.now() - started) / 1000;
      assert.ok(seconds < 5, `took ${seconds.toFixed(1)}s`);
      assert.ok(result.unresolved.some((call) => call.file === name && /not checked/.test(call.reason)), "truncation was not reported");
    } finally {
      done();
    }
  });
}

test("audit 10: a failed regex is not rescanned on the same line", () => {
  const source = fill("/[", 200_000);
  const started = performance.now();
  const { tokens } = lexJs(source);
  assert.ok(performance.now() - started < 1000);
  assert.equal(tokens.some((token) => token.kind === "regex"), false);
});

test("audit 10: a regex on a later line is still recognised after a failure", () => {
  const { tokens } = lexJs('x = /[ never closes\ny = /ab+/g;\n');
  assert.ok(tokens.some((token) => token.kind === "regex" && token.value === "/ab+/g"));
});

test("audit 10: bracket depth is capped and the file is reported, keeping findings before it", async () => {
  const { root, done } = tempBase();
  try {
    writeFileSync(path.join(root, "a.ts"), `create({ model: "gpt-4.1" })\n${"(".repeat(300)}\ncreate({ model: "gpt-4o" })\n`);
    const result = await scanProject(root, coreSnapshot());
    assert.deepEqual(result.findings.map((finding) => finding.model), ["gpt-4.1"]);
    assert.ok(result.unresolved.some((call) => call.file === "a.ts" && /not checked/.test(call.reason)));
  } finally {
    done();
  }
});

test("audit 10: the per-file limit stops a walk and reports the file", () => {
  const lexed = lexSource("a.ts", `${"x;\n".repeat(5000)}`);
  const limits = { deadline: performance.now() - 1, truncated: false };
  walkTokens(lexed!.codeTokens, lexed!.lang, undefined, limits);
  assert.equal(limits.truncated, true);
});

test("audit 10: the whole-scan limit reports the first file not read", async () => {
  const { root, done } = tempBase();
  try {
    writeFileSync(path.join(root, "a.ts"), 'create({ model: "gpt-4.1" })\n');
    writeFileSync(path.join(root, "b.ts"), 'create({ model: "gpt-4.1" })\n');
    const result = await scanProject(root, coreSnapshot(), { scanTimeLimitMs: -1 });
    assert.equal(result.files_scanned, 0);
    assert.deepEqual(result.unresolved.map((call) => call.file), ["a.ts"]);
    assert.match(result.unresolved[0]!.reason, /time limit/);
  } finally {
    done();
  }
});

// ---- 11: announced maximum with a judge ----

test("audit 11: the announced maximum bounds a run with many meaning checks", async () => {
  const checks: Check[] = Array.from({ length: 200 }, () => ({ type: "meaning", rubric: "ok" }));
  const cases = [makeCase("one", checks, { max_tokens: 64 })];
  let judgeCalls = 0;
  let modelCalls = 0;
  const judge = Object.assign(createMockProvider((req: ProviderRequest) => {
    judgeCalls++;
    return { text: '{"pass":false}', usage: { input_tokens: Math.ceil(JSON.stringify(req.messages).length), output_tokens: 256 } };
  }), { model: "base-model" });
  const provider = createMockProvider(() => {
    modelCalls++;
    return { text: "x".repeat(4000), usage: { input_tokens: 64, output_tokens: 64 } };
  });
  const estimate = estimateMaxCost({ cases, models: ["base-model", "cand-model"], runs: 5, snapshot: engineSnapshot, includeNoise: true, judge: "base-model" });
  const report = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases, runs: 5, budgetUsd: 1000, snapshot: engineSnapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, judge, concurrency: 4 });
  assert.ok(judgeCalls > 0);
  assert.ok(judgeCalls + modelCalls <= estimate.max_calls, `${judgeCalls + modelCalls} calls, announced ${estimate.max_calls}`);
  assert.ok(report.spent_usd <= estimate.max_usd, `spent ${report.spent_usd}, announced ${estimate.max_usd}`);
  assert.equal(estimate.max_calls, (5 * 3 + 5 * 2) * 201 * 3);
});

test("audit 11: a judge with no listed price is reported as unknown", () => {
  const estimate = estimateMaxCost({ cases: [makeCase("one", [{ type: "meaning" }])], models: ["base-model"], runs: 1, snapshot: engineSnapshot, includeNoise: false, judge: "mystery-judge" });
  assert.deepEqual(estimate.unknown_prices, ["mystery-judge"]);
});

test("audit 11: the judge sees at most the bounded part of an answer", async () => {
  let sent = 0;
  const outcome = await evaluateCheck({ type: "meaning" }, 0, regexResponse("x".repeat(100_000)), {
    testCase: makeCase("one", [{ type: "meaning" }], { max_tokens: 10 }),
    callJudge: async (_system, user) => {
      sent = user.length;
      return '{"pass":true}';
    },
  });
  assert.equal(outcome.status, "pass");
  assert.ok(sent < 1000, `sent ${sent} characters`);
});

// ---- 12: deep JSON ----

test("audit 12: JSON nested past the stack limit becomes a skip and the run finishes", async () => {
  const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
  const testCase = makeCase("one", [{ type: "json_schema", schema: { enum: [[1]] } }, { type: "no_refusal" }]);
  const provider = createMockProvider(() => ({ text: deep, usage: { input_tokens: 5, output_tokens: 5 } }));
  const report = await runComparison({ baseline: "base-model", candidates: ["cand-model"], cases: [testCase], runs: 1, budgetUsd: 100, snapshot: engineSnapshot, registryGeneratedAt: "2026-11-08T00:00:00Z", providerFor: () => provider, concurrency: 1 });
  assert.equal(report.candidates.length, 1);
  assert.ok(report.limits.some((limit) => /A json_schema check could not be evaluated/.test(limit)));
  assert.equal(report.runs.every((run) => run.error === undefined), true);
});

// ---- 13: redaction ----

test("audit 13: redaction reaches object keys, at any depth", () => {
  const { value, count } = redactDeep({ a: { "jane.doe@corp.com": { note: "call jane.doe@corp.com" }, "sk-ant-abcdefghijklmnop": 1 } }, {});
  const text = JSON.stringify(value);
  assert.ok(!text.includes("jane.doe"));
  assert.ok(!text.includes("sk-ant"));
  assert.ok(count >= 3);
});

test("audit 13: keys that redact to the same text are all kept", () => {
  const { value } = redactDeep({ "a@corp.com": 1, "b@corp.com": 2 }, {});
  assert.deepEqual(Object.values(value).sort(), [1, 2]);
});

test("audit 13: more provider key prefixes are redacted", () => {
  for (const secret of ["gsk_abcdefghijklmnopqrstuvwxyz012345", "xai-abcdefghijklmnopqrstuvwxyz0123456789", "hf_abcdefghijklmnopqrstuvwxyz012345", "r8_abcdefghijklmnopqrstuvwxyz012345", "pplx-abcdefghijklmnopqrstuvwxyz012345", "fw_abcdefghijklmnopqrstuvwx", "nvapi-abcdefghijklmnopqrstuvwxyz012345", "csk-abcdefghijklmnopqrstuvwxyz012345", "tgp_v1_abcdefghijklmnopqrstuvwxyz012345", "glpat-abcdefghijklmnopqrstuvwx", "sk_live_abcdefghijklmnopqrst", "npm_abcdefghijklmnopqrstuvwxyz012345", "ASIAABCDEFGHIJKLMNOP"]) {
    assert.equal(redactText(secret, {}).value, "[REDACTED]", secret);
    assert.equal(redactSecrets(`key=${secret}`, {}), "key=[REDACTED]", secret);
  }
});

test("audit 13: model IDs are not mistaken for keys", () => {
  for (const id of ["xai-grok-4-fast", "hf_model", "gpt-4.1", "accounts/fireworks/models/llama-v3p1-70b-instruct"]) assert.equal(redactSecrets(id, {}), id);
});

// ---- 14: Markdown escaping ----

test("audit 14: mdEscape stops links, mentions and issue references", () => {
  const out = mdEscape("https://evil.example/login @octocat #123 www.evil.example");
  assert.ok(!out.includes("https:"));
  assert.ok(!out.includes("www."));
  assert.ok(!out.includes("@"));
  assert.ok(!/#123/.test(out));
  assert.ok(out.includes("&#64;&#8203;"));
});

test("audit 14: mdEscape keeps its control-character stripping and length cap", () => {
  assert.ok(!mdEscape("a\u001b[31mb").includes("\u001b"));
  assert.ok(mdEscape("x".repeat(50), 10).length <= 40);
});

test("audit 14: the final pass over rendered Markdown stops mentions and issue references too", () => {
  const out = sanitizeMarkdown("## Heading\nhi @octocat and #123, kept &#64;&#8203;x");
  assert.ok(out.startsWith("## Heading"));
  assert.ok(!out.includes("@octocat"));
  assert.ok(out.includes("&#64;​octocat"));
  assert.ok(out.includes("#​123"));
  assert.ok(out.includes("&#64;&#8203;x"));
});

// ---- 15: release workflow ----

test("audit 15: jobs holding an OIDC token run no install scripts and no SBOM tool", () => {
  const workflow = parseYaml(readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8")) as { jobs: Record<string, { permissions?: Record<string, string>; steps: Array<{ uses?: string; run?: string; with?: Record<string, string> }> }> };
  let oidcJobs = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.permissions?.["id-token"] !== "write") continue;
    oidcJobs++;
    for (const step of job.steps ?? []) {
      assert.ok(!step.uses?.startsWith("anchore/sbom-action"), `${name} runs the SBOM action with an OIDC token`);
      if (/\bnpm (install|i|ci)\b/.test(step.run ?? "")) assert.match(step.run ?? "", /--ignore-scripts/, `${name}: ${step.run}`);
    }
  }
  assert.ok(oidcJobs >= 3);
  const sbom = workflow.jobs.sbom!;
  assert.equal(sbom.permissions?.["id-token"], undefined);
  assert.ok(sbom.steps.some((step) => step.uses?.startsWith("anchore/sbom-action")));
  const upload = sbom.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.match(upload?.with?.name ?? "", /^release-/, "the attest job downloads release-* artifacts");
  assert.ok((workflow.jobs.attest as unknown as { needs: string[] }).needs.includes("sbom"));
});

// ---- 16: git and the working directory ----

/** A relative PATH entry makes POSIX search the child's cwd, which is what Windows always does. */
function withRepoGit(root: string, marker: string, run: () => Promise<void>): Promise<void> {
  writeFileSync(path.join(root, "git"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
  chmodSync(path.join(root, "git"), 0o755);
  const original = process.env.PATH;
  process.env.PATH = `.:${original}`;
  return run().finally(() => {
    process.env.PATH = original;
  });
}

test("audit 16: resolveRepo never runs a git found in the repo", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    const marker = path.join(base, "planted-git-ran");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/owner/name.git"]);
    await withRepoGit(root, marker, async () => {
      assert.equal(await resolveRepo(root, {}), "owner/name");
    });
    assert.equal(existsSync(marker), false);
  } finally {
    done();
  }
});

test("audit 16: the Action's diff never runs a git found in the repo", posix, async () => {
  const { base, root, done } = tempBase();
  try {
    const marker = path.join(base, "planted-git-ran");
    const git = (...args: string[]): string => execFileSync("git", ["-C", root, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(path.join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    const first = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "a.txt"), "two\n");
    git("commit", "-qam", "two");
    const second = git("rev-parse", "HEAD");
    await withRepoGit(root, marker, async () => {
      assert.match((await gitDiff(root, first, second)) ?? "", /\+two/);
    });
    assert.equal(existsSync(marker), false);
  } finally {
    done();
  }
});

// ---- log ----

test("audit log: a lone carriage return cannot start a workflow command", async () => {
  const { out } = await captured(() => log("safe\r::error::forged"));
  for (const line of out.split(/\r|\n/)) assert.ok(!line.startsWith("::"), JSON.stringify(line));
  assert.ok(!out.includes("\r"));
});
