import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, parseBoundedInt, parseUsd, splitList } from "../../src/cli/args.ts";
import { SwapcheckError } from "../../src/util/errors.ts";

test("no arguments means scan", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, "scan");
  assert.equal(parsed.format, "text");
});

test("global flags may come before the command, with their values skipped", () => {
  const parsed = parseArgs(["--format", "json", "--cwd", "find", "find", "gpt-4o", "--limit=3"]);
  assert.equal(parsed.command, "find");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.flags.cwd, "find");
  assert.deepEqual(parsed.positionals, ["gpt-4o"]);
  assert.equal(parsed.flags.limit, "3");
});

test("-- ends option parsing, so a model cannot be read as a flag", () => {
  const parsed = parseArgs(["find", "--", "--weird-model"]);
  assert.deepEqual(parsed.positionals, ["--weird-model"]);
});

test("unknown commands and flags are usage errors with a suggestion", () => {
  assert.throws(() => parseArgs(["wach"]), (e: SwapcheckError) => e.exitCode === 2 && /Did you mean watch/.test(e.message));
  assert.throws(() => parseArgs(["scan", "--no-lok"]), (e: SwapcheckError) => e.exitCode === 2 && /no-lock/.test(e.message));
  assert.throws(() => parseArgs(["watch", "--to", "x"]), SwapcheckError);
});

test("a flag from another command is refused", () => {
  assert.throws(() => parseArgs(["scan", "--open-pr"]), SwapcheckError);
});

test("flags that need values reject a missing one", () => {
  assert.throws(() => parseArgs(["test", "--to"]), /needs a value/);
  assert.throws(() => parseArgs(["test", "--to", "--yes"]), /needs a value/);
  assert.throws(() => parseArgs(["scan", "--no-lock=1"]), /does not take a value/);
});

test("format is validated", () => {
  assert.throws(() => parseArgs(["--format", "xml"]), /--format must be/);
});

test("numbers are bounded and strict", () => {
  assert.equal(parseBoundedInt("--runs", "5", { min: 1, max: 9 }), 5);
  for (const bad of ["0", "10", "1e3", "-1", "2.5", "abc"]) assert.throws(() => parseBoundedInt("--runs", bad, { min: 1, max: 9 }), SwapcheckError);
  assert.equal(parseUsd("--max-usd", "2.50"), 2.5);
  for (const bad of ["0", "-1", "Infinity", "NaN", "1e9", ""]) assert.throws(() => parseUsd("--max-usd", bad), SwapcheckError);
});

test("lists split on commas and drop blanks", () => {
  assert.deepEqual(splitList(" a, b ,,c "), ["a", "b", "c"]);
});
