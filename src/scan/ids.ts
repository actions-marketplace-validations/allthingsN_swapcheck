import type { RegistryModel, RegistrySnapshot } from "../types.ts";

/** What the registry knows, indexed for lookups while scanning. */
export interface ModelIndex {
  known: Set<string>;
  /** Routes each model ID is served on. */
  routes: Map<string, Set<string>>;
  rows: Map<string, RegistryModel>;
  providers: Map<string, string>;
  allRoutes: Set<string>;
}

export const ROUTE_BEDROCK = "aws-bedrock";
export const ROUTE_VERTEX = "google-vertex";
export const ROUTE_AZURE = "azure-openai";
export const ROUTE_OPENROUTER = "openrouter";

const FIRST_PARTY_ROUTE: Record<string, string> = {
  openai: "openai-api",
  anthropic: "anthropic-api",
  google: "google-ai-studio",
  xai: "xai-api",
  mistral: "mistral-api",
  deepseek: "deepseek-api",
  moonshot: "moonshot-api",
  alibaba: "alibaba-api",
  zhipu: "zhipu-api",
  cohere: "cohere-api",
  meta: "meta-api",
};

function rowKey(id: string, route: string): string {
  return `${id}\0${route}`;
}

export function buildIndex(snapshot: RegistrySnapshot): ModelIndex {
  const index: ModelIndex = { known: new Set(), routes: new Map(), rows: new Map(), providers: new Map(), allRoutes: new Set() };
  const addRoute = (id: string, route: string, provider: string): void => {
    index.known.add(id);
    index.allRoutes.add(route);
    if (!index.routes.has(id)) index.routes.set(id, new Set());
    index.routes.get(id)?.add(route);
    if (!index.providers.has(id)) index.providers.set(id, provider);
  };
  for (const model of snapshot.models) {
    addRoute(model.id, model.route, model.provider);
    index.rows.set(rowKey(model.id, model.route), model);
  }
  for (const event of snapshot.events) {
    addRoute(event.model, event.route, event.provider);
    if (event.to) index.known.add(event.to);
  }
  return index;
}

export function lookupRow(index: ModelIndex, id: string, route: string | undefined): RegistryModel | undefined {
  return route === undefined ? undefined : index.rows.get(rowKey(id, route));
}

const HAS_DIGIT = /\d/;

type VendorRule = { vendor: string; pattern: RegExp; guard?: RegExp };

// Every pattern is anchored, lowercase and free of nested ambiguous quantifiers.
const VENDOR_RULES: VendorRule[] = [
  { vendor: "openai", pattern: /^gpt-(?:\d+(?:\.\d+)?[a-z]?|oss|image)(?:-[a-z0-9.]+)*$/ },
  { vendor: "openai", pattern: /^chatgpt-\d[a-z0-9.-]*$/ },
  { vendor: "openai", pattern: /^o[134](?:-[a-z0-9]+)*$/ },
  { vendor: "openai", pattern: /^text-embedding-(?:3-small|3-large|ada-002)$/ },
  { vendor: "openai", pattern: /^(?:text-davinci-\d{3}|davinci-00\d|babbage-00\d|whisper-1|tts-1(?:-hd)?|dall-e-[23])$/ },
  { vendor: "anthropic", pattern: /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*(?:@\d{8})?$/, guard: /\d|-latest$/ },
  { vendor: "google", pattern: /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/, guard: /\d|-(?:pro|flash|ultra)(?:-|$)|-latest$/ },
  { vendor: "google", pattern: /^gemma-?\d[a-z0-9.-]*$/ },
  { vendor: "xai", pattern: /^grok-(?:\d|beta|vision|code)[a-z0-9.-]*$/ },
  { vendor: "meta", pattern: /^(?:meta-)?llama-?\d[a-z0-9.-]*$/ },
  { vendor: "meta", pattern: /^llama-(?:guard|prompt-guard)-\d[a-z0-9.-]*$/ },
  { vendor: "mistral", pattern: /^(?:open-)?(?:mistral|mixtral|codestral|devstral|magistral|pixtral|ministral|voxtral)-[a-z0-9.-]+$/, guard: /\d|-latest$|^mistral-(?:tiny|small|medium|large|nemo|saba)$|^open-mistral-nemo$/ },
  { vendor: "deepseek", pattern: /^deepseek-(?:chat|reasoner|coder|r\d|v\d)[a-z0-9.-]*$/ },
  { vendor: "moonshot", pattern: /^kimi-(?:k\d|latest|thinking)[a-z0-9.-]*$/ },
  { vendor: "moonshot", pattern: /^moonshot-v\d[a-z0-9.-]*$/ },
  { vendor: "alibaba", pattern: /^qwen(?:\d(?:\.\d+)?)?-[a-z0-9.-]+$/, guard: /\d|^qwen-(?:max|plus|turbo|long|coder)/ },
  { vendor: "alibaba", pattern: /^qwq-[a-z0-9.-]+$/ },
  { vendor: "zhipu", pattern: /^(?:chat)?glm-(?:\d|z\d)[a-z0-9.-]*$/ },
  { vendor: "cohere", pattern: /^command-(?:r|a|light|nightly)[a-z0-9.-]*$/ },
];

/** The vendor whose naming scheme `id` follows, or undefined. Filenames and prose never match. */
export function vendorOfId(id: string): string | undefined {
  for (const rule of VENDOR_RULES) {
    if (rule.pattern.test(id) && (!rule.guard || rule.guard.test(id))) return rule.vendor;
  }
  return undefined;
}

const FILE_EXTENSION = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonl|py|pyi|rb|go|rs|java|c|h|cpp|css|scss|sass|less|html|htm|svg|png|jpe?g|gif|webp|ico|pdf|mp3|mp4|wav|ya?ml|toml|ini|md|mdx|txt|csv|tsv|log|lock|bin|gguf|ggml|pt|pth|onnx|safetensors|tar|gz|tgz|zip)$/i;
const ALLOWED_CHARS = /^[A-Za-z0-9._:/@[\]-]+$/;
const BAD_START = /^[./~@#$%-]/;
// OpenRouter's rolling aliases start with `~`, which the scanner's lookalike check does not accept.
const MODEL_ID_CHARS = /^[A-Za-z0-9._:/@[\]~-]+$/;
const MAX_MODEL_ID = 256;

/** True when a value can be written into source as a model ID: no quotes, spaces, escapes or newlines. */
export function isSafeModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_ID && MODEL_ID_CHARS.test(value);
}

/** Rejects URLs, paths, filenames, scoped packages and anything with spaces before pattern checks. */
export function isLookalike(value: string): boolean {
  if (value.length < 2 || value.length > 200) return true;
  if (BAD_START.test(value) || !ALLOWED_CHARS.test(value)) return true;
  if (value.includes("://") || value.includes("//")) return true;
  return FILE_EXTENSION.test(value);
}

interface Form {
  id: string;
  vendor?: string;
  route?: string;
  /** The form follows a strict vendor or platform naming scheme. */
  pattern: boolean;
}

const BEDROCK_VENDORS = "anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|stability|writer|moonshot|moonshotai|google|nvidia|minimax|zai";
const BEDROCK_ID = new RegExp(`^(?:(?:us-gov|us|eu|apac|global|jp|au|ca|sa|me|af)\\.)?(${BEDROCK_VENDORS})\\.([a-z0-9][a-z0-9.-]*)(:\\d+(?::[0-9a-z]+)?)?$`);
const BEDROCK_REGION_PREFIX = /^(?:us-gov|us|eu|apac|global|jp|au|ca|sa|me|af)\./;
const BEDROCK_ARN = /^arn:aws[a-z-]*:bedrock:[a-z0-9-]*:\d*:(?:foundation-model|inference-profile)\/([A-Za-z0-9.:-]+)$/;
const VERTEX_PATH = /^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/([a-z0-9-]+)\/models\/([A-Za-z0-9._@-]+)$/;
const GEMINI_RESOURCE = /^(?:tunedModels|models)\/([a-z0-9.-]+)$/;
const VENDOR_COLON = /^(openai|anthropic|google-gla|google-vertex|google_genai|google_vertexai|bedrock|bedrock_converse|groq|mistral|mistralai|cohere|deepseek|xai|azure|azure_openai):(.+)$/;
const FINE_TUNE = /^ft:([a-z0-9.-]+):[A-Za-z0-9._:-]*$/;

const BEDROCK_VENDOR_NAME: Record<string, string> = { moonshotai: "moonshot", qwen: "alibaba", zai: "zhipu" };

type PrefixInfo = { vendor?: string; route?: string };

const ROUTER_PREFIXES: Record<string, PrefixInfo> = {
  openrouter: { route: ROUTE_OPENROUTER },
  openai: { vendor: "openai" },
  anthropic: { vendor: "anthropic" },
  azure: { route: ROUTE_AZURE, vendor: "openai" },
  azure_ai: { route: ROUTE_AZURE },
  bedrock: { route: ROUTE_BEDROCK },
  bedrock_converse: { route: ROUTE_BEDROCK },
  converse: { route: ROUTE_BEDROCK },
  vertex_ai: { route: ROUTE_VERTEX },
  vertex_ai_beta: { route: ROUTE_VERTEX },
  gemini: { route: "google-ai-studio", vendor: "google" },
  groq: { route: "groq" },
  together_ai: { route: "together" },
  fireworks_ai: { route: "fireworks" },
  mistral: { vendor: "mistral" },
  deepseek: { vendor: "deepseek" },
  xai: { vendor: "xai" },
  cohere: { vendor: "cohere" },
  moonshot: { vendor: "moonshot" },
  dashscope: { vendor: "alibaba" },
  "meta-llama": { vendor: "meta" },
  mistralai: { vendor: "mistral" },
  "deepseek-ai": { vendor: "deepseek" },
  qwen: { vendor: "alibaba" },
  moonshotai: { vendor: "moonshot" },
  google: { vendor: "google" },
  "x-ai": { vendor: "xai" },
  "z-ai": { vendor: "zhipu" },
  "zai-org": { vendor: "zhipu" },
  thudm: { vendor: "zhipu" },
};

const COLON_PREFIXES: Record<string, PrefixInfo> = {
  openai: { vendor: "openai" },
  anthropic: { vendor: "anthropic" },
  "google-gla": { vendor: "google", route: "google-ai-studio" },
  google_genai: { vendor: "google", route: "google-ai-studio" },
  "google-vertex": { vendor: "google", route: ROUTE_VERTEX },
  google_vertexai: { vendor: "google", route: ROUTE_VERTEX },
  bedrock: { route: ROUTE_BEDROCK },
  bedrock_converse: { route: ROUTE_BEDROCK },
  groq: { route: "groq" },
  mistral: { vendor: "mistral" },
  mistralai: { vendor: "mistral" },
  cohere: { vendor: "cohere" },
  deepseek: { vendor: "deepseek" },
  xai: { vendor: "xai" },
  azure: { vendor: "openai", route: ROUTE_AZURE },
  azure_openai: { vendor: "openai", route: ROUTE_AZURE },
};

function bedrockForms(id: string): Form[] {
  const match = BEDROCK_ID.exec(id);
  // Module paths such as `openai.chat` have no version; real Bedrock IDs always do.
  if (!match || !HAS_DIGIT.test(match[2] ?? "") || !(match[2] ?? "").includes("-")) return [];
  const vendor = BEDROCK_VENDOR_NAME[match[1] ?? ""] ?? match[1];
  const forms: Form[] = [{ id, vendor, route: ROUTE_BEDROCK, pattern: true }];
  const unprefixed = id.replace(BEDROCK_REGION_PREFIX, "");
  if (unprefixed !== id) forms.push({ id: unprefixed, vendor, route: ROUTE_BEDROCK, pattern: true });
  return forms;
}

function applyPrefix(rest: string, info: PrefixInfo, depth: number): Form[] {
  const inner = expandForms(rest, depth + 1);
  const lowered = rest.toLowerCase();
  if (lowered !== rest && vendorOfId(lowered)) inner.push({ id: rest, vendor: vendorOfId(lowered), pattern: true });
  return inner.map((form) => ({ ...form, vendor: form.vendor ?? info.vendor, route: info.route ?? form.route }));
}

/** Every reading of a string as a model ID, most literal first. */
function expandForms(raw: string, depth = 0): Form[] {
  const clean = raw.endsWith("[1m]") ? raw.slice(0, -4) : raw;
  const vendor = vendorOfId(clean);
  const forms: Form[] = [{ id: clean, vendor, pattern: vendor !== undefined }];
  if (depth > 2) return forms;

  const arn = BEDROCK_ARN.exec(clean);
  if (arn?.[1]) return [...forms, ...bedrockForms(arn[1])];

  const vertex = VERTEX_PATH.exec(clean);
  if (vertex?.[2]) {
    const id = vertex[2];
    const out: Form[] = [{ id, vendor: vertex[1], route: ROUTE_VERTEX, pattern: vendorOfId(id) !== undefined || id.includes("@") }];
    if (id.includes("@")) out.push({ id: id.replace("@", "-"), vendor: vertex[1], route: ROUTE_VERTEX, pattern: true });
    return [...forms, ...out];
  }

  const gemini = GEMINI_RESOURCE.exec(clean);
  if (gemini?.[1] && vendorOfId(gemini[1]) === "google") {
    return [...forms, { id: gemini[1], vendor: "google", route: "google-ai-studio", pattern: true }];
  }

  const fineTune = FINE_TUNE.exec(clean);
  if (fineTune?.[1] && vendorOfId(fineTune[1])) {
    return [{ id: clean, vendor: vendorOfId(fineTune[1]), pattern: true }];
  }

  const bedrock = bedrockForms(clean);
  if (bedrock.length > 0) return [...forms.filter((form) => form.id !== clean), ...bedrock];

  const colon = VENDOR_COLON.exec(clean);
  if (colon?.[1] && colon[2]) return [...forms, ...applyPrefix(colon[2], COLON_PREFIXES[colon[1]] ?? {}, depth)];

  const slash = clean.indexOf("/");
  if (slash > 0) {
    const info = ROUTER_PREFIXES[clean.slice(0, slash).toLowerCase()];
    if (info) return [...forms, ...applyPrefix(clean.slice(slash + 1), info, depth)];
    return forms;
  }

  if (vendor === "anthropic" && clean.includes("@")) {
    return [{ id: clean, vendor, route: ROUTE_VERTEX, pattern: true }, { id: clean.replace("@", "-"), vendor, route: ROUTE_VERTEX, pattern: true }];
  }
  return forms;
}

export interface Recognition {
  model: string;
  known: boolean;
  vendor?: string;
  /** Set when the ID's own form proves the route, which nearby code must not override. */
  fixedRoute?: string;
}

/**
 * Registry matches win; naming patterns count only in model context.
 * A short known ID such as `o1` outside model context is too ambiguous to report.
 */
export function recognize(raw: string, index: ModelIndex, inContext: boolean): Recognition | null {
  if (isLookalike(raw)) return null;
  const forms = expandForms(raw);
  for (const form of forms) {
    if (!index.known.has(form.id)) continue;
    if (!inContext && !(form.pattern && form.id.length >= 5)) return null;
    return { model: form.id, known: true, vendor: form.vendor, fixedRoute: form.route };
  }
  if (!inContext) return null;
  for (const form of forms) {
    if (form.pattern) return { model: form.id, known: false, vendor: form.vendor, fixedRoute: form.route };
  }
  return null;
}

const NOT_MODEL_TAILS = new Set([
  "path", "dir", "directory", "file", "filename", "folder", "type", "types", "class", "provider", "providers", "kwargs", "args", "params",
  "parameters", "config", "configs", "settings", "options", "version", "url", "uri", "endpoint", "key", "token", "tokens", "size", "count",
  "cache", "registry", "schema", "field", "fields", "form", "view", "manager", "factory", "loader", "state", "store", "list", "family",
]);

const MODEL_WORDS = new Set(["model", "models", "llm", "llms", "modelid", "modelname", "modelarn"]);
const ROUTE_TAIL_WORDS = new Set(["engine", "engines", "deployment", "deployments"]);
const DEPLOYMENT_NAME_TAILS = new Set(["name", "id"]);

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** True for names like model, modelName, model_id, OPENAI_MODEL, engine, azure_deployment. */
export function isModelKey(name: string): boolean {
  if (name.length > 80) return false;
  const words = splitWords(name);
  const last = words[words.length - 1];
  if (last === undefined || NOT_MODEL_TAILS.has(last)) return false;
  if (words.some((word) => MODEL_WORDS.has(word))) return true;
  if (ROUTE_TAIL_WORDS.has(last)) return true;
  if (DEPLOYMENT_NAME_TAILS.has(last) && words.some((word) => ROUTE_TAIL_WORDS.has(word))) return true;
  return words.includes("inference") && words.includes("profile");
}

const GENERIC_CHILD_KEYS = new Set(["name", "id", "value", "default", "primary", "fallback"]);

/** A nested key such as `model: { name: ... }` inherits model context from its parent. */
export function isGenericChildKey(name: string): boolean {
  return GENERIC_CHILD_KEYS.has(name.toLowerCase());
}

const PRICE_WORDS = new Set(["price", "prices", "pricing", "cost", "costs", "rate", "rates", "tariff", "tariffs", "fee", "fees", "billing"]);

export function isPriceKey(name: string): boolean {
  return splitWords(name).some((word) => PRICE_WORDS.has(word));
}

/** Prefers the exact registry route name for a platform, whatever the registry calls it. */
export function canonicalRoute(index: ModelIndex, route: string): string {
  if (index.allRoutes.has(route)) return route;
  const marker = /bedrock|vertex|azure|openrouter|groq|together|fireworks/.exec(route)?.[0];
  if (!marker) return route;
  for (const candidate of index.allRoutes) {
    if (candidate.includes(marker)) return candidate;
  }
  return route;
}

/** The vendor's own API, read from the registry when it lists the model. */
export function firstPartyRoute(index: ModelIndex, model: string, vendor: string | undefined): string | undefined {
  const expected = vendor === undefined ? undefined : FIRST_PARTY_ROUTE[vendor];
  const routes = index.routes.get(model);
  if (!routes || routes.size === 0) return expected;
  if (expected !== undefined && routes.has(expected)) return expected;
  if (routes.size === 1) return [...routes][0];
  if (vendor !== undefined) {
    for (const route of routes) {
      if (route.startsWith(`${vendor}-`)) return route;
    }
  }
  return expected;
}

export function firstPartyRouteFor(vendor: string): string | undefined {
  return FIRST_PARTY_ROUTE[vendor];
}
