import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistrySnapshot, Requirements, ScanResult } from "../../src/types.ts";
import { scanProject } from "../../src/scan/scan.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "registry.core.json");

export function snapshot(): RegistrySnapshot {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as RegistrySnapshot;
}

export const NOW = new Date("2026-11-09T12:00:00Z");

export async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "swapcheck-core-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function scanFiles(files: Record<string, string>, opts?: { exclude?: string[]; includeDocs?: boolean }): Promise<ScanResult> {
  return withProject(files, (root) => scanProject(root, snapshot(), opts));
}

/** Scans one source string and returns the model IDs found, in order. */
export async function modelsIn(name: string, source: string): Promise<string[]> {
  const result = await scanFiles({ [name]: source });
  return result.findings.map((finding) => finding.model);
}

export function requirements(overrides: Partial<Requirements> = {}): Requirements {
  return { tools: false, structured_output: false, vision: false, audio: false, pdf: false, min_context: 0, min_output: 0, evidence: [], ...overrides };
}
