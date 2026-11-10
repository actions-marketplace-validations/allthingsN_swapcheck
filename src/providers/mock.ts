import type { Provider, ProviderRequest, ProviderResponse } from "../types.ts";

export interface MockBehavior {
  (req: ProviderRequest, callIndex: number): Partial<ProviderResponse> | Promise<Partial<ProviderResponse>>;
}

/** A provider for tests: no network, no keys. Unset fields get plain defaults. */
export function createMockProvider(behavior: MockBehavior, name: string = "mock"): Provider {
  let callIndex = 0;
  return {
    name,
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const partial = await behavior(req, callIndex++);
      const text = partial.text ?? "";
      return {
        ...partial,
        text,
        tool_calls: partial.tool_calls ?? [],
        usage: partial.usage ?? { input_tokens: 10, output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
        latency_ms: partial.latency_ms ?? 1,
        served_model: partial.served_model ?? req.model,
        finish_reason: partial.finish_reason ?? "stop",
      };
    },
  };
}
