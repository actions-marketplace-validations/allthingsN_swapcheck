import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BINARY, REPO_ROOT, cleanEnv, ensureBuilt, openaiCall, pickModels, removeDir, runCli, runNode, startFakeGitHub, startFakeProviders, tempDir, writeTree, type FakeProviders, type RunResult } from "../test/surface/support.ts";

const execFileAsync = promisify(execFile);
const models = pickModels();
let home: string;
const projects: string[] = [];

function project(files: Record<string, string>): string {
  const dir = tempDir();
  projects.push(dir);
  writeTree(dir, files);
  return dir;
}

function run(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<RunResult> {
  return runCli(["--offline", ...args], { cwd, env: cleanEnv(home, extra) });
}

function passingCase(id: string): unknown {
  return { id, origin: "team", accepted: true, messages: [{ role: "user", content: `Say ok for ${id}` }], max_tokens: 20, checks: [{ type: "contains", text: "ok" }] };
}

function repoWithCases(model: string, count: number): string {
  const cases = Array.from({ length: count }, (_, i) => passingCase(`case-${i}`));
  return project({ "src/llm.ts": openaiCall(model), "swapcheck/cases/suite.json": JSON.stringify({ version: 1, cases }, null, 2) });
}

before(async () => {
  await ensureBuilt();
  home = tempDir();
});

after(() => {
  for (const dir of projects) removeDir(dir);
  removeDir(home);
});

describe("first run", () => {
  test("needs no keys or config, shows dates and source links, and writes models.lock", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    const result = await run(dir, []);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(models.retiring));
    assert.ok(result.stdout.includes(models.retiringEvent.effective as string));
    assert.ok(result.stdout.includes(models.retiringEvent.source));
    assert.ok(existsSync(path.join(dir, "models.lock")));
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  });

  test("--no-lock leaves the folder untouched", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    assert.equal((await run(dir, ["--no-lock"])).code, 0);
    assert.equal(existsSync(path.join(dir, "models.lock")), false);
  });

  test("an empty repo says so plainly", async () => {
    const result = await run(project({ "README.txt": "nothing here" }), []);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No model IDs were found/);
  });

  test("a 200-file repo scans quickly", async () => {
    const files: Record<string, string> = { "src/llm.ts": openaiCall(models.retiring) };
    for (let i = 0; i < 200; i++) files[`src/mod${i}.ts`] = `export const value${i} = ${i};\n`.repeat(40);
    const result = await run(project(files), ["--no-lock"]);
    assert.equal(result.code, 0);
    assert.ok(result.ms < (process.env.CI ? 6000 : 1000), `took ${Math.round(result.ms)} ms`);
  });
});

describe("output formats", () => {
  test("json is stable for agents", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    const result = await run(dir, ["--format", "json", "--no-lock"]);
    const body = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(body), ["schema", "root", "registry", "files_scanned", "items", "findings", "unresolved", "lock_written"]);
    assert.equal(body.schema, "swapcheck.scan/v1");
    assert.equal(body.lock_written, false);
    assert.equal(body.registry.source, "bundled");
  });

  test("markdown and sarif render", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    assert.match((await run(dir, ["--format", "markdown", "--no-lock"])).stdout, /\| Model \|/);
    assert.equal(JSON.parse((await run(dir, ["--format", "sarif", "--no-lock"])).stdout).version, "2.1.0");
  });

  test("--help works for every command, and --version prints the package version", async () => {
    const dir = project({});
    for (const command of ["scan", "watch", "find", "cases", "baseline", "test", "bump", "report", "mcp"]) {
      const result = await run(dir, [command, "--help"]);
      assert.equal(result.code, 0, command);
      assert.match(result.stdout, /Usage:/, command);
    }
    assert.match((await run(dir, ["--help"])).stdout, /Exit codes/);
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal((await run(dir, ["--version"])).stdout.trim(), pkg.version);
  });

  test("usage mistakes exit 2 with a plain sentence and no stack trace", async () => {
    const dir = project({});
    for (const args of [["wach"], ["scan", "--nope"], ["--format", "xml"], ["find"], ["test"], ["bump", "a"], ["report"], ["cases", "nope"], ["cases", "import", "nope", "x"]]) {
      const result = await run(dir, args);
      assert.equal(result.code, 2, args.join(" "));
      assert.doesNotMatch(result.stderr, /^\s+at /m, args.join(" "));
      assert.ok(result.stderr.length > 0, args.join(" "));
    }
  });

  test("--debug adds the stack trace", async () => {
    const result = await run(project({}), ["report", "missing.json", "--debug"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^\s+at /m);
  });
});

describe("paths stay inside the project", () => {
  test("--config and report refuse to leave the project", async () => {
    const outside = project({ "swapcheck.yaml": "runs: 3\n", "r.json": "{}" });
    const dir = project({});
    const relative = path.relative(dir, outside);
    assert.equal((await run(dir, ["--config", path.join(relative, "swapcheck.yaml")])).code, 2);
    assert.equal((await run(dir, ["report", path.join(relative, "r.json")])).code, 2);
    assert.equal((await run(dir, ["cases", "import", "otel", path.join(relative, "r.json")])).code, 2);
  });

  test("--cwd must exist", async () => {
    const result = await run(project({}), ["--cwd", "/nonexistent-swapcheck-folder"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /does not exist/);
  });
});

describe("watch and find", () => {
  test("watch needs a lock", async () => {
    const result = await run(project({}), ["watch"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /models\.lock/);
  });

  test("watch exits 1 when a change is inside the window and its JSON agrees", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    await run(dir, []);
    const wide = await run(dir, ["watch", "--fail-within-days", "3650", "--format", "json"]);
    const body = JSON.parse(wide.stdout);
    assert.equal(body.schema, "swapcheck.watch/v1");
    assert.ok(body.due.length > 0);
    assert.equal(wide.code, 1);
    const narrow = await run(dir, ["watch", "--fail-within-days", "0", "--format", "json"]);
    assert.equal(narrow.code, JSON.parse(narrow.stdout).due.length > 0 ? 1 : 0);
  });

  test("find lists options as text and JSON, and spends nothing", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    const text = await run(dir, ["find", models.retiring, "--limit", "2"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Replacements for/);
    const body = JSON.parse((await run(dir, ["find", models.retiring, "--limit", "2", "--format", "json"])).stdout);
    assert.equal(body.schema, "swapcheck.find/v1");
    assert.ok(body.shortlist.length <= 2);
    assert.equal(body.tested, false);
  });
});

describe("cases", () => {
  test("init, then accept --all", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.openai) });
    const init = await run(dir, ["cases", "init", "--format", "json"]);
    assert.equal(init.code, 0, init.stderr);
    const body = JSON.parse(init.stdout);
    assert.equal(body.schema, "swapcheck.cases/v1");
    const accepted = await run(dir, ["cases", "accept", "--all", "--format", "json"]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(typeof JSON.parse(accepted.stdout).accepted, "number");
  });

  test("accept without ids is a usage error", async () => {
    assert.equal((await run(project({}), ["cases", "accept"])).code, 2);
  });
});

describe("paid commands", () => {
  let fake: FakeProviders;
  let reply: (model: string) => string;

  before(async () => {
    reply = () => "ok";
    fake = await startFakeProviders((call) => reply(call.model));
  });
  after(() => fake.close());

  // Gemini's base URL is not configurable, so a preload points the real CLI's fetch at the fake.
  function geminiPreload(url: string): string {
    const file = path.join(home, "gemini-preload.mjs");
    writeFileSync(file, `const real = globalThis.fetch;\nglobalThis.fetch = (input, init) => real(String(input).replace("https://generativelanguage.googleapis.com", ${JSON.stringify(url)}), init);\n`);
    return pathToFileURL(file).href;
  }

  const keys = (): Record<string, string> => ({
    OPENAI_API_KEY: "sk-openai-test-key-0123456789",
    ANTHROPIC_API_KEY: "sk-ant-test-key-0123456789",
    GEMINI_API_KEY: "gemini-test-key-0123456789",
    SWAPCHECK_OPENAI_BASE_URL: `${fake.url}/v1`,
    SWAPCHECK_ANTHROPIC_BASE_URL: fake.url,
    ...(BINARY ? {} : { NODE_OPTIONS: `--import=${geminiPreload(fake.url)}` }),
  });

  test("off a terminal, nothing is spent without --yes, and the cost and vendors are shown", async () => {
    const dir = repoWithCases(models.openai, 3);
    fake.calls.length = 0;
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--runs", "2", "--max-usd", "5"], keys());
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Maximum cost: \$/);
    assert.match(result.stderr, /Vendors that will see your case content: anthropic, openai/);
    assert.match(result.stderr, /--yes/);
    assert.equal(fake.calls.length, 0);
  });

  test("a missing key stops before any cost prompt", async () => {
    const dir = repoWithCases(models.openai, 1);
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--yes"], { OPENAI_API_KEY: "sk-openai-test-key-0123456789" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(result.stderr, /Maximum cost/);
  });

  test("no accepted cases is a usage error", async () => {
    const dir = project({ "src/llm.ts": openaiCall(models.openai) });
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--yes"], keys());
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no accepted cases/);
  });

  test("more than one current model must be named", async () => {
    const dir = project({ "models.lock": JSON.stringify({ version: 1, models: [{ id: models.openai, route: "openai-api", status: "ok", verified_at: null, baseline: null }, { id: models.gemini, route: "google-ai-studio", status: "ok", verified_at: null, baseline: null }] }), "swapcheck/cases/s.json": JSON.stringify({ version: 1, cases: [passingCase("a")] }) });
    const result = await run(dir, ["test", "--to", models.anthropic, "--yes"], keys());
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--from/);
  });

  test("an identical candidate across all three vendors reports no change, and a saved report re-renders", async () => {
    const dir = repoWithCases(models.openai, 8);
    fake.calls.length = 0;
    reply = () => "ok";
    // A compiled binary cannot take a Node preload, so Gemini is exercised only under Node.
    const to = BINARY ? models.anthropic : `${models.anthropic},${models.gemini}`;
    const result = await run(dir, ["test", "--to", to, "--from", models.openai, "--runs", "3", "--max-usd", "20", "--yes", "--format", "json"], keys());
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, "swapcheck.report/v1");
    for (const candidate of report.candidates) assert.equal(candidate.verdict, "NO_CHANGE_DETECTED", candidate.reason);
    assert.deepEqual(new Set(fake.calls.map((c) => c.vendor)), new Set(BINARY ? ["openai", "anthropic"] : ["openai", "anthropic", "gemini"]));
    assert.ok(fake.calls.some((c) => c.vendor === "openai" && c.auth === "Bearer sk-openai-test-key-0123456789"));
    assert.ok(fake.calls.some((c) => c.vendor === "anthropic" && c.auth === "sk-ant-test-key-0123456789"));
    if (!BINARY) assert.ok(fake.calls.some((c) => c.vendor === "gemini" && c.auth === "gemini-test-key-0123456789"));
    assert.ok(report.report_path);

    const saved = report.report_path as string;
    const rendered = await run(dir, ["report", saved]);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(rendered.stdout, /No change detected/);
    assert.doesNotMatch(rendered.stdout, /\bsafe\b|guarantee/i);
    assert.match(rendered.stdout, /Limits of this measurement/);
    assert.match((await run(dir, ["report", saved, "--format", "markdown"])).stdout, /NO CHANGE DETECTED/);
    assert.ok(JSON.parse((await run(dir, ["report", saved, "--format", "sarif"])).stdout).runs);
  });

  test("a candidate that fails the checks is a regression with exit 1", async () => {
    const dir = repoWithCases(models.openai, 12);
    reply = (model) => (model === models.anthropic ? "nope" : "ok");
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--runs", "5", "--max-usd", "20", "--yes", "--format", "json"], keys());
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates[0].verdict, "REGRESSED", report.candidates[0].reason);
    assert.equal(result.code, 1);
  });

  test("a budget too small to run exits 3", async () => {
    const dir = repoWithCases(models.openai, 3);
    reply = () => "ok";
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--runs", "3", "--max-usd", "0.000001", "--yes", "--format", "json"], keys());
    assert.equal(result.code, 3, result.stderr);
    assert.equal(JSON.parse(result.stdout).stopped_early, true);
  });

  test("baseline measures the one model in use", async () => {
    const dir = repoWithCases(models.openai, 3);
    await run(dir, []);
    reply = () => "ok";
    const result = await run(dir, ["baseline", "--runs", "2", "--max-usd", "20", "--yes", "--format", "json"], keys());
    assert.notEqual(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).baseline_model, models.openai);
  });

  test("find --test also refuses without --yes", async () => {
    const dir = repoWithCases(models.retiring, 2);
    fake.calls.length = 0;
    const result = await run(dir, ["find", models.retiring, "--test", "--limit", "1", "--max-usd", "20"], keys());
    if (result.code === 2 && /needs an API key/.test(result.stderr)) return;
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Maximum cost/);
    assert.equal(fake.calls.length, 0);
  });

  test("keys never reach the output", async () => {
    const dir = repoWithCases(models.openai, 2);
    const result = await run(dir, ["test", "--to", models.anthropic, "--from", models.openai, "--runs", "2", "--max-usd", "20", "--yes"], keys());
    for (const secret of Object.values(keys()).filter((v) => v.startsWith("sk-") || v.startsWith("gemini"))) {
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stderr.includes(secret));
    }
  });
});

describe("bump", () => {
  const source = (model: string): string => `// ${model} was fine\nimport OpenAI from "openai";\nconst client = new OpenAI();\nexport const reply = await client.chat.completions.create({\n  model: "${model}",\n  messages: [],\n});\n`;

  test("--dry-run changes nothing and lists the edit", async () => {
    const dir = project({ "src/llm.ts": source(models.retiring) });
    const result = await run(dir, ["bump", models.retiring, "--to", models.openai, "--dry-run", "--format", "json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(path.join(dir, "src/llm.ts"), "utf8"), source(models.retiring));
    assert.equal(JSON.parse(result.stdout).changes[0].replacements, 1);
  });

  test("edits code, leaves the comment, updates the lock, and lists what it skipped", async () => {
    const dir = project({ "src/llm.ts": source(models.retiring), "README.md": `Uses ${models.retiring}.\n` });
    await run(dir, []);
    const result = await run(dir, ["bump", models.retiring, "--to", models.openai, "--format", "json"]);
    assert.equal(result.code, 0, result.stderr);
    const after = readFileSync(path.join(dir, "src/llm.ts"), "utf8");
    assert.ok(after.startsWith(`// ${models.retiring} was fine`));
    assert.ok(after.includes(`model: "${models.openai}"`));
    assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), `Uses ${models.retiring}.\n`);
    const body = JSON.parse(result.stdout);
    assert.ok(body.skipped.some((s: { reason: string }) => /comment/.test(s.reason)));
    const lock = JSON.parse(readFileSync(path.join(dir, "models.lock"), "utf8")) as { models: Array<{ id: string }> };
    assert.ok(lock.models.some((m) => m.id === models.openai));
    assert.ok(!lock.models.some((m) => m.id === models.retiring));
    assert.equal(readdirSync(path.join(dir, "src")).length, 1);
  });

  test("a model not in the project is a usage error", async () => {
    assert.equal((await run(project({ "a.ts": "1" }), ["bump", models.retiring, "--to", models.openai])).code, 2);
  });

  test("--open-pr needs a token", async () => {
    const result = await run(project({ "src/llm.ts": source(models.retiring) }), ["bump", models.retiring, "--to", models.openai, "--open-pr"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /GITHUB_TOKEN/);
  });

  test("--open-pr commits through the API and updates the same PR on a re-run", async () => {
    const content = source(models.retiring);
    const fake = await startFakeGitHub("acme/app", { "src/llm.ts": content });
    try {
      const dir = project({ "src/llm.ts": content });
      const env = { GITHUB_TOKEN: "test-github-token", GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: fake.url };
      const first = await run(dir, ["bump", models.retiring, "--to", models.openai, "--open-pr", "--format", "json"], env);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(JSON.parse(first.stdout).pull_request.created, true);
      assert.equal(fake.pulls.length, 1);
      assert.equal(fake.pulls[0]?.base, "main");
      assert.ok(fake.pulls[0]?.head.startsWith("swapcheck/"));
      assert.ok(fake.refs.has(`heads/${fake.pulls[0]?.head}`));
      assert.ok(fake.trees[0]?.some((entry) => entry.path === "models.lock"));
      const edited = fake.trees[0]?.find((entry) => entry.path === "src/llm.ts");
      assert.ok(fake.blobs.get(edited?.sha ?? "")?.includes(`model: "${models.openai}"`));
      assert.match(fake.pulls[0]?.body ?? "", /has not been measured/);

      writeTree(dir, { "src/llm.ts": content });
      const second = await run(dir, ["bump", models.retiring, "--to", models.openai, "--open-pr", "--format", "json"], env);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).pull_request.created, false);
      assert.equal(fake.pulls.length, 1);
    } finally {
      await fake.close();
    }
  });

  test("--open-pr carries the matching saved report as evidence", async () => {
    const content = source(models.retiring);
    const fake = await startFakeGitHub("acme/app", { "src/llm.ts": content });
    try {
      const evidence = JSON.stringify({ schema: "swapcheck.report/v1", id: "r1", created_at: "2026-11-01T00:00:00Z", baseline_model: models.retiring, runs_per_case: 5, case_count: 9, candidates: [{ model: models.openai, verdict: "NO_CHANGE_DETECTED", reason: "Nothing beyond noise." }], limits: ["Measured on 9 cases only."] });
      const dir = project({ "src/llm.ts": content, "swapcheck/reports/r1.json": evidence });
      const result = await run(dir, ["bump", models.retiring, "--to", models.openai, "--open-pr"], { GITHUB_TOKEN: "test-github-token", GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: fake.url });
      assert.equal(result.code, 0, result.stderr);
      const entry = fake.trees[0]?.find((e) => e.path === "swapcheck/reports/r1.json");
      assert.equal(fake.blobs.get(entry?.sha ?? ""), evidence);
      assert.match(fake.pulls[0]?.body ?? "", /NO&#95;CHANGE&#95;DETECTED/);
      assert.match(fake.pulls[0]?.body ?? "", /Measured on 9 cases/);
      assert.doesNotMatch(fake.pulls[0]?.body ?? "", /\bsafe\b/i);
    } finally {
      await fake.close();
    }
  });

  test("--open-pr refuses to publish a file that differs from the base branch", async () => {
    const fake = await startFakeGitHub("acme/app", { "src/llm.ts": "something else\n" });
    try {
      const dir = project({ "src/llm.ts": source(models.retiring) });
      const result = await run(dir, ["bump", models.retiring, "--to", models.openai, "--open-pr"], { GITHUB_TOKEN: "test-github-token", GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: fake.url });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /differs from main/);
      assert.equal(fake.pulls.length, 0);
      assert.equal(readFileSync(path.join(dir, "src/llm.ts"), "utf8"), source(models.retiring));
    } finally {
      await fake.close();
    }
  });
});

describe("npm package", () => {
  test("installs from a tarball into an empty folder and runs", async () => {
    const pack = tempDir();
    const install = tempDir();
    projects.push(pack, install);
    // npm_execpath avoids needing a shell to launch npm.cmd on Windows.
    const npm = (args: string[]): [string, string[]] => (process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, ...args]] : ["npm", args]);
    await execFileAsync(...npm(["pack", "--pack-destination", pack]), { cwd: REPO_ROOT, timeout: 120_000 });
    const tarball = readdirSync(pack).find((name) => name.endsWith(".tgz"));
    assert.ok(tarball);
    writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", private: true }));
    await execFileAsync(...npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", path.join(pack, tarball)]), { cwd: install, timeout: 120_000 });
    const pkg = JSON.parse(readFileSync(path.join(install, "node_modules/@allthingsai/swapcheck/package.json"), "utf8")) as { dependencies?: unknown };
    assert.equal(pkg.dependencies, undefined);
    const dir = project({ "src/llm.ts": openaiCall(models.retiring) });
    const result = await runNode(path.join(install, "node_modules/@allthingsai/swapcheck/dist/cli.mjs"), ["--offline", "--no-lock"], { cwd: dir, env: cleanEnv(home) });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(models.retiring));
    const library = await execFileAsync(process.execPath, ["--input-type=module", "-e", "import('@allthingsai/swapcheck').then((m) => console.log(typeof m.scanProject))"], { cwd: install, timeout: 30_000 });
    assert.equal(library.stdout.trim(), "function");
  });
});

