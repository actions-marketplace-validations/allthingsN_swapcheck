import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TestCase } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { insideRoot, realInsideRoot, writeInsideRoot } from "../util/paths.ts";
import { compileSafeRegex } from "../testing/checks.ts";

export const MAX_CASE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CASES = 5000;
const CASE_FILE_VERSION = 1;
const ROLES = new Set(["system", "user", "assistant", "tool"]);
const ORIGINS = new Set(["team", "trace", "imported", "generated"]);
const CASE_FIELDS = new Set(["id", "origin", "accepted", "messages", "tools", "response_format", "max_tokens", "params", "checks", "tags"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, problem: string): never {
  throw new SwapcheckError(`${where}: ${problem}`);
}

function validateToolCall(call: unknown, where: string): void {
  if (!isObject(call) || typeof call.id !== "string" || typeof call.name !== "string") fail(where, "each tool call needs a string id and name.");
  if (call.raw_arguments !== undefined && typeof call.raw_arguments !== "string") fail(where, "raw_arguments must be a string.");
}

function validateMessage(message: unknown, where: string): void {
  if (!isObject(message)) fail(where, "each message must be an object.");
  if (typeof message.role !== "string" || !ROLES.has(message.role)) fail(where, "a message role must be system, user, assistant or tool.");
  if (typeof message.content !== "string") fail(where, "a message content must be a string.");
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") fail(where, "tool_call_id must be a string.");
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) fail(where, "tool_calls must be an array.");
    for (const call of message.tool_calls) validateToolCall(call, where);
  }
}

function validateTool(tool: unknown, where: string): void {
  if (!isObject(tool) || typeof tool.name !== "string" || tool.name === "") fail(where, "each tool needs a name.");
  if (!isObject(tool.parameters)) fail(where, `tool ${tool.name} needs a parameters object.`);
  if (tool.description !== undefined && typeof tool.description !== "string") fail(where, `tool ${tool.name} has a description that is not a string.`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateCheck(check: unknown, where: string): void {
  if (!isObject(check) || typeof check.type !== "string") fail(where, "each check needs a type.");
  const problem = (text: string): never => fail(where, `the ${check.type} check ${text}.`);
  switch (check.type) {
    case "json_valid":
    case "tool_args_valid":
    case "no_refusal":
    case "refusal":
      break;
    case "json_schema":
      if (!isObject(check.schema)) problem("needs a schema object");
      break;
    case "label_in":
      if (!Array.isArray(check.labels) || check.labels.length === 0 || !check.labels.every(nonEmptyString)) problem("needs a non-empty list of labels");
      break;
    case "contains":
    case "not_contains":
      if (!nonEmptyString(check.text)) problem("needs text");
      if (check.ignore_case !== undefined && typeof check.ignore_case !== "boolean") problem("has an ignore_case that is not true or false");
      break;
    case "regex":
      if (!nonEmptyString(check.pattern)) problem("needs a pattern");
      if (check.flags !== undefined && typeof check.flags !== "string") problem("has flags that are not a string");
      try {
        compileSafeRegex(check.pattern as string, check.flags as string | undefined);
      } catch (error) {
        fail(where, (error as Error).message);
      }
      break;
    case "tool_called":
    case "tool_not_called":
      if (!nonEmptyString(check.name)) problem("needs a tool name");
      break;
    case "max_tokens_output":
      if (typeof check.max !== "number" || !Number.isInteger(check.max) || check.max < 1) problem("needs a whole-number max of at least 1");
      break;
    case "meaning":
      if (check.rubric !== undefined && typeof check.rubric !== "string") problem("has a rubric that is not a string");
      break;
    default:
      fail(where, `the check type ${check.type} is not known.`);
  }
}

/** Refuses anything that is not exactly a TestCase, so a typo cannot silently weaken a suite. */
export function validateCase(value: unknown, where: string): TestCase {
  if (!isObject(value)) fail(where, "each case must be an object.");
  const label = typeof value.id === "string" ? `${where}, case ${value.id}` : where;
  for (const key of Object.keys(value)) if (!CASE_FIELDS.has(key)) fail(label, `the field ${key} is not known.`);
  if (!nonEmptyString(value.id)) fail(where, "each case needs an id.");
  if (typeof value.origin !== "string" || !ORIGINS.has(value.origin)) fail(label, "origin must be team, trace, imported or generated.");
  if (typeof value.accepted !== "boolean") fail(label, "accepted must be true or false.");
  if (!Array.isArray(value.messages) || value.messages.length === 0) fail(label, "messages must be a non-empty array.");
  for (const message of value.messages) validateMessage(message, label);
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) fail(label, "tools must be an array.");
    for (const tool of value.tools) validateTool(tool, label);
  }
  if (value.response_format !== undefined) {
    const format = value.response_format;
    if (!isObject(format) || (format.type !== "json_object" && format.type !== "json_schema")) fail(label, "response_format must be json_object or json_schema.");
    if (format.type === "json_schema" && !isObject(format.schema)) fail(label, "a json_schema response_format needs a schema.");
  }
  if (value.max_tokens !== undefined && (typeof value.max_tokens !== "number" || !Number.isInteger(value.max_tokens) || value.max_tokens < 1)) fail(label, "max_tokens must be a whole number of at least 1.");
  if (value.params !== undefined && !isObject(value.params)) fail(label, "params must be an object.");
  if (!Array.isArray(value.checks) || value.checks.length === 0) fail(label, "checks must be a non-empty array.");
  for (const check of value.checks) validateCheck(check, label);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string"))) fail(label, "tags must be a list of strings.");
  return value as unknown as TestCase;
}

export async function readCaseFile(root: string, file: string): Promise<TestCase[]> {
  if (!(await realInsideRoot(root, file))) throw new SwapcheckError(`The case file ${file} points outside the project, so Swapcheck will not read it.`);
  const size = (await stat(file)).size;
  if (size > MAX_CASE_FILE_BYTES) throw new SwapcheckError(`The case file ${file} is larger than ${MAX_CASE_FILE_BYTES} bytes. Split it into smaller files.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new SwapcheckError(`The case file ${file} is not valid JSON. Fix the syntax and run again.`);
  }
  if (!isObject(parsed) || parsed.version !== CASE_FILE_VERSION || !Array.isArray(parsed.cases)) {
    throw new SwapcheckError(`The case file ${file} must be an object with version ${CASE_FILE_VERSION} and a cases array.`);
  }
  return parsed.cases.map((item) => validateCase(item, file));
}

export async function caseFiles(root: string, dir: string): Promise<{ absolute: string; files: string[] }> {
  const absolute = insideRoot(root, dir);
  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absolute, files: [] };
    throw error;
  }
  if (!(await realInsideRoot(root, absolute))) throw new SwapcheckError(`The cases folder ${dir} points outside the project, so Swapcheck will not read it.`);
  return { absolute, files: entries.filter((entry) => entry.endsWith(".json")).sort().map((entry) => path.join(absolute, entry)) };
}

/** Loads every case file in the folder. A missing folder is an empty suite, not an error. */
export async function loadCases(root: string, dir: string): Promise<TestCase[]> {
  const { files } = await caseFiles(root, dir);
  const seen = new Set<string>();
  const cases: TestCase[] = [];
  for (const file of files) {
    for (const testCase of await readCaseFile(root, file)) {
      if (seen.has(testCase.id)) throw new SwapcheckError(`The case id ${testCase.id} appears more than once in ${dir}. Case ids must be unique.`);
      seen.add(testCase.id);
      cases.push(testCase);
      if (cases.length > MAX_CASES) throw new SwapcheckError(`The cases folder has more than ${MAX_CASES} cases. Remove some and run again.`);
    }
  }
  return cases;
}

/** Writes cases to one file in the folder and returns the path relative to the project root. */
export async function saveCases(root: string, dir: string, name: string, cases: TestCase[]): Promise<string> {
  const absolute = insideRoot(root, dir);
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  if (fileName !== path.basename(fileName)) throw new SwapcheckError(`The case file name ${name} must not contain a folder.`);
  const target = path.join(absolute, fileName);
  await writeInsideRoot(root, target, `${JSON.stringify({ version: CASE_FILE_VERSION, cases }, null, 2)}\n`);
  return path.relative(path.resolve(root), target);
}
