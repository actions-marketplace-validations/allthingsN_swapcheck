import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultCacheDir, loadRegistry, validateSnapshot } from "../../src/registry/client.ts";
import type { LoadRegistryOptions } from "../../src/registry/client.ts";
import { REGISTRY_PUBLIC_KEY_PEM as PINNED } from "../../src/registry/public-key.ts";
import { REGISTRY_PUBLIC_KEY_PEM, verifySnapshot } from "../../src/registry/verify.ts";
import { sha256 } from "../../src/util/hash.ts";
import type { RegistrySnapshot } from "../../src/types.ts";
import { snapshot } from "./helpers.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const URL_A = "https://registry.test/snapshot.json";
const NOW = new Date("2026-11-09T12:00:00Z");
const HOUR = 3600 * 1000;

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const signOf = (bytes: Uint8Array, key = privateKey): string => sign(null, bytes, key).toString("base64");

function fakeFetch(body: Uint8Array | string, signature: string, status = 200): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response(url.endsWith(".sig") ? signature : (body as BodyInit), { status });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

async function withCache<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "swapcheck-cache-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noFetch = (async () => {
  throw new Error("network down");
}) as typeof fetch;

const options = (cacheDir: string, extra: LoadRegistryOptions = {}): LoadRegistryOptions => ({
  url: URL_A,
  cacheDir,
  now: NOW,
  publicKeyPem: PEM,
  fetchImpl: noFetch,
  loadBundled: async () => ({ ...snapshot(), generated_at: "2026-10-01T00:00:00Z" }),
  ...extra,
});

async function seedCache(cacheDir: string, url: string, bytes: Uint8Array, signature: string, fetchedAt: Date): Promise<string> {
  const dir = path.join(cacheDir, sha256(url).slice(0, 16));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "snapshot.json"), bytes);
  await writeFile(path.join(dir, "snapshot.json.sig"), signature);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({ fetched_at: fetchedAt.toISOString() }));
  return dir;
}

test("verify: re-exports the pinned key", () => {
  assert.equal(REGISTRY_PUBLIC_KEY_PEM, PINNED);
});

test("verify: accepts a good signature", () => {
  const bytes = encode({ a: 1 });
  assert.equal(verifySnapshot(bytes, signOf(bytes), PEM), true);
});

test("verify: tolerates surrounding whitespace in the signature file", () => {
  const bytes = encode({ a: 1 });
  assert.equal(verifySnapshot(bytes, `${signOf(bytes)}\n`, PEM), true);
});

test("verify: rejects one changed byte", () => {
  const bytes = encode({ a: 1 });
  const signature = signOf(bytes);
  const tampered = Uint8Array.from(bytes);
  tampered[2] = (tampered[2] ?? 0) ^ 1;
  assert.equal(verifySnapshot(tampered, signature, PEM), false);
});

test("verify: rejects a signature from another key", () => {
  const bytes = encode({ a: 1 });
  assert.equal(verifySnapshot(bytes, signOf(bytes, other.privateKey), PEM), false);
});

test("verify: the pinned key rejects a signature from any test key", () => {
  const bytes = encode({ a: 1 });
  assert.equal(verifySnapshot(bytes, signOf(bytes)), false);
});

test("verify: malformed signatures return false instead of throwing", () => {
  const bytes = encode({ a: 1 });
  for (const signature of ["", "not base64!!!", "AAAA", "A".repeat(200), `${signOf(bytes)}extra`]) {
    assert.equal(verifySnapshot(bytes, signature, PEM), false, signature.slice(0, 20));
  }
});

test("verify: a bad or non-Ed25519 key returns false", () => {
  const bytes = encode({ a: 1 });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifySnapshot(bytes, signOf(bytes), "junk"), false);
  assert.equal(verifySnapshot(bytes, signOf(bytes), rsa), false);
});

test("validate: accepts the fixture", () => {
  assert.ok(validateSnapshot(snapshot()));
});

const corruptions: Array<[string, (s: any) => void]> = [
  ["wrong version", (s) => (s.version = 2)],
  ["bad generated_at", (s) => (s.generated_at = "soon")],
  ["events not a list", (s) => (s.events = {})],
  ["models missing", (s) => delete s.models],
  ["unknown event type", (s) => (s.events[0].type = "explode")],
  ["bad effective format", (s) => (s.events[0].effective = "12/01/2026")],
  ["impossible effective date", (s) => (s.events[0].effective = "2026-02-31")],
  ["event missing model", (s) => delete s.events[0].model],
  ["bad confidence", (s) => (s.events[0].confidence = "certain")],
  ["params not strings", (s) => (s.events[0].params = [1])],
  ["bad model status", (s) => (s.models[0].status = "beta")],
  ["missing capability", (s) => delete s.models[0].capabilities.tools],
  ["capability not boolean", (s) => (s.models[0].capabilities.tools = "yes")],
  ["negative cost", (s) => (s.models[0].cost.input = -1)],
  ["infinite limit", (s) => (s.models[0].limit.context = Number.POSITIVE_INFINITY)],
  ["empty id", (s) => (s.models[0].id = "")],
  ["overlong id", (s) => (s.models[0].id = "x".repeat(3000))],
  ["bad release date", (s) => (s.models[0].release_date = "last year")],
  ["null row", (s) => (s.models[0] = null)],
];

for (const [name, corrupt] of corruptions) {
  test(`validate: rejects ${name}`, () => {
    const value = snapshot();
    corrupt(value);
    assert.equal(validateSnapshot(value), null);
  });
}

test("validate: accepts month-only release dates", () => {
  const value = snapshot();
  value.models[0]!.release_date = "2024-05";
  assert.ok(validateSnapshot(value));
});

test("validate: rejects non-objects", () => {
  for (const value of [null, 1, "x", [], undefined]) assert.equal(validateSnapshot(value), null);
});

test("remote: a verified snapshot is returned and cached", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    const fetchImpl = fakeFetch(bytes, signOf(bytes));
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl }));
    assert.equal(loaded.source, "remote");
    assert.equal(loaded.age_days, 8);
    assert.deepEqual(fetchImpl.calls, [URL_A, `${URL_A}.sig`]);
    const [entry] = await readdir(cacheDir);
    assert.deepEqual(await readFile(path.join(cacheDir, entry!, "snapshot.json")), Buffer.from(bytes));
  });
});

test("cache: within 24 hours the network is not touched", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode({ ...snapshot(), generated_at: "2026-11-08T00:00:00Z" });
    await seedCache(cacheDir, URL_A, bytes, signOf(bytes), new Date(NOW.getTime() - 23 * HOUR));
    const fetchImpl = fakeFetch("", "", 500);
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl }));
    assert.equal(loaded.source, "cache");
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("cache: after 24 hours a new copy is fetched", async () => {
  await withCache(async (cacheDir) => {
    const old = encode({ ...snapshot(), generated_at: "2026-09-01T00:00:00Z" });
    await seedCache(cacheDir, URL_A, old, signOf(old), new Date(NOW.getTime() - 25 * HOUR));
    const fresh = encode(snapshot());
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(fresh, signOf(fresh)) }));
    assert.equal(loaded.source, "remote");
    assert.equal(loaded.snapshot.generated_at, "2026-11-01T00:00:00Z");
  });
});

test("cache: a fetched_at in the future is not fresh", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    await seedCache(cacheDir, URL_A, bytes, signOf(bytes), new Date(NOW.getTime() + 5 * HOUR));
    const fetchImpl = fakeFetch(bytes, signOf(bytes));
    assert.equal((await loadRegistry(options(cacheDir, { fetchImpl }))).source, "remote");
  });
});

test("cache: different URLs do not share a cache entry", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    await seedCache(cacheDir, "https://other.test/snapshot.json", bytes, signOf(bytes), NOW);
    const fetchImpl = fakeFetch(bytes, signOf(bytes));
    assert.equal((await loadRegistry(options(cacheDir, { fetchImpl }))).source, "remote");
  });
});

test("fallback: network error uses a stale cache", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    await seedCache(cacheDir, URL_A, bytes, signOf(bytes), new Date(NOW.getTime() - 100 * HOUR));
    assert.equal((await loadRegistry(options(cacheDir))).source, "cache");
  });
});

test("fallback: HTTP error uses the bundled snapshot when no cache exists", async () => {
  await withCache(async (cacheDir) => {
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch("nope", "nope", 503) }));
    assert.equal(loaded.source, "bundled");
    assert.equal(loaded.age_days, 39);
  });
});

test("signature failure: remote data is never used or cached", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode({ ...snapshot(), generated_at: "2026-11-08T00:00:00Z" });
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(bytes, signOf(bytes, other.privateKey)) }));
    assert.equal(loaded.source, "bundled");
    assert.notEqual(loaded.snapshot.generated_at, "2026-11-08T00:00:00Z");
    assert.deepEqual(await readdir(cacheDir), []);
  });
});

test("signature failure: tampered body falls back to the cache", async () => {
  await withCache(async (cacheDir) => {
    const good = encode(snapshot());
    await seedCache(cacheDir, URL_A, good, signOf(good), new Date(NOW.getTime() - 100 * HOUR));
    const tampered = encode({ ...snapshot(), events: [] });
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(tampered, signOf(good)) }));
    assert.equal(loaded.source, "cache");
    assert.ok(loaded.snapshot.events.length > 0);
  });
});

test("signature failure: non-JSON bytes are never parsed", async () => {
  await withCache(async (cacheDir) => {
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch("{not json", "A".repeat(86) + "==") }));
    assert.equal(loaded.source, "bundled");
  });
});

test("invalid shape: a correctly signed malformed snapshot is discarded", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode({ ...snapshot(), version: 99 });
    const loaded = await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(bytes, signOf(bytes)) }));
    assert.equal(loaded.source, "bundled");
    assert.deepEqual(await readdir(cacheDir), []);
  });
});

test("invalid shape: correctly signed invalid UTF-8 is discarded", async () => {
  await withCache(async (cacheDir) => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
    assert.equal((await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(bytes, signOf(bytes)) }))).source, "bundled");
  });
});

test("cache tamper: a modified cache file is not trusted, even when fresh", async () => {
  await withCache(async (cacheDir) => {
    const good = encode(snapshot());
    const dir = await seedCache(cacheDir, URL_A, good, signOf(good), NOW);
    await writeFile(path.join(dir, "snapshot.json"), encode({ ...snapshot(), events: [] }));
    assert.equal((await loadRegistry(options(cacheDir))).source, "bundled");
  });
});

test("cache tamper: a missing signature file is a cache miss", async () => {
  await withCache(async (cacheDir) => {
    const good = encode(snapshot());
    const dir = await seedCache(cacheDir, URL_A, good, signOf(good), NOW);
    await rm(path.join(dir, "snapshot.json.sig"));
    assert.equal((await loadRegistry(options(cacheDir))).source, "bundled");
  });
});

test("cache: corrupt meta means stale but still usable as a fallback", async () => {
  await withCache(async (cacheDir) => {
    const good = encode(snapshot());
    const dir = await seedCache(cacheDir, URL_A, good, signOf(good), NOW);
    await writeFile(path.join(dir, "meta.json"), "garbage");
    assert.equal((await loadRegistry(options(cacheDir))).source, "cache");
  });
});

test("oversized remote body is discarded", async () => {
  await withCache(async (cacheDir) => {
    const huge = new Uint8Array(6 * 1024 * 1024);
    assert.equal((await loadRegistry(options(cacheDir, { fetchImpl: fakeFetch(huge, signOf(huge)) }))).source, "bundled");
  });
});

test("plain HTTP registry URLs are refused and fall back", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    const fetchImpl = fakeFetch(bytes, signOf(bytes));
    const loaded = await loadRegistry(options(cacheDir, { url: "http://evil.test/snapshot.json", fetchImpl }));
    assert.equal(loaded.source, "bundled");
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("offline: never touches the network, uses cache of any age", async () => {
  await withCache(async (cacheDir) => {
    const bytes = encode(snapshot());
    await seedCache(cacheDir, URL_A, bytes, signOf(bytes), new Date(NOW.getTime() - 1000 * HOUR));
    const fetchImpl = fakeFetch(bytes, signOf(bytes));
    assert.equal((await loadRegistry(options(cacheDir, { offline: true, fetchImpl }))).source, "cache");
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("offline: with no cache uses the bundled snapshot", async () => {
  await withCache(async (cacheDir) => {
    assert.equal((await loadRegistry(options(cacheDir, { offline: true }))).source, "bundled");
  });
});

test("bundled: an invalid or missing bundle is a plain-sentence error", async () => {
  await withCache(async (cacheDir) => {
    await assert.rejects(() => loadRegistry(options(cacheDir, { loadBundled: async () => ({ version: 1 }) })), /bundled with Swapcheck is missing or invalid/);
    await assert.rejects(() => loadRegistry(options(cacheDir, { loadBundled: async () => { throw new Error("gone"); } })), /Reinstall Swapcheck/);
  });
});

test("age_days never goes negative for a snapshot dated in the future", async () => {
  await withCache(async (cacheDir) => {
    const loaded = await loadRegistry(options(cacheDir, { loadBundled: async () => ({ ...snapshot(), generated_at: "2027-01-01T00:00:00Z" }) }));
    assert.equal(loaded.age_days, 0);
  });
});

test("a read-only cache folder does not stop a remote load", async () => {
  await withCache(async (cacheDir) => {
    const blocked = path.join(cacheDir, "file");
    await writeFile(blocked, "x");
    const bytes = encode(snapshot());
    const loaded = await loadRegistry(options(path.join(blocked, "nested"), { fetchImpl: fakeFetch(bytes, signOf(bytes)) }));
    assert.equal(loaded.source, "remote");
  });
});

test("default cache folder per platform", () => {
  // Paths are joined with the host's separator, so compare in forward slashes.
  const slash = (p: string): string => p.split(path.sep).join("/");
  assert.match(slash(defaultCacheDir({}, "darwin")), /Library\/Caches\/swapcheck$/);
  assert.equal(slash(defaultCacheDir({ XDG_CACHE_HOME: "/x" }, "linux")), "/x/swapcheck");
  assert.match(slash(defaultCacheDir({ XDG_CACHE_HOME: "relative" }, "linux")), /\.cache\/swapcheck$/);
  assert.match(defaultCacheDir({ LOCALAPPDATA: "C:\\Local" }, "win32"), /swapcheck/);
});

test("the real bundled snapshot, when present, passes validation", async (t) => {
  const file = new URL("../../data/registry.snapshot.json", import.meta.url);
  let parsed: RegistrySnapshot;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as RegistrySnapshot;
  } catch {
    await withCache(async (cacheDir) => {
      await assert.rejects(() => loadRegistry({ offline: true, cacheDir, now: NOW }), /missing or invalid/);
    });
    t.diagnostic("data/registry.snapshot.json is not built yet; checked the missing-file path instead");
    return;
  }
  assert.ok(validateSnapshot(parsed));
  await withCache(async (cacheDir) => {
    const loaded = await loadRegistry({ offline: true, cacheDir, now: NOW });
    assert.equal(loaded.source, "bundled");
  });
});
