import { createPublicKey, verify } from "node:crypto";
import { REGISTRY_PUBLIC_KEY_PEM } from "./public-key.ts";

export { REGISTRY_PUBLIC_KEY_PEM };

const ED25519_SIGNATURE_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** True only for a well-formed Ed25519 signature over exactly these bytes. Never throws. */
export function verifySnapshot(bytes: Uint8Array, signatureB64: string, publicKeyPem: string = REGISTRY_PUBLIC_KEY_PEM): boolean {
  try {
    const trimmed = signatureB64.trim();
    if (!ED25519_SIGNATURE_B64.test(trimmed)) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, bytes, key, Buffer.from(trimmed, "base64"));
  } catch {
    return false;
  }
}
