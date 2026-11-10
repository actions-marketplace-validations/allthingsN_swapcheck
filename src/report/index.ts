import path from "node:path";
import type { ExposureItem, SwapReport } from "../types.ts";
import { EXIT } from "../types.ts";
import { insideRoot, writeInsideRoot } from "../util/paths.ts";
import { redactSecrets } from "../util/redact.ts";

export { renderMarkdown } from "./markdown.ts";
export { renderSarifExposure, renderSarifReport } from "./sarif.ts";
export type { ExposureItem };

const REPORTS_DIR = "swapcheck/reports";

export function renderJson(report: SwapReport): string {
  return `${redactSecrets(JSON.stringify(report, null, 2))}\n`;
}

/** Writes the report under swapcheck/reports and returns its path relative to the project root. */
export async function saveReport(root: string, report: SwapReport): Promise<string> {
  const target = insideRoot(root, path.join(REPORTS_DIR, `${report.id}.json`));
  await writeInsideRoot(root, target, renderJson(report));
  return path.relative(path.resolve(root), target);
}

export function exitCodeFor(report: SwapReport): number {
  if (report.candidates.some((candidate) => candidate.verdict === "REGRESSED")) return EXIT.FAIL;
  if (report.stopped_early || report.candidates.some((candidate) => candidate.verdict === "NOT_ENOUGH_EVIDENCE")) return EXIT.UNMEASURED;
  return EXIT.OK;
}
