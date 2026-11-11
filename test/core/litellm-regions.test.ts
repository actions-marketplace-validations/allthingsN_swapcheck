import assert from "node:assert/strict";
import { test } from "node:test";
import { itemHeadline, renderExposureMarkdown } from "../../src/cli/render.ts";
import { lockFromExposure, readLock, writeLock } from "../../src/lock.ts";
import { trimBaseUrl } from "../../src/providers/shared.ts";
import { validateSnapshot } from "../../src/registry/client.ts";
import { scanProject } from "../../src/scan/scan.ts";
import { forRegions, profileToken, reaches } from "../../src/scan/regions.ts";
import type { RegistryEvent, RegistryModel, RegistrySnapshot } from "../../src/types.ts";
import { computeExposure, dueItems, watchLock } from "../../src/watch.ts";
import { NOW, withProject } from "./helpers.ts";

const event = (overrides: Partial<RegistryEvent> & Pick<RegistryEvent, "id" | "model" | "route">): RegistryEvent => ({
  type: "retirement",
  provider: "anthropic",
  source: "https://example.com/lifecycle",
  confidence: "high",
  first_seen: "2026-11-01",
  last_verified: "2026-11-01",
  date_precision: "exact",
  ...overrides,
});

const row = (id: string, route: string, provider = "anthropic"): RegistryModel => ({
  id,
  provider,
  route,
  name: id,
  status: "active",
  source: "https://example.com/models",
  capabilities: { tools: true, structured_output: true, reasoning: false, vision: false, audio: false, pdf: false },
  limit: { context: 200_000, output: 8_000 },
  cost: { input: 1, output: 5 },
});

/** A small registry shaped like the real one for the proxy config this release was built against. */
function registry(): RegistrySnapshot {
  return {
    version: 1,
    generated_at: "2026-11-09T00:00:00Z",
    models: [
      row("claude-sonnet-4-5", "anthropic-api"),
      row("claude-haiku-4-5", "anthropic-api"),
      row("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "aws-bedrock"),
      row("us.anthropic.claude-haiku-4-5-20251001-v1:0", "aws-bedrock"),
      row("gpt-4o", "openai-api", "openai"),
    ],
    events: [
      event({ id: "a1", model: "claude-sonnet-4-5", route: "anthropic-api", effective: "2026-11-30", date_precision: "estimated", to: "claude-sonnet-5-5" }),
      event({ id: "a2", model: "claude-opus-4-1-20250805", route: "anthropic-api", effective: "2026-08-05", to: "claude-opus-4-8" }),
      event({ id: "az1", model: "claude-opus-4-1", route: "azure-foundry", effective: "2026-08-05", to: "claude-opus-5" }),
      event({ id: "az2", provider: "openai", model: "gpt-4o-2024-05-13", route: "azure-foundry", effective: "2027-01-14", to: "gpt-5.1" }),
      event({ id: "az3", provider: "openai", model: "gpt-4o-2024-08-06", route: "azure-foundry", effective: "2027-04-14", to: "gpt-5.1" }),
      event({ id: "az4", provider: "openai", model: "gpt-5-mini-2025-08-07", route: "azure-foundry", effective: "2027-07-13", date_precision: "estimated" }),
      event({ id: "o1", provider: "openai", model: "gpt-4o", route: "openai-api", effective: "2027-01-14", date_precision: "estimated" }),
      event({
        id: "b1",
        model: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        route: "aws-bedrock",
        effective: "2026-11-13",
        region_schedule: [{ regions: ["ap-south-1", "eu-west-2"], effective: "2026-11-13" }],
      }),
      event({
        id: "b2",
        model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        route: "aws-bedrock",
        effective: "2026-10-14",
        region_schedule: [{ regions: ["us-east-1", "us-east-2", "us-west-1", "us-west-2"], effective: "2026-10-14" }],
      }),
      event({
        id: "b3",
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        route: "aws-bedrock",
        effective: "2027-04-08",
        region_schedule: [{ regions: ["us-east-1", "us-east-2", "us-west-1", "us-west-2"], effective: "2027-04-08" }],
      }),
      event({
        id: "b4",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        route: "aws-bedrock",
        effective: "2026-11-13",
        region_schedule: [
          { regions: ["ap-south-1"], effective: "2026-11-13" },
          { regions: ["ca-central-1"], effective: "2026-11-27" },
        ],
      }),
    ],
  };
}

const PROXY_CONFIG = `litellm_settings:
  drop_params: true

model_list:
  - model_name: azure-gpt-4o
    litellm_params:
      model: azure/gpt-4o
      api_base: https://example.openai.azure.com/

  - model_name: azure-gpt-5-mini
    litellm_params:
      model: azure/gpt-5-mini

  - model_name: claude-3-7-sonnet
    litellm_params:
      model: bedrock/us.anthropic.claude-3-7-sonnet-20250219-v1:0
      aws_region_name: us-west-2

  - model_name: claude-4-sonnet
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0
      aws_region_name: us-west-2

  - model_name: claude-haiku-4-5
    litellm_params:
      model: bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
      aws_region_name: us-west-2

  - model_name: claude-sonnet-4-5
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0
      aws_region_name: us-west-2

  - model_name: claude-opus-4-1
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0
      aws_region_name: us-west-2

router_settings:
  fallbacks: [{"claude-sonnet-4-5": ["claude-4-sonnet"]}]
`;

async function scanWith(files: Record<string, string>) {
  return withProject(files, (root) => scanProject(root, registry()));
}

test("a LiteLLM proxy config reports the models it calls, never its own route names", async () => {
  const scan = await scanWith({ "litellm_config.yaml": PROXY_CONFIG });
  const models = [...new Set(scan.findings.map((f) => f.model))].sort();
  assert.deepEqual(models, [
    "anthropic.claude-3-7-sonnet-20250219-v1:0",
    "gpt-4o",
    "gpt-5-mini",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-opus-4-1-20250805-v1:0",
    "us.anthropic.claude-sonnet-4-20250514-v1:0",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  ]);
  for (const f of scan.findings) assert.ok(!["claude-3-7-sonnet", "claude-4-sonnet", "claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"].includes(f.model), `${f.model} is a route name`);
  const sonnet37 = scan.findings.find((f) => f.model.includes("claude-3-7"));
  assert.equal(sonnet37?.line, 16);
  assert.deepEqual(sonnet37?.regions, ["profile:us", "us-west-2"]);
  assert.equal(scan.findings.find((f) => f.model === "gpt-4o")?.route, "azure-foundry");
});

test("on the proxy config only the changes that reach its region and deployments are due", async () => {
  const items = computeExposure(await scanWith({ "litellm_config.yaml": PROXY_CONFIG }), registry(), NOW);
  const due = dueItems(items, 30).map((item) => item.model);
  assert.deepEqual(due, ["us.anthropic.claude-sonnet-4-20250514-v1:0"], "only the Sonnet 4 route is already retired in us-west-2");
  const sonnet37 = items.find((item) => item.model.includes("claude-3-7"))!;
  assert.equal(sonnet37.status, "ok", "a retirement in ap-south-1 and eu-west-2 does not reach us-west-2");
  assert.match(itemHeadline(sonnet37), /no change announced for US inference profile or us-west-2; a change is listed only for ap-south-1, eu-west-2/);
  const gpt4o = items.find((item) => item.model === "gpt-4o")!;
  assert.deepEqual(gpt4o.resolved_as, ["gpt-4o-2024-05-13", "gpt-4o-2024-08-06"]);
  assert.equal(gpt4o.days_until, 66, "the soonest Azure version decides");
  assert.match(itemHeadline(gpt4o), /depends on the version deployed; soonest of gpt-4o-2024-05-13, gpt-4o-2024-08-06/);
  const mini = items.find((item) => item.model === "gpt-5-mini")!;
  assert.match(itemHeadline(mini), /^retires around 2027-07-13, .*\(as gpt-5-mini-2025-08-07\)$/);
  assert.ok(!items.some((item) => item.events.some((e) => e.route !== item.route)), "no event is borrowed from another route");
});

test("route names stay out of JSON configs, router fallbacks and Python Routers", async () => {
  const json = await scanWith({
    "config.json": JSON.stringify({
      model_list: [
        { model_name: "claude-opus-4-1", litellm_params: { model: "bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0", aws_region_name: "us-west-2" } },
        { model_name: "fast", litellm_params: { model: "anthropic/claude-sonnet-4-5" }, model_info: { base_model: "claude-sonnet-4-5" } },
      ],
      router_settings: { fallbacks: [{ fast: ["claude-opus-4-1"] }] },
    }, null, 2),
  });
  assert.deepEqual([...new Set(json.findings.map((f) => f.model))].sort(), ["claude-sonnet-4-5", "us.anthropic.claude-opus-4-1-20250805-v1:0"]);
  assert.deepEqual(json.findings.find((f) => f.model.includes("opus"))?.regions, ["profile:us", "us-west-2"], "the region comes from the same list item");

  const py = await scanWith({
    "router.py": `from litellm import Router
router = Router(model_list=[
    {"model_name": "claude-sonnet-4-5", "litellm_params": {"model": "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", "aws_region_name": "us-west-2"}},
    {"model_name": "gpt-4o", "litellm_params": {"model": "azure/gpt-4o"}},
])
reply = router.completion(model="claude-sonnet-4-5", messages=[])
`,
  });
  assert.deepEqual(py.findings.map((f) => `${f.model}@${f.line}`).sort(), ["gpt-4o@4", "us.anthropic.claude-sonnet-4-5-20250929-v1:0@3"]);
});

test("code that calls a proxy by route name is not read as calling that vendor", async () => {
  const scan = await scanWith({
    "proxy/config.yaml": PROXY_CONFIG,
    "app/client.py": `from openai import OpenAI
client = OpenAI(base_url="https://llm.example.com")
client.chat.completions.create(model="claude-opus-4-1", messages=[])
client.chat.completions.create(model="gpt-4o", messages=[])
`,
  });
  const fromClient = scan.findings.filter((f) => f.file === "app/client.py").map((f) => f.model);
  assert.deepEqual(fromClient, ["gpt-4o"], "claude-opus-4-1 is a route the proxy declares; gpt-4o is not");
});

test("a repo without LiteLLM still reports model_name values", async () => {
  const scan = await scanWith({ "settings.yaml": "llm:\n  model_name: claude-sonnet-4-5\n" });
  assert.deepEqual(scan.findings.map((f) => f.model), ["claude-sonnet-4-5"]);
});

test("a bare vendor ID goes to the vendor's API, not to a cloud that also lists it", () => {
  const scan = { root: "/x", files_scanned: 1, unresolved: [], findings: [{ model: "claude-opus-4-1", file: "a.py", line: 1, column: 1, kind: "code" as const, known: true, route: "anthropic-api" }] };
  const [item] = computeExposure(scan, registry(), NOW);
  assert.equal(item?.route, "anthropic-api");
  assert.deepEqual(item?.resolved_as, ["claude-opus-4-1-20250805"], "Anthropic's alias stands for the dated ID");
  assert.equal(item?.events[0]?.source, "https://example.com/lifecycle");
  assert.ok(!item?.events.some((e) => e.route === "azure-foundry"));
});

test("the scanner keeps a bare Anthropic ID on Anthropic's API even when only Azure lists it", async () => {
  const scan = await scanWith({ "a.py": `import anthropic\nanthropic.Anthropic().messages.create(model="claude-opus-4-1", max_tokens=1, messages=[])\n` });
  assert.equal(scan.findings[0]?.route, "anthropic-api");
});

test("region-limited events only apply where the call can run", () => {
  const e = event({ id: "r", model: "m", route: "aws-bedrock", effective: "2026-11-13", region_schedule: [{ regions: ["ap-south-1"], effective: "2026-11-13" }, { regions: ["us-west-2"], effective: "2027-02-01" }] });
  assert.equal(forRegions(e, ["us-west-2"])?.effective, "2027-02-01");
  assert.equal(forRegions(e, ["eu-west-1"]), null);
  assert.equal(forRegions(e, undefined)?.effective, "2026-11-13", "with no known region the earliest date stands");
  assert.equal(forRegions(e, ["profile:apac"])?.effective, "2026-11-13");
  assert.equal(forRegions(e, ["profile:global"])?.effective, "2026-11-13");
  assert.equal(profileToken("bedrock/us.anthropic.claude-x-v1:0"), "profile:us");
  assert.equal(profileToken("us-gov.anthropic.claude-x-v1:0"), "profile:us-gov");
  assert.equal(profileToken("anthropic.claude-x-v1:0"), undefined);
  assert.ok(reaches("profile:us", "us-west-2") && !reaches("profile:us", "us-gov-west-1") && !reaches("profile:us", "ca-central-1"));
});

test("a region-limited change with no known region says where it applies", () => {
  const scan = { root: "/x", files_scanned: 1, unresolved: [], findings: [{ model: "anthropic.claude-3-haiku-20240307-v1:0", file: "a.py", line: 1, column: 1, kind: "code" as const, known: true, route: "aws-bedrock" }] };
  const [item] = computeExposure(scan, registry(), NOW);
  assert.match(itemHeadline(item!), /retires 2026-11-13, in 4 days \(in ap-south-1, ca-central-1\)/);
});

test("code sets the Bedrock region with region_name or an env default", async () => {
  const scan = await scanWith({
    "a.py": `import boto3, os
client = boto3.client("bedrock-runtime", region_name=os.getenv("AWS_REGION", "us-west-2"))
client.converse(modelId="anthropic.claude-3-7-sonnet-20250219-v1:0", messages=[])
`,
  });
  assert.deepEqual(scan.findings[0]?.regions, ["us-west-2"]);
  const [item] = computeExposure(scan, registry(), NOW);
  assert.equal(item?.status, "ok");
});

test("CI warnings keep the date's precision and say why", async () => {
  const items = computeExposure(await scanWith({ "litellm_config.yaml": PROXY_CONFIG }), registry(), NOW);
  const markdown = renderExposureMarkdown("Model changes", items, "2026-11-09");
  assert.match(markdown, /retires around 2027-07-13/);
  assert.doesNotMatch(markdown, /claude-4-sonnet|azure-gpt-4o/, "route names never appear");
});

test("models.lock keeps regions, so watch gives the same answer as scan", async () => {
  await withProject({ "litellm_config.yaml": PROXY_CONFIG }, async (root) => {
    const snapshot = registry();
    const items = computeExposure(await scanProject(root, snapshot), snapshot, NOW);
    await writeLock(root, lockFromExposure(items, snapshot));
    const lock = await readLock(root);
    assert.deepEqual(lock?.models.find((m) => m.id.includes("claude-3-7"))?.regions, ["profile:us", "us-west-2"]);
    const watched = watchLock(lock!, { snapshot, source: "bundled", age_days: 0 }, { failWithinDays: 30, now: NOW });
    assert.deepEqual(watched.due.map((item) => item.model), ["us.anthropic.claude-sonnet-4-20250514-v1:0"]);
  });
});

test("snapshots with a region schedule validate, and malformed schedules are rejected", () => {
  const good = registry();
  assert.ok(validateSnapshot(good));
  const bad = registry();
  (bad.events[7] as unknown as Record<string, unknown>).region_schedule = [{ regions: [], effective: "2026-11-13" }];
  assert.equal(validateSnapshot(bad), null);
  const badDate = registry();
  (badDate.events[7] as unknown as Record<string, unknown>).region_schedule = [{ regions: ["ap-south-1"], effective: "soon" }];
  assert.equal(validateSnapshot(badDate), null);
});

test("trimBaseUrl drops trailing slashes in linear time", () => {
  assert.equal(trimBaseUrl("https://api.example.com///"), "https://api.example.com");
  assert.equal(trimBaseUrl("https://api.example.com"), "https://api.example.com");
  const hostile = `https://x${"/".repeat(200_000)}a`;
  const started = performance.now();
  assert.equal(trimBaseUrl(hostile), hostile);
  assert.ok(performance.now() - started < 50);
});
