import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ACTION, cleanEnv, ensureBuilt, git, openaiCall, pickModels, removeDir, runNode, startFakeGitHub, startFakeProviders, tempDir, writeTree, type FakeGitHub, type FakeProviders, type GitHubComment, type RunResult } from "../test/surface/support.ts";

const models = pickModels();
const REPO = "acme/app";
let home: string;
const dirs: string[] = [];

interface ActionRun extends RunResult {
  outputs: Record<string, string>;
  summary: string;
}

function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([\w-]+)<<(swapcheck_[0-9a-f]{32})$/.exec(lines[i] as string);
    if (!match) continue;
    const name = match[1] as string;
    const value: string[] = [];
    for (i++; lines[i] !== match[2]; i++) value.push(lines[i] as string);
    out[name] = value.join("\n");
  }
  return out;
}

interface RunOptions {
  workspace: string;
  eventName: string;
  payload?: unknown;
  inputs?: Record<string, string>;
  env?: Record<string, string>;
}

async function runAction(options: RunOptions): Promise<ActionRun> {
  const scratch = tempDir();
  dirs.push(scratch);
  const outputFile = path.join(scratch, "output");
  const summaryFile = path.join(scratch, "summary");
  const eventFile = path.join(scratch, "event.json");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  writeFileSync(eventFile, JSON.stringify(options.payload ?? {}));
  const inputs = Object.fromEntries(Object.entries(options.inputs ?? {}).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));
  const env = cleanEnv(home, {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: options.workspace,
    GITHUB_EVENT_NAME: options.eventName,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_REPOSITORY: REPO,
    GITHUB_ACTOR: "someone",
    // Refused at once, so the run falls back to the bundled snapshot without touching the network.
    SWAPCHECK_REGISTRY_URL: "http://127.0.0.1:9/snapshot.json",
    ...inputs,
    ...options.env,
  });
  const result = await runNode(ACTION, [], { cwd: options.workspace, env });
  return { ...result, outputs: parseOutputs(readFileSync(outputFile, "utf8")), summary: readFileSync(summaryFile, "utf8") };
}

function caseFile(count: number): string {
  return JSON.stringify({ version: 1, cases: Array.from({ length: count }, (_, i) => ({ id: `case-${i}`, origin: "team", accepted: true, messages: [{ role: "user", content: `Say ok ${i}` }], max_tokens: 20, checks: [{ type: "contains", text: "ok" }] })) });
}

/** A real git repo with two commits; returns the SHAs a pull_request payload would carry. */
async function repoWithChange(before: Record<string, string>, change: Record<string, string>): Promise<{ workspace: string; base: string; head: string }> {
  const workspace = tempDir();
  dirs.push(workspace);
  writeTree(workspace, before);
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "--quiet", "-m", "base"]);
  const base = await git(workspace, ["rev-parse", "HEAD"]);
  writeTree(workspace, change);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "--quiet", "--allow-empty", "-m", "change"]);
  return { workspace, base, head: await git(workspace, ["rev-parse", "HEAD"]) };
}

function prPayload(base: string, head: string, fork = false, number = 42): unknown {
  return { pull_request: { number, base: { sha: base, repo: { full_name: REPO } }, head: { sha: head, repo: { full_name: fork ? "stranger/app" : REPO, fork } } } };
}

/** Every line of a run's stdout that the runner would treat as a command. */
function commandLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trimStart().startsWith("::") || line.includes("##["));
}

before(async () => {
  await ensureBuilt();
  home = tempDir();
});

after(() => {
  for (const dir of dirs) removeDir(dir);
  removeDir(home);
});

describe("action.yml", () => {
  test("declares the runtime, entry, inputs, outputs and branding", () => {
    const text = readFileSync(path.join(path.dirname(ACTION), "../action.yml"), "utf8");
    assert.match(text, /using: node24/);
    assert.match(text, /main: action-dist\/index\.mjs/);
    assert.match(text, /branding:/);
    for (const name of ["mode", "models", "candidates", "cases", "runs", "max-usd", "fail-within-days", "open-prs", "registry-url", "working-directory"]) assert.ok(text.includes(`\n  ${name}:`), name);
    for (const name of ["verdict", "changes-due", "report-path", "spent-usd", "recommended-model"]) assert.ok(text.includes(`\n  ${name}:`), name);
  });
});

describe("watch mode", () => {
  test("reports changes as annotations and outputs, and fails inside the window", async () => {
    const { workspace } = await repoWithChange({ "src/llm.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "schedule", inputs: { mode: "watch", "fail-within-days": "3650" } });
    assert.equal(run.outputs.verdict, "CHANGES_DUE");
    assert.equal(run.outputs["changes-due"], "1");
    assert.equal(run.outputs["spent-usd"], "0.000000");
    assert.equal(run.code, 1);
    assert.match(run.stdout, /::warning title=Model change,file=src\/llm\.ts,line=3::/);
    assert.ok(run.summary.includes("Model changes"));
  });

  test("report-path stays relative to the workspace under a working-directory", async () => {
    const { workspace, base, head } = await repoWithChange({ "app/src/llm.ts": openaiCall(models.openai), "app/swapcheck/cases/s.json": caseFile(8) }, { "app/src/llm.ts": openaiCall(models.anthropic) });
    const providers = await startFakeProviders(() => "ok");
    try {
      const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head), inputs: { mode: "check", "max-usd": "20", runs: "2", "working-directory": "app" }, env: { OPENAI_API_KEY: "sk-openai-test-key-0123456789", ANTHROPIC_API_KEY: "sk-ant-test-key-0123456789", SWAPCHECK_OPENAI_BASE_URL: `${providers.url}/v1`, SWAPCHECK_ANTHROPIC_BASE_URL: providers.url } });
      assert.equal(run.code, 0, run.stdout);
      assert.ok(run.outputs["report-path"]?.startsWith("app/swapcheck/reports/"), run.outputs["report-path"]);
      assert.ok(existsSync(path.join(workspace, run.outputs["report-path"] as string)));
    } finally {
      await providers.close();
    }
  });

  test("defaults to watch and honours working-directory", async () => {
    const { workspace } = await repoWithChange({ "app/src/llm.ts": openaiCall(models.retiring), "other/src/x.ts": openaiCall(models.openai) }, {});
    const run = await runAction({ workspace, eventName: "schedule", inputs: { "working-directory": "app", "fail-within-days": "3650" } });
    assert.equal(run.outputs["changes-due"], "1");
    assert.match(run.stdout, /file=app\/src\/llm\.ts/);
  });

  test("a working-directory outside the workspace is refused", async () => {
    const { workspace } = await repoWithChange({ "a.ts": "1" }, {});
    const run = await runAction({ workspace, eventName: "schedule", inputs: { "working-directory": "../.." } });
    assert.equal(run.code, 2);
    assert.equal(run.outputs.verdict, "ERROR");
    assert.match(run.stdout, /::error::.*outside/);
  });

  test("an unknown mode is a usage error", async () => {
    const { workspace } = await repoWithChange({ "a.ts": "1" }, {});
    assert.equal((await runAction({ workspace, eventName: "schedule", inputs: { mode: "explode" } })).code, 2);
  });

  test("files with command characters in their names cannot inject", { skip: process.platform === "win32" }, async () => {
    const { workspace } = await repoWithChange({ "src/a,b:c%0A::error::x.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "schedule", inputs: { "fail-within-days": "3650" } });
    const line = commandLines(run.stdout).find((l) => l.startsWith("::warning title=Model change"));
    assert.ok(line);
    assert.ok(line.includes("a%2Cb%3Ac%250A%3A%3Aerror%3A%3Ax.ts"), line);
  });
});

describe("find mode", () => {
  test("outputs a recommended model and spends nothing", async () => {
    const { workspace } = await repoWithChange({ "src/llm.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "workflow_dispatch", inputs: { mode: "find", models: models.retiring } });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(run.outputs.verdict, "SHORTLISTED");
    assert.ok(run.outputs["recommended-model"]);
    assert.match(run.summary, /Replacements for/);
  });
});

describe("check mode", () => {
  let providers: FakeProviders;
  let reply: (model: string) => string;
  let github: FakeGitHub;

  before(async () => {
    reply = () => "ok";
    providers = await startFakeProviders((call) => reply(call.model));
    github = await startFakeGitHub(REPO, {});
  });

  after(async () => {
    await providers.close();
    await github.close();
  });

  const keys = (): Record<string, string> => ({
    OPENAI_API_KEY: "sk-openai-test-key-0123456789",
    ANTHROPIC_API_KEY: "sk-ant-test-key-0123456789",
    SWAPCHECK_OPENAI_BASE_URL: `${providers.url}/v1`,
    SWAPCHECK_ANTHROPIC_BASE_URL: providers.url,
    GITHUB_TOKEN: "test-github-token",
    GITHUB_API_URL: github.url,
  });

  async function modelMove(): Promise<{ workspace: string; base: string; head: string }> {
    return repoWithChange({ "src/llm.ts": openaiCall(models.openai), "swapcheck/cases/s.json": caseFile(8) }, { "src/llm.ts": openaiCall(models.anthropic) });
  }

  test("refuses without max-usd", async () => {
    const { workspace, base, head } = await modelMove();
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head), inputs: { mode: "check" }, env: keys() });
    assert.equal(run.code, 2);
    assert.match(run.stdout, /max-usd/);
  });

  test("skips spending when no model ID, prompt or case changed", async () => {
    const { workspace, base, head } = await repoWithChange({ "src/llm.ts": openaiCall(models.openai), "src/util.ts": "export const a = 1;\n", "swapcheck/cases/s.json": caseFile(2) }, { "src/util.ts": "export const a = 2;\n" });
    providers.calls.length = 0;
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head), inputs: { mode: "check", "max-usd": "5", candidates: models.anthropic }, env: keys() });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(run.outputs.verdict, "SKIPPED");
    assert.equal(providers.calls.length, 0);
  });

  test("a model change is measured, reported, and the comment is edited in place", async () => {
    const { workspace, base, head } = await modelMove();
    providers.calls.length = 0;
    github.comments.length = 0;
    const payload = prPayload(base, head);
    const run = await runAction({ workspace, eventName: "pull_request", payload, inputs: { mode: "check", "max-usd": "20", runs: "3" }, env: keys() });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(run.outputs.verdict, "NO_CHANGE_DETECTED");
    assert.ok(Number(run.outputs["spent-usd"]) > 0);
    assert.equal(run.outputs["recommended-model"], models.anthropic);
    assert.ok(existsSync(path.join(workspace, run.outputs["report-path"] as string)));
    assert.match(run.stdout, /Maximum cost/);
    assert.match(run.stdout, /Vendors that will see/);
    assert.ok(providers.calls.length > 0);
    assert.equal(github.comments.length, 1);
    assert.ok(github.comments[0]?.body.startsWith("<!-- swapcheck:check -->"));
    const firstId = github.comments[0]?.id;

    const again = await runAction({ workspace, eventName: "pull_request", payload, inputs: { mode: "check", "max-usd": "20", runs: "3" }, env: keys() });
    assert.equal(again.code, 0, again.stdout);
    assert.equal(github.comments.length, 1);
    assert.equal(github.comments[0]?.id, firstId);
  });

  test("a commenter cannot plant the marker to have their comment overwritten", async () => {
    const planted: GitHubComment = { id: 5, body: "<!-- swapcheck:check -->\nmine", user: { type: "User", login: "mallory" } };
    const fake = await startFakeGitHub(REPO, {}, [planted]);
    try {
      const { workspace, base, head } = await modelMove();
      const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head), inputs: { mode: "check", "max-usd": "20", runs: "2" }, env: { ...keys(), GITHUB_API_URL: fake.url } });
      assert.equal(run.code, 0, run.stdout);
      assert.equal(fake.comments.length, 2);
      assert.equal(fake.comments[0]?.body, "<!-- swapcheck:check -->\nmine");
    } finally {
      await fake.close();
    }
  });

  test("a regression fails the job with an escaped annotation", async () => {
    const { workspace, base, head } = await repoWithChange({ "src/llm.ts": openaiCall(models.openai), "swapcheck/cases/s.json": caseFile(12) }, { "src/llm.ts": openaiCall(models.anthropic) });
    reply = (model) => (model === models.anthropic ? "nope\n::set-output name=verdict::SAFE" : "ok");
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head), inputs: { mode: "check", "max-usd": "20", runs: "5" }, env: keys() });
    reply = () => "ok";
    assert.equal(run.outputs.verdict, "REGRESSED");
    assert.equal(run.code, 1);
    for (const line of commandLines(run.stdout)) assert.match(line, /^::(error|warning|notice)( [^:]*)?::/);
    assert.ok(!run.stdout.includes("::set-output"));
  });

  test("an unreadable diff spends nothing and exits 3", async () => {
    const { workspace, base } = await repoWithChange({ "src/llm.ts": openaiCall(models.openai), "swapcheck/cases/s.json": caseFile(2) }, {});
    providers.calls.length = 0;
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, "f".repeat(40)), inputs: { mode: "check", "max-usd": "5", candidates: models.anthropic }, env: keys() });
    assert.equal(run.code, 3, run.stdout);
    assert.equal(run.outputs.verdict, "NOT_ENOUGH_EVIDENCE");
    assert.equal(providers.calls.length, 0);
  });

  test("a hostile SHA in the payload never reaches git as an option", async () => {
    const { workspace, base } = await repoWithChange({ "src/llm.ts": openaiCall(models.openai) }, {});
    providers.calls.length = 0;
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, "--output=/tmp/pwned"), inputs: { mode: "check", "max-usd": "5", candidates: models.anthropic }, env: keys() });
    assert.equal(run.code, 3);
    assert.equal(providers.calls.length, 0);
  });

  test("a fork pull request runs only the free scan, even in check mode with keys present", async () => {
    const { workspace, base, head } = await modelMove();
    providers.calls.length = 0;
    github.comments.length = 0;
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head, true), inputs: { mode: "check", "max-usd": "20" }, env: keys() });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(run.outputs.verdict, "FORK_SCAN_ONLY");
    assert.equal(providers.calls.length, 0);
    assert.equal(github.comments.length, 0);
    assert.match(run.summary, /fork/);
  });

  test("pull_request_target is refused for paid modes before anything runs", async () => {
    const { workspace, base, head } = await modelMove();
    providers.calls.length = 0;
    for (const mode of ["check", "bump"]) {
      const run = await runAction({ workspace, eventName: "pull_request_target", payload: prPayload(base, head), inputs: { mode, "max-usd": "20" }, env: keys() });
      assert.equal(run.code, 2, mode);
      assert.match(run.stdout, /::error::.*pull_request_target/, mode);
    }
    assert.equal(providers.calls.length, 0);
  });

  test("pull_request_target may still run the free watch", async () => {
    const { workspace, base, head } = await modelMove();
    const run = await runAction({ workspace, eventName: "pull_request_target", payload: prPayload(base, head), inputs: { mode: "watch" }, env: keys() });
    assert.equal(run.outputs.verdict === "NO_CHANGES_DUE" || run.outputs.verdict === "CHANGES_DUE", true, run.stdout);
  });
});

describe("bump mode", () => {
  test("edits the working copy when open-prs is off", async () => {
    const { workspace } = await repoWithChange({ "src/llm.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "workflow_dispatch", inputs: { mode: "bump", models: models.retiring, candidates: models.openai } });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(run.outputs.verdict, "BUMPED");
    assert.ok(readFileSync(path.join(workspace, "src/llm.ts"), "utf8").includes(models.openai));
  });

  test("open-prs creates one pull request per model and re-runs update it", async () => {
    const content = openaiCall(models.retiring);
    const github = await startFakeGitHub(REPO, { "src/llm.ts": content });
    try {
      const { workspace } = await repoWithChange({ "src/llm.ts": content }, {});
      const env = { GITHUB_TOKEN: "test-github-token", GITHUB_API_URL: github.url };
      const inputs = { mode: "bump", models: models.retiring, candidates: models.openai, "open-prs": "true" };
      const first = await runAction({ workspace, eventName: "workflow_dispatch", inputs, env });
      assert.equal(first.code, 0, first.stdout);
      assert.equal(github.pulls.length, 1);
      assert.equal(readFileSync(path.join(workspace, "src/llm.ts"), "utf8"), content);
      const second = await runAction({ workspace, eventName: "workflow_dispatch", inputs, env });
      assert.equal(second.code, 0, second.stdout);
      assert.equal(github.pulls.length, 1);
      assert.ok(github.requests.some((r) => r.method === "PATCH" && r.path.includes("/pulls/")));
    } finally {
      await github.close();
    }
  });

  test("open-prs without a token is a usage error", async () => {
    const { workspace } = await repoWithChange({ "src/llm.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "workflow_dispatch", inputs: { mode: "bump", models: models.retiring, "open-prs": "true" } });
    assert.equal(run.code, 2);
    assert.match(run.stdout, /GITHUB_TOKEN/);
  });

  test("bump from a fork is scan-only", async () => {
    const { workspace, base, head } = await repoWithChange({ "src/llm.ts": openaiCall(models.retiring) }, {});
    const run = await runAction({ workspace, eventName: "pull_request", payload: prPayload(base, head, true), inputs: { mode: "bump", models: models.retiring, candidates: models.openai } });
    assert.equal(run.outputs.verdict, "FORK_SCAN_ONLY");
    assert.ok(readFileSync(path.join(workspace, "src/llm.ts"), "utf8").includes(models.retiring));
  });
});

