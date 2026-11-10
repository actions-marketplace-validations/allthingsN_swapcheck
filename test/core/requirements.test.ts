import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { inferRequirements } from "../../src/scan/requirements.ts";
import { scanProject } from "../../src/scan/scan.ts";
import type { Requirements, ScanResult } from "../../src/types.ts";
import { snapshot, withProject } from "./helpers.ts";

const infer = (files: Record<string, string>, model: string): Promise<Requirements> =>
  withProject(files, async (root) => inferRequirements(root, model, await scanProject(root, snapshot())));

test("nothing near the call means nothing required", async () => {
  const reqs = await infer({ "a.py": `client.create(model="gpt-4o", messages=m)` }, "gpt-4o");
  assert.deepEqual({ ...reqs, evidence: [] }, { tools: false, structured_output: false, vision: false, audio: false, pdf: false, min_context: 0, min_output: 0, evidence: [] });
});

test("tools in the same call", async () => {
  const reqs = await infer({ "a.py": `client.create(model="gpt-4o", tools=TOOLS)` }, "gpt-4o");
  assert.equal(reqs.tools, true);
  assert.deepEqual(reqs.evidence, ["a.py:1 passes tools"]);
});

test("response_format in an object literal", async () => {
  const reqs = await infer({ "a.ts": `client.create({\n  model: "gpt-4o",\n  response_format: { type: "json_schema", json_schema: s },\n});` }, "gpt-4o");
  assert.equal(reqs.structured_output, true);
  assert.ok(reqs.evidence.some((e) => e.startsWith("a.ts:3")));
});

test("a plain-text response_format is not structured output", async () => {
  const reqs = await infer({ "a.py": `client.create(model="gpt-4o", response_format={"type": "text"})` }, "gpt-4o");
  assert.equal(reqs.structured_output, false);
});

test("generateObject and withStructuredOutput", async () => {
  assert.equal((await infer({ "a.ts": `await generateObject({ model: openai("gpt-4o"), schema: s });` }, "gpt-4o")).structured_output, true);
  assert.equal((await infer({ "a.py": `ChatOpenAI(model="gpt-4o").with_structured_output(S)` }, "gpt-4o")).structured_output, true);
});

test("bind_tools chained after construction", async () => {
  assert.equal((await infer({ "a.py": `ChatOpenAI(model="gpt-4o").bind_tools([f])` }, "gpt-4o")).tools, true);
});

test("image content parts", async () => {
  const reqs = await infer({ "a.py": `create(model="gpt-4o", messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": u}}]}])` }, "gpt-4o");
  assert.equal(reqs.vision, true);
});

test("Anthropic image and document blocks", async () => {
  const image = await infer({ "a.ts": `create({ model: "gpt-4o", messages: [{ content: [{ "type": "image", source: s }] }] });` }, "gpt-4o");
  assert.equal(image.vision, true);
  const doc = await infer({ "a.ts": `create({ model: "gpt-4o", messages: [{ content: [{ "type": "document", source: s }] }] });` }, "gpt-4o");
  assert.equal(doc.pdf, true);
});

test("audio and PDF mime types", async () => {
  assert.equal((await infer({ "a.py": `create(model="gpt-4o", d={"mime": "audio/wav"})` }, "gpt-4o")).audio, true);
  assert.equal((await infer({ "a.py": `create(model="gpt-4o", d={"mime": "application/pdf"})` }, "gpt-4o")).pdf, true);
  assert.equal((await infer({ "a.py": `create(model="gpt-4o", d={"type": "input_audio"})` }, "gpt-4o")).audio, true);
});

test("max_tokens sets min_output to the largest seen", async () => {
  const reqs = await infer({ "a.py": `create(model="gpt-4o", max_tokens=1_000)\ncreate(model="gpt-4o", max_tokens=4096)` }, "gpt-4o");
  assert.equal(reqs.min_output, 4096);
  assert.ok(reqs.evidence.some((e) => e.includes("max_tokens to 4096")));
});

test("camelCase and vendor spellings of the output limit", async () => {
  assert.equal((await infer({ "a.ts": `create({ model: "gpt-4o", maxOutputTokens: 900 });` }, "gpt-4o")).min_output, 900);
  assert.equal((await infer({ "a.py": `create(model="gpt-4o", max_completion_tokens=700)` }, "gpt-4o")).min_output, 700);
});

test("a non-numeric max_tokens is ignored", async () => {
  assert.equal((await infer({ "a.py": `create(model="gpt-4o", max_tokens=LIMIT)` }, "gpt-4o")).min_output, 0);
});

test("a model held in a constant is traced to its call site", async () => {
  const reqs = await infer({ "a.py": `MODEL = "gpt-4o"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\ndef go():\n    create(model=MODEL, tools=T)\n` }, "gpt-4o");
  assert.equal(reqs.tools, true);
  assert.deepEqual(reqs.evidence, ["a.py:22 passes tools"]);
});

test("features of a different model far away are not attributed", async () => {
  const filler = "\n".repeat(40);
  const reqs = await infer({ "a.py": `create(model="gpt-4o")${filler}create(model="gpt-4.1", tools=T)` }, "gpt-4o");
  assert.equal(reqs.tools, false);
});

test("words in comments and docstrings are not evidence", async () => {
  const reqs = await infer({ "a.py": `# tools=T response_format=1\ncreate(model="gpt-4o")  # image_url\n` }, "gpt-4o");
  assert.equal(reqs.tools, false);
  assert.equal(reqs.structured_output, false);
  assert.equal(reqs.vision, false);
});

test("combines several files", async () => {
  const reqs = await infer({ "a.py": `create(model="gpt-4o", tools=T)`, "b.ts": `create({ model: "gpt-4o", images: i });` }, "gpt-4o");
  assert.equal(reqs.tools, true);
  assert.equal(reqs.vision, true);
  assert.equal(reqs.evidence.length, 2);
});

test("config-only models report that nothing could be inferred", async () => {
  const reqs = await infer({ "a.yaml": "model: gpt-4o" }, "gpt-4o");
  assert.match(reqs.evidence[0] ?? "", /No code call sites/);
});

test("a model with no findings reports that nothing could be inferred", async () => {
  const reqs = await infer({ "a.py": `create(model="gpt-4o")` }, "grok-4");
  assert.match(reqs.evidence[0] ?? "", /No code call sites of grok-4/);
});

test("a finding path that escapes the root is refused", async () => {
  await withProject({}, async (root) => {
    const forged: ScanResult = { root, files_scanned: 1, unresolved: [], findings: [{ model: "gpt-4o", file: "../../etc/passwd.py", line: 1, column: 1, kind: "code", known: true }] };
    const reqs = await inferRequirements(root, "gpt-4o", forged);
    assert.match(reqs.evidence[0] ?? "", /No code call sites/);
  });
});

test("a finding through a symlink that escapes the root is refused", async () => {
  await withProject({ "outside/a.py": `create(model="gpt-4o", tools=T)`, "root/x.txt": "" }, async (base) => {
    const root = path.join(base, "root");
    await symlink(path.join(base, "outside", "a.py"), path.join(root, "link.py"));
    const forged: ScanResult = { root, files_scanned: 1, unresolved: [], findings: [{ model: "gpt-4o", file: "link.py", line: 1, column: 15, kind: "code", known: true }] };
    const reqs = await inferRequirements(root, "gpt-4o", forged);
    assert.equal(reqs.tools, false);
  });
});

test("evidence is capped", async () => {
  const body = Array.from({ length: 120 }, (_, i) => `create(model="gpt-4o", tools=T${i})${"\n".repeat(40)}`).join("");
  const reqs = await infer({ "a.py": body }, "gpt-4o");
  assert.equal(reqs.evidence.length, 40);
});
