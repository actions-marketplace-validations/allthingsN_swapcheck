import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScanResult, SwapcheckConfig, TestCase } from "../../src/types.ts";
import { acceptCases } from "../../src/cases/accept.ts";
import { importCases } from "../../src/cases/import/index.ts";
import { initCases } from "../../src/cases/init.ts";
import { loadCases, saveCases, validateCase } from "../../src/cases/load.ts";
import { redactDeep, redactText } from "../../src/cases/redact.ts";
import { makeCase } from "./helpers.ts";

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "swapcheck-cases-"));
}

const DIR = "swapcheck/cases";
const config = { cases: DIR, models: [], runs: 5, budget: { max_usd_per_run: 5 }, policy: {}, watch: { fail_within_days: 30 }, include_text_in_reports: false, exclude: [] } satisfies SwapcheckConfig;

async function writeCaseFile(root: string, name: string, cases: unknown): Promise<void> {
  await mkdir(path.join(root, DIR), { recursive: true });
  await writeFile(path.join(root, DIR, name), JSON.stringify({ version: 1, cases }));
}

test("cases round-trip through save and load", async () => {
  const root = await project();
  const cases = [makeCase("a"), makeCase("b", [{ type: "contains", text: "x" }])];
  const written = await saveCases(root, DIR, "team", cases);
  assert.equal(written, path.join(DIR, "team.json"));
  assert.deepEqual(await loadCases(root, DIR), cases);
  await rm(root, { recursive: true });
});

test("a missing cases folder is an empty suite", async () => {
  const root = await project();
  assert.deepEqual(await loadCases(root, DIR), []);
  await rm(root, { recursive: true });
});

const invalid: Array<[string, unknown, RegExp]> = [
  ["unknown field", { ...makeCase("a"), extra: 1 }, /field extra is not known/],
  ["no checks", { ...makeCase("a"), checks: [] }, /checks must be a non-empty/],
  ["bad role", { ...makeCase("a"), messages: [{ role: "robot", content: "x" }] }, /role must be/],
  ["bad check type", { ...makeCase("a"), checks: [{ type: "vibes" }] }, /check type vibes is not known/],
  ["unsafe regex", { ...makeCase("a"), checks: [{ type: "regex", pattern: "(a+)+" }] }, /regex check was refused/],
  ["no labels", { ...makeCase("a"), checks: [{ type: "label_in", labels: [] }] }, /needs a non-empty list/],
  ["bad max", { ...makeCase("a"), checks: [{ type: "max_tokens_output", max: 0 }] }, /whole-number max/],
  ["bad accepted", { ...makeCase("a"), accepted: "yes" }, /accepted must be/],
  ["bad origin", { ...makeCase("a"), origin: "elsewhere" }, /origin must be/],
  ["bad tool", { ...makeCase("a"), tools: [{ name: "t" }] }, /needs a parameters object/],
];

for (const [name, value, message] of invalid) {
  test(`strict validation refuses a case with ${name}`, () => {
    assert.throws(() => validateCase(value, "cases.json"), message);
  });
}

test("loading refuses bad files, duplicates and escaping symlinks", async () => {
  const root = await project();
  await writeCaseFile(root, "a.json", [makeCase("dup")]);
  await writeCaseFile(root, "b.json", [makeCase("dup")]);
  await assert.rejects(loadCases(root, DIR), /appears more than once/);
  await writeFile(path.join(root, DIR, "b.json"), "{not json");
  await assert.rejects(loadCases(root, DIR), /is not valid JSON/);
  await writeFile(path.join(root, DIR, "b.json"), JSON.stringify([makeCase("x")]));
  await assert.rejects(loadCases(root, DIR), /version 1 and a cases array/);
  await rm(path.join(root, DIR, "b.json"));
  const outside = await project();
  await writeFile(path.join(outside, "c.json"), JSON.stringify({ version: 1, cases: [] }));
  await symlink(path.join(outside, "c.json"), path.join(root, DIR, "c.json"));
  await assert.rejects(loadCases(root, DIR), /outside the project/);
  await rm(root, { recursive: true });
  await rm(outside, { recursive: true });
});

test("loading refuses a folder outside the project", async () => {
  const root = await project();
  await assert.rejects(loadCases(root, "../elsewhere"), /outside the project/);
  await rm(root, { recursive: true });
});

test("acceptCases flips drafts and refuses unknown ids", async () => {
  const root = await project();
  const drafts: TestCase[] = [{ ...makeCase("d1"), accepted: false, origin: "generated" }, { ...makeCase("d2"), accepted: false, origin: "generated" }];
  await saveCases(root, DIR, "drafts", drafts);
  assert.equal(await acceptCases(root, DIR, ["d1"]), 1);
  assert.deepEqual((await loadCases(root, DIR)).map((c) => c.accepted), [true, false]);
  assert.equal(await acceptCases(root, DIR, "all"), 1);
  assert.equal(await acceptCases(root, DIR, "all"), 0);
  await assert.rejects(acceptCases(root, DIR, ["nope"]), /No case has the id nope/);
  await rm(root, { recursive: true });
});

const scan = (findings: Array<{ file: string; line: number; model: string }>): ScanResult => ({
  root: "", files_scanned: 1, unresolved: [],
  findings: findings.map((finding) => ({ ...finding, column: 1, kind: "code" as const, known: true })),
});

test("init always produces useful drafts for a project with no call sites", async () => {
  const root = await project();
  const result = await initCases(root, scan([]), config);
  assert.equal(result.contract_only, true);
  assert.equal(result.cases, 3);
  const cases = await loadCases(root, DIR);
  assert.ok(cases.every((c) => !c.accepted && c.origin === "generated"));
  assert.ok(cases.some((c) => c.checks.some((check) => check.type === "json_schema")));
  await rm(root, { recursive: true });
});

test("init reads the source near a call for JSON, tools and a fixed prompt", async () => {
  const root = await project();
  await writeFile(path.join(root, "app.py"), [
    "def go():",
    "    client.chat.completions.create(",
    '        model="gpt-5",',
    '        response_format={"type": "json_object"},',
    '        tools=[{"type": "function", "function": {"name": "lookup_order"}}],',
    '        messages=[{"role": "user", "content": "Return the order status as JSON."}],',
    "    )",
  ].join("\n"));
  const result = await initCases(root, scan([{ file: "app.py", line: 3, model: "gpt-5" }]), config);
  assert.equal(result.cases, 1);
  assert.equal(result.written[0], path.join(DIR, "generated-drafts.json"));
  const [draft] = await loadCases(root, DIR);
  assert.equal(draft!.accepted, false);
  assert.equal(draft!.origin, "generated");
  assert.deepEqual(draft!.response_format, { type: "json_object" });
  assert.deepEqual(draft!.tools!.map((tool) => tool.name), ["lookup_order"]);
  assert.equal(draft!.messages.at(-1)!.content, "Return the order status as JSON.");
  assert.deepEqual(draft!.checks.map((check) => check.type), ["no_refusal", "json_valid", "tool_args_valid"]);
  await rm(root, { recursive: true });
});

test("init falls back to a runnable prompt when the source has no fixed one", async () => {
  const root = await project();
  await writeFile(path.join(root, "app.ts"), 'const r = await client.messages.create({ model: "m", messages: buildMessages(input) });');
  await initCases(root, scan([{ file: "app.ts", line: 1, model: "m" }]), config);
  const [draft] = await loadCases(root, DIR);
  assert.match(draft!.messages[0]!.content, /one-sentence summary/);
  assert.deepEqual(draft!.checks, [{ type: "no_refusal" }]);
  await rm(root, { recursive: true });
});

test("init keeps existing cases and is idempotent", async () => {
  const root = await project();
  await saveCases(root, DIR, "team", [makeCase("mine")]);
  await writeFile(path.join(root, "a.ts"), "x");
  const first = await initCases(root, scan([{ file: "a.ts", line: 1, model: "m" }]), config);
  assert.equal(first.cases, 1);
  assert.equal(first.contract_only, false);
  const second = await initCases(root, scan([{ file: "a.ts", line: 1, model: "m" }]), config);
  assert.equal(second.cases, 0);
  assert.deepEqual(second.written, []);
  assert.equal((await loadCases(root, DIR)).length, 2);
  await rm(root, { recursive: true });
});

test("init does not read a source file that escapes the project", async () => {
  const root = await project();
  const result = await initCases(root, scan([{ file: "../../etc/passwd", line: 1, model: "m" }]), config);
  assert.equal(result.cases, 1);
  const [draft] = await loadCases(root, DIR);
  assert.match(draft!.messages[0]!.content, /one-sentence summary/);
  await rm(root, { recursive: true });
});

test("redaction removes personal data and counts it", () => {
  const input = "Mail dana@example.com, call +1 415-555-0123 or (415) 555-0199, SSN 123-45-6789, card 4242 4242 4242 4242, key sk-abcdefghijklmnopqrstuvwx.";
  const { value, count } = redactText(input, {});
  for (const secret of ["dana@example.com", "415-555-0123", "555-0199", "123-45-6789", "4242 4242", "sk-abcdefgh"]) assert.ok(!value.includes(secret), secret);
  assert.equal(count, 6);
});

test("redaction leaves numbers that are not cards alone", () => {
  assert.equal(redactText("Order 1234567890123456 shipped 2026-11-09 at 12.50", {}).value, "Order 1234567890123456 shipped 2026-11-09 at 12.50");
});

test("redaction also covers secret environment values and nested data", () => {
  const { value, count } = redactDeep({ a: ["my-private-token-value"], b: { c: "x@y.io" } }, { MY_API_TOKEN: "my-private-token-value" });
  assert.deepEqual(value, { a: ["[REDACTED]"], b: { c: "[EMAIL]" } });
  assert.equal(count, 2);
});

async function importFile(kind: Parameters<typeof importCases>[0], name: string, content: string, opts?: { allowUnredacted?: boolean }): Promise<{ root: string; result: Awaited<ReturnType<typeof importCases>>; cases: TestCase[] }> {
  const root = await project();
  await writeFile(path.join(root, name), content);
  const result = await importCases(kind, name, root, DIR, opts);
  return { root, result, cases: await loadCases(root, DIR) };
}

const modelbumpSuite = {
  version: 1,
  cases: [
    { id: "support.py:24#1", path: "support.py", line: 24, api: "openai.chat", app_model: "gpt-4o-mini", oracle: { kind: "label", reason: "x", labels: ["bug", "feature"] }, source: "tests/t.py:16", generated_by: null, messages: [{ role: "user", content: "Ticket from a@b.co" }] },
    { id: "bot.py:14#1", path: "bot.py", line: 14, api: "openai.chat", app_model: null, oracle: { kind: "json", reason: "y", labels: [] }, source: "z", generated_by: "gen", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] },
    { id: "t.py:1#1", path: "t.py", line: 1, api: "openai.chat", app_model: null, oracle: { kind: "text", reason: "z", labels: [] }, source: "z", generated_by: null, messages: [{ role: "user", content: "summarize" }] },
  ],
  left_out: [],
};

test("ModelBump suites import with oracle mapping and redaction", async () => {
  const { root, result, cases } = await importFile("modelbump", "suite.json", JSON.stringify(modelbumpSuite));
  assert.equal(result.imported, 3);
  assert.equal(result.redactions, 1);
  assert.equal(cases[0]!.id, "modelbump:support.py:24#1");
  assert.deepEqual(cases[0]!.checks, [{ type: "label_in", labels: ["bug", "feature"] }]);
  assert.equal(cases[0]!.messages[0]!.content, "Ticket from [EMAIL]");
  assert.deepEqual(cases[1]!.checks, [{ type: "json_valid" }]);
  assert.deepEqual(cases[2]!.checks, [{ type: "no_refusal" }, { type: "meaning" }]);
  assert.ok(cases.every((c) => c.origin === "imported" && c.accepted));
  await rm(root, { recursive: true });
});

test("allowUnredacted keeps the original text and reports zero redactions", async () => {
  const { root, result, cases } = await importFile("modelbump", "suite.json", JSON.stringify(modelbumpSuite), { allowUnredacted: true });
  assert.equal(result.redactions, 0);
  assert.equal(cases[0]!.messages[0]!.content, "Ticket from a@b.co");
  await rm(root, { recursive: true });
});

test("ModelBump imports refuse a wrong version", async () => {
  const root = await project();
  await writeFile(path.join(root, "s.json"), JSON.stringify({ version: 2, cases: [] }));
  await assert.rejects(importCases("modelbump", "s.json", root, DIR), /not a version 1 ModelBump suite/);
  await rm(root, { recursive: true });
});

const scenario = {
  id: "route_ticket", name: "Route", kind: "agent",
  input: {
    messages: [{ role: "system", content: "Route." }, { role: "user", content: "Refund me at dana@example.com" }],
    tools: ["lookup_order", { type: "function", function: { name: "issue_refund", description: "d", parameters: { type: "object", properties: { id: { type: "string" } } } } }],
    tool_results: { lookup_order: { status: "ok" } },
    temperature: 0, max_tokens: 100,
  },
  assertions: { must_contain: ["billing"], must_not_contain: ["```"] },
};

test("Modelpin scenarios import from a file with assertions, tools and params", async () => {
  const { root, cases, result } = await importFile("modelpin", "s.json", JSON.stringify(scenario));
  assert.equal(result.imported, 1);
  const [testCase] = cases;
  assert.equal(testCase!.id, "modelpin:route_ticket");
  assert.deepEqual(testCase!.checks, [{ type: "contains", text: "billing" }, { type: "not_contains", text: "```" }, { type: "tool_args_valid" }]);
  assert.deepEqual(testCase!.tools!.map((tool) => tool.name), ["lookup_order", "issue_refund"]);
  assert.deepEqual(testCase!.params, { temperature: 0 });
  assert.equal(testCase!.max_tokens, 100);
  assert.ok(testCase!.tags!.includes("tool-results-not-replayed"));
  await rm(root, { recursive: true });
});

test("Modelpin folders skip the files Modelpin itself ignores", async () => {
  const root = await project();
  const scenarios = path.join(root, "scenarios");
  await mkdir(path.join(scenarios, ".drafts"), { recursive: true });
  await mkdir(path.join(scenarios, "results"), { recursive: true });
  await mkdir(path.join(scenarios, "nested"), { recursive: true });
  await writeFile(path.join(scenarios, "one.json"), JSON.stringify(scenario));
  await writeFile(path.join(scenarios, "nested", "two.json"), JSON.stringify({ ...scenario, id: "two" }));
  await writeFile(path.join(scenarios, "manifest.json"), "not a scenario");
  await writeFile(path.join(scenarios, ".drafts", "d.json"), "not a scenario");
  await writeFile(path.join(scenarios, "results", "r.json"), "not a scenario");
  const result = await importCases("modelpin", "scenarios", root, DIR);
  assert.equal(result.imported, 2);
  await rm(root, { recursive: true });
});

test("OpenTelemetry OTLP spans import with the semantic-convention attributes", async () => {
  const otlp = {
    resourceSpans: [{ scopeSpans: [{ spans: [{
      spanId: "abc", name: "chat gpt",
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "gpt-5" } },
        { key: "gen_ai.request.max_tokens", value: { intValue: "128" } },
        { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "first" }] },
          { role: "assistant", parts: [{ type: "text", content: "reply" }] },
          { role: "user", parts: [{ type: "text", content: "second, call 415-555-0123" }] },
        ]) } },
        { key: "gen_ai.system_instructions", value: { stringValue: JSON.stringify([{ role: "system", parts: [{ type: "text", content: "Be brief." }] }]) } },
        { key: "gen_ai.output.messages", value: { stringValue: JSON.stringify([{ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "lookup", arguments: {} }] }]) } },
        { key: "gen_ai.tool.definitions", value: { stringValue: JSON.stringify([{ type: "function", name: "lookup", parameters: { type: "object" } }]) } },
      ],
    }, { spanId: "plain", name: "http", attributes: [] }] }] }],
  };
  const { root, cases, result } = await importFile("otel", "spans.json", JSON.stringify(otlp));
  assert.equal(result.imported, 1);
  assert.equal(result.redactions, 1);
  const [testCase] = cases;
  assert.equal(testCase!.id, "otel:abc");
  assert.equal(testCase!.origin, "trace");
  assert.equal(testCase!.max_tokens, 128);
  assert.deepEqual(testCase!.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.ok(testCase!.checks.some((check) => check.type === "tool_called" && check.name === "lookup"));
  await rm(root, { recursive: true });
});

test("OpenTelemetry JSONL with older event and indexed forms imports", async () => {
  const lines = [
    JSON.stringify({ context: { span_id: "e1" }, name: "chat", attributes: { "gen_ai.request.model": "m" }, events: [
      { name: "gen_ai.system.message", attributes: { content: "sys" } },
      { name: "gen_ai.user.message", attributes: { content: "hello" } },
      { name: "gen_ai.choice", attributes: { message: JSON.stringify({ content: '{"a":1}' }) } },
    ] }),
    JSON.stringify({ span_id: "i1", name: "chat", attributes: { "gen_ai.prompt.0.role": "user", "gen_ai.prompt.0.content": "hi", "gen_ai.completion.0.role": "assistant", "gen_ai.completion.0.content": "I can't help with that." } }),
  ].join("\n");
  const { root, cases } = await importFile("otel", "spans.jsonl", lines);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0]!.messages.map((m) => m.role), ["system", "user"]);
  assert.ok(cases[0]!.checks.some((check) => check.type === "json_valid"));
  assert.ok(!cases[1]!.checks.some((check) => check.type === "no_refusal"), "a logged refusal must not be required to stop refusing");
  await rm(root, { recursive: true });
});

test("LiteLLM logs import, keeping only turns up to the last user message", async () => {
  const records = [
    { request_id: "r1", model: "gpt", messages: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }, { role: "user", content: "three" }, { role: "assistant", content: "logged later" }], model_parameters: { max_tokens: 5, temperature: 0.1, response_format: { type: "json_object" } }, response: { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] } },
    { id: "r2", proxy_server_request: { messages: [{ role: "user", content: "via proxy" }] } },
    { id: "empty" },
  ];
  const { root, cases } = await importFile("litellm", "logs.json", JSON.stringify(records));
  assert.equal(cases.length, 2);
  assert.equal(cases[0]!.id, "litellm:r1");
  assert.deepEqual(cases[0]!.messages.map((m) => m.content), ["one", "two", "three"]);
  assert.deepEqual(cases[0]!.response_format, { type: "json_object" });
  assert.ok(cases[0]!.checks.some((check) => check.type === "json_valid"));
  assert.equal(cases[1]!.messages[0]!.content, "via proxy");
  await rm(root, { recursive: true });
});

test("LiteLLM spend logs accept message arrays stored as strings", async () => {
  const records = { data: [{ request_id: "s", messages: JSON.stringify([{ role: "user", content: "stringified" }]), response: "{}" }] };
  const { root, cases } = await importFile("litellm", "spend.json", JSON.stringify(records));
  assert.equal(cases[0]!.messages[0]!.content, "stringified");
  await rm(root, { recursive: true });
});

test("Langfuse exports import generations and ignore other observations", async () => {
  const records = [
    { id: "g1", type: "GENERATION", model: "m", input: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "u" }] }], output: { role: "assistant", content: "hi" }, modelParameters: { temperature: 0.4, max_tokens: 9 } },
    { id: "span", type: "SPAN", input: "x" },
    { id: "t", observations: [{ id: "g2", type: "generation", input: "just a string", output: "text" }] },
  ];
  const { root, cases } = await importFile("langfuse", "export.json", JSON.stringify(records));
  assert.deepEqual(cases.map((c) => c.id), ["langfuse:g1", "langfuse:g2"]);
  assert.equal(cases[0]!.messages[1]!.content, "u");
  assert.deepEqual(cases[0]!.params, { temperature: 0.4 });
  assert.equal(cases[1]!.messages[0]!.content, "just a string");
  await rm(root, { recursive: true });
});

test("imports refuse sources outside the project and empty results", async () => {
  const root = await project();
  await assert.rejects(importCases("otel", "../secret.json", root, DIR), /outside the project/);
  await assert.rejects(importCases("otel", "missing.json", root, DIR), /does not exist/);
  await writeFile(path.join(root, "e.json"), "[]");
  await assert.rejects(importCases("otel", "e.json", root, DIR), /No usable cases/);
  await rm(root, { recursive: true });
});

test("an import writes only redacted text to disk", async () => {
  const { root, result } = await importFile("litellm", "l.json", JSON.stringify([{ id: "a", messages: [{ role: "user", content: "card 4242424242424242 and a@b.co" }] }]));
  const stored = await readFile(path.join(root, result.written), "utf8");
  assert.ok(!stored.includes("4242424242424242"));
  assert.ok(!stored.includes("a@b.co"));
  await rm(root, { recursive: true });
});
