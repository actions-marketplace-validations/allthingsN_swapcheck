import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TestCase } from "../../types.ts";
import { SwapcheckError } from "../../util/errors.ts";
import { sha256 } from "../../util/hash.ts";
import { insideRoot, realInsideRoot } from "../../util/paths.ts";
import { MAX_CASES, saveCases, validateCase } from "../load.ts";
import { redactDeep } from "../redact.ts";
import { parseLangfuse } from "./langfuse.ts";
import { parseLitellm } from "./litellm.ts";
import { parseModelbump } from "./modelbump.ts";
import { parseModelpinScenario } from "./modelpin.ts";
import { parseOtel } from "./otel.ts";
import { parseJsonOrLines } from "./shared.ts";

export type ImportKind = "modelbump" | "modelpin" | "otel" | "litellm" | "langfuse";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILES = 2000;
const MODELPIN_NON_SCENARIOS = new Set(["manifest.json", "roles.json", "labels.json"]);

async function readSource(root: string, file: string): Promise<string> {
  if ((await stat(file)).size > MAX_IMPORT_BYTES) throw new SwapcheckError(`${path.relative(root, file)} is larger than ${MAX_IMPORT_BYTES} bytes. Split it and import the parts.`);
  if (!(await realInsideRoot(root, file))) throw new SwapcheckError(`${path.relative(root, file)} points outside the project, so Swapcheck will not read it.`);
  return readFile(file, "utf8");
}

function parseJsonFile(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SwapcheckError(`${file} is not valid JSON. Fix the syntax and import again.`);
  }
}

/** Every scenario file under a Modelpin folder, skipping the names Modelpin itself ignores. */
async function modelpinFiles(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "results") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await modelpinFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith(".json") && !MODELPIN_NON_SCENARIOS.has(entry.name)) found.push(full);
    if (found.length > MAX_IMPORT_FILES) throw new SwapcheckError(`${directory} has more than ${MAX_IMPORT_FILES} scenario files. Import a smaller folder.`);
  }
  return found;
}

async function importModelpin(root: string, absolute: string, relative: string): Promise<TestCase[]> {
  const isDirectory = (await stat(absolute)).isDirectory();
  const files = isDirectory ? (await modelpinFiles(absolute)).sort() : [absolute];
  const cases: TestCase[] = [];
  for (const file of files) {
    const data = parseJsonFile(await readSource(root, file), path.relative(root, file));
    for (const scenario of Array.isArray(data) ? data : [data]) cases.push(parseModelpinScenario(scenario, relative));
  }
  return cases;
}

function dedupe(cases: TestCase[]): TestCase[] {
  const seen = new Map<string, number>();
  return cases.map((testCase) => {
    const count = seen.get(testCase.id) ?? 0;
    seen.set(testCase.id, count + 1);
    return count === 0 ? testCase : { ...testCase, id: `${testCase.id}#${count + 1}` };
  });
}

/** Imports a suite or trace file. Text is redacted before it touches disk unless explicitly allowed. */
export async function importCases(kind: ImportKind, sourcePath: string, root: string, dir: string, opts: { allowUnredacted?: boolean } = {}): Promise<{ imported: number; redactions: number; written: string }> {
  const absolute = insideRoot(root, sourcePath);
  const relative = path.relative(path.resolve(root), absolute);
  try {
    await stat(absolute);
  } catch {
    throw new SwapcheckError(`The file ${sourcePath} does not exist. Check the path and import again.`);
  }

  let parsed: TestCase[];
  let digestInput: string;
  if (kind === "modelpin") {
    parsed = await importModelpin(root, absolute, relative);
    digestInput = JSON.stringify(parsed);
  } else {
    const text = await readSource(root, absolute);
    digestInput = text;
    if (kind === "modelbump") parsed = parseModelbump(parseJsonFile(text, relative), relative);
    else {
      const records = parseJsonOrLines(text, relative);
      parsed = kind === "otel" ? parseOtel(records) : kind === "litellm" ? parseLitellm(records) : parseLangfuse(records);
    }
  }
  if (parsed.length === 0) throw new SwapcheckError(`No usable cases were found in ${relative}. Check that it is a ${kind} export.`);
  if (parsed.length > MAX_CASES) throw new SwapcheckError(`${relative} produced more than ${MAX_CASES} cases. Import a smaller sample.`);

  let cases = dedupe(parsed);
  let redactions = 0;
  if (!opts.allowUnredacted) {
    const result = redactDeep(cases);
    cases = result.value;
    redactions = result.count;
  }
  cases.forEach((testCase) => validateCase(testCase, relative));
  const written = await saveCases(root, dir, `imported-${kind}-${sha256(digestInput).slice(0, 12)}.json`, cases);
  return { imported: cases.length, redactions, written };
}
