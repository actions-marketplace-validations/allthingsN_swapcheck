import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyBump, gitBlobSha, modelSlug, planBump, renderPrBody, type BumpPlan } from "../../src/bump/index.ts";
import { lexRegions, regionAt } from "../../src/bump/lex.ts";
import { removalsNear } from "../../src/bump/params.ts";
import { scanProject } from "../../src/scan/scan.ts";
import { blobSha, removeDir, tempDir, testSnapshot, writeTree } from "./support.ts";

const snapshot = testSnapshot();
let root: string;

before(() => {
  root = tempDir();
});
after(() => removeDir(root));

async function planFor(dir: string): Promise<BumpPlan> {
  const scan = await scanProject(dir, snapshot, { includeDocs: true });
  return planBump({ root: dir, from: "gpt-4o", to: "gpt-4.1", snapshot, scan });
}

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  writeTree(dir, files);
  return dir;
}

test("edits a TypeScript call and removes the rejected parameter", async () => {
  const dir = project("ts", { "src/a.ts": 'await client.chat.completions.create({\n  model: "gpt-4o",\n  temperature: 0.2,\n  max_tokens: 10,\n});\n' });
  const plan = await planFor(dir);
  await applyBump(dir, plan);
  assert.equal(readFileSync(path.join(dir, "src/a.ts"), "utf8"), 'await client.chat.completions.create({\n  model: "gpt-4.1",\n  max_tokens: 10,\n});\n');
  assert.deepEqual(plan.changes[0]?.removed_params, ["temperature"]);
  assert.ok(readFileSync(path.join(dir, "models.lock"), "utf8").includes("gpt-4.1"));
});

test("edits Python keyword arguments", async () => {
  const dir = project("py", { "a.py": 'client.create(\n    model="gpt-4o",\n    top_p=0.9,\n    stream=False,\n)\n' });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.py"), "utf8"), 'client.create(\n    model="gpt-4.1",\n    stream=False,\n)\n');
});

test("removes the last entry without breaking the commas", async () => {
  const dir = project("last", { "a.ts": 'f({ model: "gpt-4o", temperature: 1 });\n' });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'f({ model: "gpt-4.1" });\n');
});

test("never touches comments", async () => {
  const source = '// was "gpt-4o" before\nconst m = "gpt-4o"; /* gpt-4o */\n';
  const dir = project("comments", { "a.ts": source });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), '// was "gpt-4o" before\nconst m = "gpt-4.1"; /* gpt-4o */\n');
});

test("a comment beside a removed parameter survives", async () => {
  const dir = project("keep-comment", { "a.ts": 'f({\n  model: "gpt-4o",\n  temperature: 1, // tuned by hand\n});\n' });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'f({\n  model: "gpt-4.1",\n  // tuned by hand\n});\n');
});

test("price tables are skipped and listed", async () => {
  const source = 'const PRICES = {\n  "gpt-4o": { input: 2.5, output: 10 },\n};\nconst COST = { "gpt-4o": 5 };\nconst p = PRICES["gpt-4o"];\nf({ model: "gpt-4o" });\n';
  const dir = project("prices", { "a.ts": source });
  const plan = await planFor(dir);
  await applyBump(dir, plan);
  const after = readFileSync(path.join(dir, "a.ts"), "utf8");
  assert.ok(after.includes('"gpt-4o": { input: 2.5'));
  assert.ok(after.includes('{ "gpt-4o": 5 }'));
  assert.ok(after.includes('PRICES["gpt-4o"]'));
  assert.ok(after.includes('model: "gpt-4.1"'));
  assert.ok(plan.skipped.some((s) => /price table/.test(s.reason)));
});

test("YAML config is edited, keeping comments and removing a sibling parameter", async () => {
  const dir = project("yaml", { "config.yaml": "llm:\n  model: gpt-4o  # the main one\n  temperature: 0.3\n  retries: 2\n" });
  const plan = await planFor(dir);
  await applyBump(dir, plan);
  assert.equal(readFileSync(path.join(dir, "config.yaml"), "utf8"), "llm:\n  model: gpt-4.1  # the main one\n  retries: 2\n");
});

test("docs are skipped and listed", async () => {
  const dir = project("docs", { "README.md": "We use gpt-4o.\n", "a.ts": 'f({ model: "gpt-4o" });\n' });
  const plan = await planFor(dir);
  await applyBump(dir, plan);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "We use gpt-4o.\n");
  assert.ok(plan.skipped.some((s) => s.file === "README.md" && /docs/.test(s.reason)));
});

test("a stray use of a rejected parameter is reported, not edited", async () => {
  const dir = project("stray", { "a.ts": 'const m = "gpt-4o";\nconst opts = { temperature: 0.5 };\n' });
  const plan = await planFor(dir);
  assert.ok(plan.skipped.some((s) => /temperature/.test(s.reason)));
  await applyBump(dir, plan);
  assert.ok(readFileSync(path.join(dir, "a.ts"), "utf8").includes("temperature: 0.5"));
});

test("CRLF files keep their line endings", async () => {
  const dir = project("crlf", { "a.ts": 'f({\r\n  model: "gpt-4o",\r\n  temperature: 1,\r\n});\r\n' });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'f({\r\n  model: "gpt-4.1",\r\n});\r\n');
});

test("non-ASCII text before the ID does not shift the edit", async () => {
  const dir = project("unicode", { "a.ts": 'const a = "日本語"; f({ model: "gpt-4o" });\n' });
  await applyBump(dir, await planFor(dir));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'const a = "日本語"; f({ model: "gpt-4.1" });\n');
});

test("file modes are preserved", { skip: process.platform === "win32" }, async () => {
  const dir = project("mode", { "run.ts": 'f({ model: "gpt-4o" });\n' });
  chmodSync(path.join(dir, "run.ts"), 0o755);
  await applyBump(dir, await planFor(dir));
  assert.equal(statSync(path.join(dir, "run.ts")).mode & 0o777, 0o755);
});

test("a symlink out of the project is never edited", { skip: process.platform === "win32" }, async () => {
  const outside = project("outside", { "secret.ts": 'f({ model: "gpt-4o" });\n' });
  const dir = project("linked", { "a.ts": 'f({ model: "gpt-4o" });\n' });
  symlinkSync(path.join(outside, "secret.ts"), path.join(dir, "link.ts"));
  const scan = await scanProject(dir, snapshot, {});
  const hand = { ...scan, findings: [...scan.findings, { model: "gpt-4o", file: "link.ts", line: 1, column: 15, kind: "code" as const, known: true }] };
  const plan = await planBump({ root: dir, from: "gpt-4o", to: "gpt-4.1", snapshot, scan: hand });
  assert.ok(plan.skipped.some((s) => s.file === "link.ts"));
  assert.ok(!plan.changes.some((c) => c.file === "link.ts"));
});

test("a stale scan position is skipped, not guessed at", async () => {
  const dir = project("stale", { "a.ts": 'f({ model: "gpt-4o" });\n' });
  const scan = await scanProject(dir, snapshot, {});
  writeTree(dir, { "a.ts": '// moved\nf({ model: "gpt-4o" });\n' });
  const plan = await planBump({ root: dir, from: "gpt-4o", to: "gpt-4.1", snapshot, scan });
  assert.equal(plan.changes.length, 0);
  assert.match(plan.skipped[0]?.reason ?? "", /no longer has/);
});

test("a file changed between plan and apply stops the whole bump", async () => {
  const dir = project("race", { "a.ts": 'f({ model: "gpt-4o" });\n', "b.ts": 'g({ model: "gpt-4o" });\n' });
  const plan = await planFor(dir);
  writeTree(dir, { "b.ts": "changed\n" });
  await assert.rejects(applyBump(dir, plan), /changed while Swapcheck was working/);
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), 'f({ model: "gpt-4o" });\n');
});

test("asking for a model that is not there is a plain error", async () => {
  const dir = project("absent", { "a.ts": "const x = 1;\n" });
  await assert.rejects(planFor(dir), /was not found/);
});

test("the lexer tells strings from comments across languages", () => {
  const js = 'const a = "x"; // "y"\n';
  const regions = lexRegions(js, "js");
  assert.equal(regionAt(regions, js.indexOf("x"))?.kind, "string");
  assert.equal(regionAt(regions, js.indexOf("y"))?.kind, "comment");
  const py = "a = 'x'  # 'y'\nb = '''z'''\n";
  const pyRegions = lexRegions(py, "python");
  assert.equal(regionAt(pyRegions, py.indexOf("y"))?.kind, "comment");
  assert.equal(regionAt(pyRegions, py.indexOf("z"))?.kind, "string");
});

test("nested objects do not leak parameters upward", () => {
  const text = 'f({ model: "m", extra: { temperature: 1 } });';
  assert.deepEqual(removalsNear(text, "a.ts", text.indexOf("m"), ["temperature"]), []);
});

test("slugs are safe branch names", () => {
  assert.equal(modelSlug("GPT-4o"), "gpt-4o");
  assert.equal(modelSlug("openai/gpt-4o:free"), "openai-gpt-4o-free");
  assert.equal(modelSlug("../../etc"), "etc");
  assert.equal(modelSlug("a.lock"), "a-lock");
  assert.throws(() => modelSlug("///"));
});

test("git blob hashes match git's own", () => {
  assert.equal(gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(gitBlobSha("日本"), blobSha("日本"));
});

test("pull request bodies escape everything external", () => {
  const plan: BumpPlan = {
    from: "<img src=x onerror=alert(1)>",
    to: "@octocat",
    rejected_params: [],
    changes: [{ file: "a|b.ts", before: "", after: "", executable: false, replacements: 1, removed_params: ["<x>"] }],
    skipped: [{ file: "`x`.md", line: 2, reason: "[click](http://evil)" }],
    lock: { version: 1, models: [] },
  };
  const body = renderPrBody({ plan, evidence: null, events: [{ ...snapshot.events[0]!, source: "javascript:alert(1)", notes: "@everyone <b>" }] });
  assert.ok(!body.includes("<img"));
  assert.ok(!body.includes("@octocat"));
  assert.ok(!body.includes("@everyone"));
  assert.ok(!body.includes("](http://evil)"));
  assert.ok(!body.includes("](javascript:"));
  assert.ok(body.includes("has not been measured"));
});
