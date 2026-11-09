import { SwapcheckError } from "./errors.ts";
import { EXIT } from "../types.ts";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Reads a response body, stopping at `limit` bytes so a hostile server cannot exhaust memory. */
export async function readLimited(res: Response, limit: number = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SwapcheckError(`A response from ${new URL(res.url || "http://unknown").host} was larger than ${limit} bytes, so it was discarded.`, EXIT.UNMEASURED);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function requireHttps(url: string): void {
  const parsed = new URL(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !local) {
    throw new SwapcheckError(`${parsed.origin} is not HTTPS. Swapcheck only sends keys and fetches data over HTTPS, except on localhost.`);
  }
}
