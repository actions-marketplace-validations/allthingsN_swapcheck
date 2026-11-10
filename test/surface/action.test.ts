import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeDiff, escapeData, escapeProperty, neutralizeCommands, readEvent, readInputs, sanitizeMarkdown, setOutput } from "../../src/action/main.ts";
import { SwapcheckError } from "../../src/util/errors.ts";

test("workflow commands cannot start a log line", () => {
  assert.equal(neutralizeCommands("::set-output name=x::y"), ": :set-output name=x::y");
  assert.equal(neutralizeCommands("   ::stop-commands::tok"), "   : :stop-commands::tok");
  assert.ok(!neutralizeCommands("text ##[error]bad").includes("##["));
  assert.equal(neutralizeCommands("a :: b"), "a :: b");
});

test("annotation data and properties are escaped", () => {
  assert.equal(escapeData("50%\r\n::x"), "50%25%0D%0A::x");
  assert.equal(escapeProperty("a:b,c\n"), "a%3Ab%2Cc%0A");
});

test("outputs cannot break out of their delimiter", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "swapcheck-output-"));
  try {
    const file = path.join(dir, "out");
    writeFileSync(file, "");
    const hostile = "good\nevil<<EOF\nverdict=SAFE\u0007";
    setOutput({ GITHUB_OUTPUT: file }, "recommended-model", hostile);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const match = /^recommended-model<<(swapcheck_[0-9a-f]{32})$/.exec(lines[0] as string);
    assert.ok(match);
    assert.equal(lines.at(-2), match[1]);
    assert.ok(!text.includes("\u0007"));
    assert.equal(lines.filter((l) => l === match[1]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outputs redact secrets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "swapcheck-output-"));
  try {
    const file = path.join(dir, "out");
    writeFileSync(file, "");
    setOutput({ GITHUB_OUTPUT: file }, "x", "sk-ant-abcdefghijklmnop");
    assert.ok(!readFileSync(file, "utf8").includes("abcdefghijkl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markdown cannot mention people or forge the comment marker", () => {
  const out = sanitizeMarkdown("hi @octocat <!-- swapcheck:check -->");
  assert.ok(!out.includes("@octocat"));
  assert.ok(!out.includes("<!--"));
});

function withEvent(payload: unknown, name: string, check: (env: NodeJS.ProcessEnv) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "swapcheck-event-"));
  try {
    const file = path.join(dir, "event.json");
    writeFileSync(file, JSON.stringify(payload));
    check({ GITHUB_EVENT_PATH: file, GITHUB_EVENT_NAME: name });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pr = (headRepo: unknown): unknown => ({ pull_request: { number: 7, head: { sha: "a".repeat(40), repo: headRepo }, base: { sha: "b".repeat(40), repo: { full_name: "o/r" } } } });

test("forks are recognised from the payload, including deleted ones", () => {
  withEvent(pr({ full_name: "o/r", fork: false }), "pull_request", (env) => assert.equal(readEvent(env).isFork, false));
  withEvent(pr({ full_name: "other/r", fork: true }), "pull_request", (env) => assert.equal(readEvent(env).isFork, true));
  withEvent(pr({ full_name: "other/r", fork: false }), "pull_request", (env) => assert.equal(readEvent(env).isFork, true));
  withEvent(pr(null), "pull_request", (env) => assert.equal(readEvent(env).isFork, true));
});

test("a missing or corrupt payload is treated as no pull request", () => {
  assert.equal(readEvent({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: "/nonexistent" }).isFork, false);
});

test("inputs use the runner's hyphenated names and are validated", () => {
  const inputs = readInputs({ INPUT_MODE: "check", "INPUT_MAX-USD": "2.5", INPUT_MODELS: "a,\nb", "INPUT_FAIL-WITHIN-DAYS": "30", "INPUT_OPEN-PRS": "true" });
  assert.equal(inputs.mode, "check");
  assert.equal(inputs.maxUsd, 2.5);
  assert.deepEqual(inputs.models, ["a", "b"]);
  assert.equal(inputs.failWithinDays, 30);
  assert.equal(inputs.openPrs, true);
  assert.throws(() => readInputs({ INPUT_MODE: "nope" }), SwapcheckError);
  assert.throws(() => readInputs({ INPUT_RUNS: "lots" }), SwapcheckError);
});

const known = new Set(["gpt-4o", "gpt-4.1"]);

function diffOf(file: string, removed: string[], added: string[]): string {
  return [`--- a/${file}`, `+++ b/${file}`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
}

test("a model ID change is relevant and names both sides", () => {
  const facts = analyzeDiff(diffOf("src/a.ts", ['model: "gpt-4o"'], ['model: "gpt-4.1"']), known, new Set(), "swapcheck/cases", "");
  assert.equal(facts.relevant, true);
  assert.deepEqual(facts.removedModels, ["gpt-4o"]);
  assert.deepEqual(facts.addedModels, ["gpt-4.1"]);
});

test("a moved line is not a model change", () => {
  const facts = analyzeDiff(diffOf("src/a.ts", ['"gpt-4o"'], ['"gpt-4o"']), known, new Set(), "swapcheck/cases", "");
  assert.equal(facts.relevant, false);
});

test("cases, config and prompt files are relevant", () => {
  const relevant = (file: string): boolean => analyzeDiff(diffOf(file, ["a"], ["b"]), known, new Set(), "swapcheck/cases", "").relevant;
  assert.equal(relevant("swapcheck/cases/x.json"), true);
  assert.equal(relevant("swapcheck.yaml"), true);
  assert.equal(relevant("prompts/support.txt"), true);
  assert.equal(relevant("src/support.prompt"), true);
  assert.equal(relevant("src/util.ts"), false);
  assert.equal(relevant("README.md"), false);
});

test("working-directory prefixes apply", () => {
  const facts = analyzeDiff(diffOf("app/swapcheck/cases/x.json", ["a"], ["b"]), known, new Set(), "swapcheck/cases", "app/");
  assert.equal(facts.relevant, true);
  const outside = analyzeDiff(diffOf("swapcheck/cases/x.json", ["a"], ["b"]), known, new Set(), "swapcheck/cases", "app/");
  assert.equal(outside.relevant, false);
});

test("a prompt edit counts only in a file that calls a model", () => {
  const edit = diffOf("src/a.ts", ["const system = 'old';"], ["const system = 'new';"]);
  assert.equal(analyzeDiff(edit, known, new Set(["src/a.ts"]), "swapcheck/cases", "").relevant, true);
  assert.equal(analyzeDiff(edit, known, new Set(["src/b.ts"]), "swapcheck/cases", "").relevant, false);
});
