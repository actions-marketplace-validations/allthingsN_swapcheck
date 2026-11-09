const PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

const ENV_SECRET = /(KEY|TOKEN|SECRET|PASSWORD)$/;

/** Removes known credential shapes and the values of secret-looking environment variables. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, "[REDACTED]");
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 12 && ENV_SECRET.test(name)) out = out.split(value).join("[REDACTED]");
  }
  return out;
}
