import type { CandidateResult, MetricDelta, SwapReport } from "../types.ts";
import { redactSecrets } from "../util/redact.ts";

const MAX_CELL = 120;
const MAX_PROSE = 600;
const ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "[": "&#91;", "]": "&#93;", "(": "&#40;", ")": "&#41;",
  "!": "&#33;", "|": "&#124;", "`": "&#96;", "*": "&#42;", "_": "&#95;", "~": "&#126;", "#": "&#35;&#8203;", "@": "&#64;&#8203;", "\\": "&#92;", ":": "&#58;", "/": "&#47;", ".": "&#46;",
};

/**
 * Makes text from cases or models inert in GitHub Markdown. Colons, slashes and dots are encoded
 * because GitHub turns bare URLs and www. hosts into links. Entities alone do not stop mentions or
 * issue references, which GitHub resolves after decoding, so @ and # also get a zero-width space.
 */
export function escapeMarkdown(text: string, maxLength: number = MAX_CELL): string {
  const flat = redactSecrets(text).replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
  // Commit references auto-link too, so long hex runs are broken up.
  const unlinked = flat.replace(/[0-9a-f]{7,}/gi, (run) => `${run.slice(0, 6)}\u200b${run.slice(6)}`);
  return unlinked.replace(/[&<>[\]()!|`*_~#@\\:/.]/g, (char) => ENTITIES[char]!);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function metric(metricDelta: MetricDelta, format: (value: number) => string): string {
  return `${format(metricDelta.candidate)} (${signedPercent(metricDelta.delta)})`;
}

function verdictLabel(verdict: CandidateResult["verdict"]): string {
  return verdict.replaceAll("_", " ");
}

function candidateRow(candidate: CandidateResult): string {
  const rate = candidate.suite_pass_rate;
  const passRates = `${percent(rate.baseline)} to ${percent(rate.candidate)}`;
  const cost = metric(candidate.cost_usd_per_case, (value) => `$${value.toFixed(5)}`);
  const latency = metric(candidate.latency_ms_p50, (value) => `${Math.round(value)} ms`);
  return `| ${escapeMarkdown(candidate.model)} | ${verdictLabel(candidate.verdict)} | ${passRates} | ${cost} | ${latency} |`;
}

function regressedDetails(candidate: CandidateResult): string[] {
  const confirmed = candidate.cases.filter((row) => row.confirmed);
  if (confirmed.length === 0) return [];
  const lines = ["", `Cases confirmed lower on ${escapeMarkdown(candidate.model)}:`, ""];
  for (const row of confirmed.slice(0, 20)) {
    lines.push(`- ${escapeMarkdown(row.case_id)}: ${row.baseline_passes}/${row.baseline_runs} to ${row.candidate_passes}/${row.candidate_runs} passing`);
  }
  if (confirmed.length > 20) lines.push(`- and ${confirmed.length - 20} more`);
  return lines;
}

/** A compact report for a pull request comment. */
export function renderMarkdown(report: SwapReport): string {
  const lines = [
    `## Swapcheck: ${escapeMarkdown(report.baseline_model)}`,
    "",
    `${report.case_count} ${report.case_count === 1 ? "case" : "cases"}, ${report.runs_per_case} runs each. Spent $${report.spent_usd.toFixed(4)} of $${report.budget_usd.toFixed(2)}.${report.stopped_early ? " The budget stopped the run early." : ""}`,
    "",
  ];
  if (report.candidates.length > 0) {
    lines.push("| Candidate | Verdict | Pass rate | Cost per run | Latency p50 |", "| --- | --- | --- | --- | --- |");
    for (const candidate of report.candidates) lines.push(candidateRow(candidate));
    lines.push("");
    for (const candidate of report.candidates) lines.push(`- ${escapeMarkdown(candidate.model)}: ${escapeMarkdown(candidate.reason, MAX_PROSE)}`);
    for (const candidate of report.candidates) lines.push(...regressedDetails(candidate));
    lines.push("");
  } else {
    lines.push("Baseline only.", "");
  }
  lines.push(`Noise: the model differed from itself on ${report.noise.flagged_cases} of ${report.case_count} cases between two samples.`, "");
  lines.push("### Limits", "");
  for (const limit of report.limits) lines.push(`- ${escapeMarkdown(limit, MAX_PROSE)}`);
  lines.push("");
  return lines.join("\n");
}
