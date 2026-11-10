import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.ts";
import { withProject } from "./helpers.ts";

const load = (yaml: string, name = "swapcheck.yaml") => withProject({ [name]: yaml }, (root) => loadConfig(root));

const rejects = async (yaml: string, pattern: RegExp): Promise<void> => {
  await assert.rejects(() => load(yaml), pattern);
};

test("no file gives the defaults", async () => {
  assert.deepEqual(await withProject({}, (root) => loadConfig(root)), DEFAULT_CONFIG);
});

test("defaults are not shared between calls", async () => {
  const config = await withProject({}, (root) => loadConfig(root));
  config.exclude.push("x");
  config.budget.max_usd_per_run = 99;
  assert.deepEqual(DEFAULT_CONFIG.exclude, []);
  assert.equal(DEFAULT_CONFIG.budget.max_usd_per_run, 5);
});

test("empty file and comment-only file give the defaults", async () => {
  assert.deepEqual(await load(""), DEFAULT_CONFIG);
  assert.deepEqual(await load("# nothing\n"), DEFAULT_CONFIG);
});

test("a full config round-trips", async () => {
  const config = await load(`
models:
  - id: gpt-4o
    route: openai-api
    paths: [src/a.py]
cases: tests/cases
runs: 10
budget: { max_usd_per_run: 2.5 }
policy:
  providers: [openai, anthropic]
  regions: [us]
  licenses: [apache-2.0]
  max_usd_per_million_output: 20
watch: { fail_within_days: 14 }
include_text_in_reports: true
exclude: ["legacy/", "*.gen.py"]
`);
  assert.deepEqual(config, {
    models: [{ id: "gpt-4o", route: "openai-api", paths: ["src/a.py"] }],
    cases: "tests/cases",
    runs: 10,
    budget: { max_usd_per_run: 2.5 },
    policy: { providers: ["openai", "anthropic"], regions: ["us"], licenses: ["apache-2.0"], max_usd_per_million_output: 20 },
    watch: { fail_within_days: 14 },
    include_text_in_reports: true,
    exclude: ["legacy/", "*.gen.py"],
  });
});

test("a partial config merges over defaults", async () => {
  const config = await load("runs: 3\n");
  assert.equal(config.runs, 3);
  assert.equal(config.cases, DEFAULT_CONFIG.cases);
});

test("swapcheck.yml is also found", async () => {
  assert.equal((await load("runs: 7\n", "swapcheck.yml")).runs, 7);
});

test("explicit path is used", async () => {
  await withProject({ "conf/s.yaml": "runs: 9\n" }, async (root) => {
    assert.equal((await loadConfig(root, "conf/s.yaml")).runs, 9);
  });
});

test("explicit missing path is an error", async () => {
  await withProject({}, async (root) => {
    await assert.rejects(() => loadConfig(root, "nope.yaml"), /does not exist/);
  });
});

test("explicit path outside the root is refused", async () => {
  await withProject({}, async (root) => {
    await assert.rejects(() => loadConfig(root, "../../etc/passwd"), /outside the project folder/);
  });
});

test("a symlinked config leaving the root is refused", async () => {
  await withProject({ "outside.yaml": "runs: 9\n", "root/keep": "" }, async (base) => {
    const root = path.join(base, "root");
    await symlink(path.join(base, "outside.yaml"), path.join(root, "swapcheck.yaml"));
    await assert.rejects(() => loadConfig(root), /leaves the project folder/);
  });
});

test("unknown settings are named", async () => {
  await rejects("rnus: 3\n", /"rnus" is not recognised/);
  await rejects("budget: { usd: 1 }\n", /"budget.usd" is not recognised/);
  await rejects("policy: { provider: [a] }\n", /"policy.provider" is not recognised/);
  await rejects("models: [{ id: a, name: b }]\n", /"models\[0\].name" is not recognised/);
  await rejects("watch: { days: 1 }\n", /"watch.days" is not recognised/);
});

test("every field is type checked", async () => {
  await rejects("runs: many\n", /runs must be a whole number/);
  await rejects("runs: 1.5\n", /runs must be a whole number/);
  await rejects("runs: 0\n", /from 1 to 1000/);
  await rejects("runs: 100000\n", /from 1 to 1000/);
  await rejects("cases: 3\n", /cases must be text/);
  await rejects("budget: 5\n", /budget must be a mapping/);
  await rejects("budget: { max_usd_per_run: -1 }\n", /max_usd_per_run must be a number/);
  await rejects("budget: { max_usd_per_run: .nan }\n", /max_usd_per_run must be a number/);
  await rejects("budget: { max_usd_per_run: .inf }\n", /max_usd_per_run must be a number/);
  await rejects("policy: []\n", /policy must be a mapping/);
  await rejects("policy: { providers: openai }\n", /policy.providers must be a list/);
  await rejects("policy: { providers: [1] }\n", /policy.providers\[0\] must be text/);
  await rejects("policy: { max_usd_per_million_output: free }\n", /max_usd_per_million_output must be a number/);
  await rejects("watch: { fail_within_days: soon }\n", /fail_within_days must be a whole number/);
  await rejects("include_text_in_reports: yes please\n", /must be true or false/);
  await rejects("exclude: x\n", /exclude must be a list/);
  await rejects("exclude: ['']\n", /exclude\[0\] must be text/);
  await rejects("models: x\n", /models must be a list/);
  await rejects("models: [x]\n", /models\[0\] must be a mapping/);
  await rejects("models: [{ route: a }]\n", /models\[0\].id must be text/);
});

test("paths must stay inside the project", async () => {
  await rejects("cases: ../../outside\n", /must stay inside the project folder/);
  await rejects("models: [{ id: a, paths: ['../x'] }]\n", /must stay inside the project folder/);
});

test("the top level must be a mapping", async () => {
  await rejects("- a\n- b\n", /top level must be a mapping/);
  await rejects("just text\n", /top level must be a mapping/);
});

test("syntax errors are plain sentences naming the file", async () => {
  await rejects("runs: [\n", /swapcheck\.yaml: it is not valid YAML/);
});

test("duplicate keys are rejected", async () => {
  await rejects("runs: 1\nruns: 2\n", /not valid YAML/);
});

test("alias bombs are stopped", async () => {
  const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x]"];
  for (let i = 1; i < 12; i++) lines.push(`a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(", ")}]`);
  await rejects(`${lines.join("\n")}\n`, /aliases|could not be parsed|not recognised/);
});

test("deep flow nesting is refused before parsing", async () => {
  await rejects(`exclude: ${"[".repeat(5000)}\n`, /nests more than/);
});

test("deep block nesting is refused", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${" ".repeat(i)}k${i}:`);
  await rejects(`${lines.join("\n")} 1\n`, /nests more than|not recognised/);
});

test("oversized files are refused", async () => {
  await rejects(`# ${"x".repeat(300 * 1024)}\n`, /could not be read/);
});

test("oversized lists are refused", async () => {
  await rejects(`exclude: [${Array(1001).fill("a").join(",")}]\n`, /more than 1000/);
});

test("__proto__ is treated as an unknown setting and pollutes nothing", async () => {
  await rejects(`__proto__: { polluted: true }\n`, /not recognised/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("errors do not echo secret-shaped text from a syntax error", async () => {
  await withProject({}, async (root) => {
    await writeFile(path.join(root, "swapcheck.yaml"), `runs: [ sk-${"a".repeat(40)}\n`);
    await assert.rejects(() => loadConfig(root), (error: Error) => !error.message.includes(`sk-${"a".repeat(40)}`));
  });
});
