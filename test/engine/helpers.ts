import { readFileSync } from "node:fs";
import type { Check, RegistrySnapshot, TestCase } from "../../src/types.ts";

export const snapshot: RegistrySnapshot = JSON.parse(readFileSync(new URL("../fixtures/engine-snapshot.json", import.meta.url), "utf8"));

export function makeCase(id: string, checks: Check[] = [{ type: "json_valid" }], extra: Partial<TestCase> = {}): TestCase {
  return { id, origin: "team", accepted: true, messages: [{ role: "user", content: `prompt:${id}` }], checks, max_tokens: 64, ...extra };
}

export function makeCases(count: number, checks?: Check[]): TestCase[] {
  return Array.from({ length: count }, (_, index) => makeCase(`case-${index}`, checks));
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

export const noSleep = async (): Promise<void> => {};
