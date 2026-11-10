import type { Provider, RegistryModel, RegistrySnapshot } from "../types.ts";
import { EXIT } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAIProvider } from "./openai.ts";

export { createAnthropicProvider, createGeminiProvider, createOpenAIProvider };
export { createMockProvider } from "./mock.ts";
export type { MockBehavior } from "./mock.ts";
export { DEFAULT_MAX_OUTPUT_TOKENS, MAX_ATTEMPTS, ProviderError } from "./shared.ts";
export type { BudgetedRequest, NormalizedResponse } from "./shared.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const PREFIX_VENDORS: Array<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(gpt-|chatgpt|o\d(-|$)|text-embedding|davinci)/, "openai"],
  [/^gemini/, "google"],
  [/^(mistral|mixtral|codestral|pixtral|magistral)/, "mistral"],
  [/^(llama|meta-llama)/, "meta"],
  [/^deepseek/, "deepseek"],
  [/^grok/, "xai"],
  [/^(qwen|qwq)/, "alibaba"],
  [/^command/, "cohere"],
];

export function findModel(model: string, snapshot: RegistrySnapshot, route?: string): RegistryModel | undefined {
  const matches = snapshot.models.filter((entry) => entry.id === model);
  return (route ? matches.find((entry) => entry.route === route) : undefined) ?? matches[0];
}

/** The company behind a model: registry first, then its slash prefix, then its name. */
export function vendorOf(model: string, snapshot: RegistrySnapshot): string {
  const entry = findModel(model, snapshot);
  if (entry) return entry.provider.toLowerCase();
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  if (slash > 0) {
    const prefix = lower.slice(0, slash);
    if (prefix === "models") return vendorOf(lower.slice(slash + 1), snapshot);
    return prefix === "meta-llama" ? "meta" : prefix;
  }
  for (const [pattern, vendor] of PREFIX_VENDORS) if (pattern.test(lower)) return vendor;
  return "unknown";
}

function requireKey(env: NodeJS.ProcessEnv, name: string, forWhat: string): string {
  const value = env[name];
  if (!value) throw new SwapcheckError(`${forWhat} needs an API key. Set the ${name} environment variable and run again.`, EXIT.USAGE);
  return value;
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function resolveProvider(
  model: string,
  route: string | undefined,
  snapshot: RegistrySnapshot,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Provider {
  const effectiveRoute = (route ?? findModel(model, snapshot)?.route ?? "").toLowerCase();
  const vendor = vendorOf(model, snapshot);

  if (effectiveRoute.includes("openrouter")) {
    return createOpenAIProvider({ apiKey: requireKey(env, "OPENROUTER_API_KEY", `Route ${effectiveRoute}`), baseUrl: OPENROUTER_BASE_URL, label: "OpenRouter", keepVendorPrefix: true, fetchImpl });
  }

  const unsupportedRoute = /bedrock|vertex|azure/.test(effectiveRoute);
  if (unsupportedRoute) {
    throw new SwapcheckError(`Swapcheck cannot call the ${effectiveRoute} route directly. Test ${model} through OpenRouter by setting OPENROUTER_API_KEY and the route to openrouter, or through a compatible endpoint with SWAPCHECK_OPENAI_BASE_URL.`, EXIT.USAGE);
  }

  if (vendor === "anthropic" || effectiveRoute.startsWith("anthropic")) {
    return createAnthropicProvider({ apiKey: requireKey(env, "ANTHROPIC_API_KEY", `Model ${model}`), baseUrl: env.SWAPCHECK_ANTHROPIC_BASE_URL, fetchImpl });
  }
  if (vendor === "google" || vendor === "gemini" || effectiveRoute.startsWith("google")) {
    const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
    if (!apiKey) throw new SwapcheckError(`Model ${model} needs an API key. Set the GEMINI_API_KEY or GOOGLE_API_KEY environment variable and run again.`, EXIT.USAGE);
    return createGeminiProvider({ apiKey, baseUrl: env.SWAPCHECK_GEMINI_BASE_URL, fetchImpl });
  }

  const customBase = env.SWAPCHECK_OPENAI_BASE_URL;
  if (customBase) {
    const apiKey = env.OPENAI_API_KEY ?? (isLocal(customBase) ? "" : requireKey(env, "OPENAI_API_KEY", `The endpoint in SWAPCHECK_OPENAI_BASE_URL`));
    return createOpenAIProvider({ apiKey, baseUrl: customBase, label: "OpenAI-compatible endpoint", keepVendorPrefix: true, fetchImpl });
  }
  if (vendor === "openai" || effectiveRoute.startsWith("openai")) {
    return createOpenAIProvider({ apiKey: requireKey(env, "OPENAI_API_KEY", `Model ${model}`), fetchImpl });
  }
  if (env.OPENROUTER_API_KEY) {
    return createOpenAIProvider({ apiKey: env.OPENROUTER_API_KEY, baseUrl: OPENROUTER_BASE_URL, label: "OpenRouter", keepVendorPrefix: true, fetchImpl });
  }
  throw new SwapcheckError(`Swapcheck does not know how to reach model ${model}. Set OPENROUTER_API_KEY to use OpenRouter, or SWAPCHECK_OPENAI_BASE_URL for an OpenAI-compatible endpoint.`, EXIT.USAGE);
}
