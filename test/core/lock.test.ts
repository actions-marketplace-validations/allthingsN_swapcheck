import assert from "node:assert/strict";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { lockFromExposure, readLock, writeLock } from "../../src/lock.ts";
import type { ExposureItem, LockFile, ScanFinding } from "../../src/types.ts";
import { computeExposure } from "../../src/watch.ts";
import { NOW, snapshot, withProject } from "./helpers.ts";

const f = (model: string, route: string): ScanFinding => ({ model, route, file: "a.py", line: 1, column: 1, kind: "code", known: true });
const exposure = (...findings: ScanFinding[]): ExposureItem[] => computeExposure({ root: "/x", files_scanned: 1, findings, unresolved: [] }, snapshot(), NOW);

const sample: LockFile = { version: 1, models: [{ id: "gpt-4o", route: "openai-api", status: "ok", verified_at: null, baseline: null }] };

test("readLock: absent file is null", async () => {
  assert.equal(await withProject({}, (root) => readLock(root)), null);
});

test("write then read round-trips", async () => {
  await withProject({}, async (root) => {
    await writeLock(root, sample);
    assert.deepEqual(await readLock(root), sample);
  });
});

test("writeLock output is sorted, stable and ends with a newline", async () => {
  await withProject({}, async (root) => {
    const lock: LockFile = {
      version: 1,
      models: [
        { id: "b", route: "r", status: "ok", verified_at: null, baseline: null },
        { id: "a", route: "z", status: "ok", verified_at: null, baseline: null },
        { id: "a", route: "c", status: "ok", verified_at: null, baseline: null },
      ],
    };
    await writeLock(root, lock);
    const first = await readFile(path.join(root, "models.lock"), "utf8");
    await writeLock(root, { ...lock, models: [...lock.models].reverse() });
    assert.equal(await readFile(path.join(root, "models.lock"), "utf8"), first);
    assert.ok(first.endsWith("\n"));
    assert.deepEqual((await readLock(root))?.models.map((m) => `${m.id}/${m.route}`), ["a/c", "a/z", "b/r"]);
  });
});

test("writeLock leaves no temporary files behind", async () => {
  await withProject({}, async (root) => {
    await writeLock(root, sample);
    assert.deepEqual(await readdir(root), ["models.lock"]);
  });
});

for (const [name, content, pattern] of [
  ["not JSON", "{nope", /not JSON/],
  ["wrong version", `{"version":2,"models":[]}`, /version must be 1/],
  ["models not a list", `{"version":1,"models":{}}`, /models must be a list/],
  ["array at the top", `[]`, /top level/],
  ["entry not an object", `{"version":1,"models":[1]}`, /models\[0\] must be an object/],
  ["empty id", `{"version":1,"models":[{"id":"","route":"r","status":"ok","verified_at":null,"baseline":null}]}`, /id must be/],
  ["unknown status", `{"version":1,"models":[{"id":"a","route":"r","status":"fine","verified_at":null,"baseline":null}]}`, /status is not a known/],
  ["bad verified_at", `{"version":1,"models":[{"id":"a","route":"r","status":"ok","verified_at":1,"baseline":null}]}`, /verified_at/],
  ["bad cost", `{"version":1,"models":[{"id":"a","route":"r","status":"ok","verified_at":null,"baseline":null,"cost":{"input":"x"}}]}`, /cost/],
  ["partial capabilities", `{"version":1,"models":[{"id":"a","route":"r","status":"ok","verified_at":null,"baseline":null,"capabilities":{"tools":true}}]}`, /capabilities/],
] as Array<[string, string, RegExp]>) {
  test(`readLock rejects: ${name}`, async () => {
    await withProject({ "models.lock": content }, async (root) => {
      await assert.rejects(() => readLock(root), pattern);
    });
  });
}

test("readLock refuses an oversized file", async () => {
  await withProject({ "models.lock": `{"version":1,"models":[${" ".repeat(3 * 1024 * 1024)}]}` }, async (root) => {
    await assert.rejects(() => readLock(root), /could not be read/);
  });
});

test("readLock refuses a symlink", async () => {
  await withProject({ "outside.lock": JSON.stringify(sample), "root/k": "" }, async (base) => {
    const root = path.join(base, "root");
    await symlink(path.join(base, "outside.lock"), path.join(root, "models.lock"));
    await assert.rejects(() => readLock(root), /symbolic link/);
  });
});

test("writeLock refuses a symlink that leaves the root and leaves its target alone", async () => {
  await withProject({ "outside.lock": "untouched", "root/k": "" }, async (base) => {
    const root = path.join(base, "root");
    await symlink(path.join(base, "outside.lock"), path.join(root, "models.lock"));
    await assert.rejects(() => writeLock(root, sample), /symbolic link/);
    assert.equal(await readFile(path.join(base, "outside.lock"), "utf8"), "untouched");
  });
});

test("writeLock refuses a dangling link without writing through it", async () => {
  await withProject({ "root/k": "" }, async (base) => {
    const root = path.join(base, "root");
    await symlink(path.join(base, "elsewhere.lock"), path.join(root, "models.lock"));
    await assert.rejects(() => writeLock(root, sample), /symbolic link/);
    await assert.rejects(() => readFile(path.join(base, "elsewhere.lock")));
  });
});

test("lockFromExposure: retirement records event and date but no reroute target", () => {
  const lock = lockFromExposure(exposure(f("claude-3-5-sonnet-20241022", "anthropic-api")), snapshot());
  const entry = lock.models[0]!;
  assert.equal(entry.status, "retiring");
  assert.equal(entry.registry_event, "e-claude-retire");
  assert.equal(entry.effective, "2026-12-09");
  assert.equal(entry.reroute_to, undefined);
});

test("lockFromExposure: reroute records its target", () => {
  const lock = lockFromExposure(exposure(f("gemini-2.0-flash", "google-ai-studio")), snapshot());
  assert.equal(lock.models[0]?.status, "reroute_scheduled");
  assert.equal(lock.models[0]?.reroute_to, "gemini-2.5-flash");
});

test("lockFromExposure: copies cost and capabilities for the same route", () => {
  const entry = lockFromExposure(exposure(f("gpt-4o", "openai-api")), snapshot()).models[0]!;
  assert.deepEqual(entry.cost, { input: 2.5, output: 10 });
  assert.equal(entry.capabilities?.vision, true);
  assert.equal(entry.registry_event, undefined);
});

test("lockFromExposure: an unknown model has no cost or event", () => {
  const entry = lockFromExposure(exposure(f("gpt-9", "openai-api")), snapshot()).models[0]!;
  assert.equal(entry.status, "unknown");
  assert.equal(entry.cost, undefined);
  assert.equal(entry.capabilities, undefined);
});

test("lockFromExposure: informational events are not recorded as the cause", () => {
  const entry = lockFromExposure(exposure(f("gpt-4.1", "openai-api")), snapshot()).models[0]!;
  assert.equal(entry.status, "ok");
  assert.equal(entry.registry_event, undefined);
});

test("lockFromExposure: verification survives a new scan, per route", () => {
  const previous: LockFile = {
    version: 1,
    models: [{ id: "claude-3-5-sonnet-20241022", route: "anthropic-api", status: "ok", verified_at: "2026-10-01", baseline: "b1" }],
  };
  const lock = lockFromExposure(exposure(f("claude-3-5-sonnet-20241022", "anthropic-api"), f("claude-3-5-sonnet-20241022", "aws-bedrock")), snapshot(), previous);
  const byRoute = new Map(lock.models.map((m) => [m.route, m]));
  assert.equal(byRoute.get("anthropic-api")?.verified_at, "2026-10-01");
  assert.equal(byRoute.get("anthropic-api")?.baseline, "b1");
  assert.equal(byRoute.get("aws-bedrock")?.verified_at, null);
});

test("lockFromExposure: models no longer found are dropped", () => {
  const previous: LockFile = { version: 1, models: [{ id: "gone", route: "r", status: "ok", verified_at: "x", baseline: "y" }] };
  assert.equal(lockFromExposure([], snapshot(), previous).models.length, 0);
});

test("lock written from exposure is accepted by readLock", async () => {
  await withProject({}, async (root) => {
    const lock = lockFromExposure(exposure(f("gpt-4o", "openai-api"), f("gemini-2.0-flash", "google-ai-studio")), snapshot());
    await writeLock(root, lock);
    assert.deepEqual(await readLock(root), lock);
  });
});

test("a pre-existing regular file is replaced atomically", async () => {
  await withProject({}, async (root) => {
    await writeFile(path.join(root, "models.lock"), "old");
    await writeLock(root, sample);
    assert.deepEqual(await readLock(root), sample);
  });
});
