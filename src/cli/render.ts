import type { LoadedRegistry } from "../registry/client.ts";
import type { CandidateResult, ExposureItem, FindResult, RegistryEvent, ScanResult, SwapReport, Verdict, WatchResult } from "../types.ts";
import { alignRows, clean, mdEscape, mdLink, pct, plural, usd, type Styler } from "./output.ts";

const MAX_LOCATIONS_SHOWN = 3;
const MAX_EVENTS_SHOWN = 3;

/** computeExposure already puts the event that decides the status first; keep that order. */
function orderedEvents(item: ExposureItem): RegistryEvent[] {
  return item.events;
}

const PAST_WORD: Record<RegistryEvent["type"], string> = {
  retirement: "retired",
  reroute: "rerouted",
  alias_move: "alias moved",
  price_change: "price changed",
  parameter_change: "parameters changed",
  capability_change: "capabilities changed",
  new_model: "new model",
};

function hasLanded(event: RegistryEvent, now: Date = new Date()): boolean {
  return event.effective !== undefined && event.date_precision !== "earliest_possible" && event.effective < now.toISOString().slice(0, 10);
}

const EVENT_WORD: Record<RegistryEvent["type"], string> = {
  retirement: "retires",
  reroute: "reroutes",
  alias_move: "alias moves",
  price_change: "price changes",
  parameter_change: "parameters change",
  capability_change: "capabilities change",
  new_model: "new model",
};

function eventDate(event: RegistryEvent): string {
  if (!event.effective) return "date not announced";
  if (event.date_precision === "earliest_possible") return `no earlier than ${clean(event.effective)}`;
  if (event.date_precision === "estimated") return `around ${clean(event.effective)}`;
  return clean(event.effective);
}

function whenWords(days: number | undefined): string {
  if (days === undefined) return "";
  if (days < 0) return `, ${plural(-days, "day")} ago`;
  if (days === 0) return ", today";
  return `, in ${plural(days, "day")}`;
}

function eventHeadline(event: RegistryEvent, days: number | undefined): string {
  const target = event.to ? `; successor ${clean(event.to)}` : "";
  const word = (days !== undefined ? days < 0 : hasLanded(event)) ? PAST_WORD[event.type] : EVENT_WORD[event.type];
  return `${word} ${eventDate(event)}${whenWords(days)}${target}`;
}

function statusWord(item: ExposureItem): string {
  if (item.status === "ok") return "no change in the registry";
  if (item.status === "unknown") return "not in the registry";
  return item.status.replace(/_/g, " ");
}

function locationSummary(item: ExposureItem): string {
  const shown = item.locations.slice(0, MAX_LOCATIONS_SHOWN).map((l) => `${clean(l.file)}:${l.line}`);
  const extra = item.locations.length - shown.length;
  return extra > 0 ? `${shown.join("  ")}  +${extra} more` : shown.join("  ");
}

function itemLines(item: ExposureItem, style: Styler): string[] {
  const lines: string[] = [];
  const events = orderedEvents(item);
  const first = events[0];
  const headline = first ? eventHeadline(first, item.days_until) : statusWord(item);
  const urgent = item.status !== "ok" && item.status !== "unknown";
  lines.push(`  ${style.bold(clean(item.model, 120))}  ${urgent ? style.yellow(headline) : style.dim(headline)}`);
  if (item.locations.length > 0) lines.push(`    ${style.dim(locationSummary(item))}`);
  for (const event of events.slice(0, MAX_EVENTS_SHOWN)) {
    if (event !== first) lines.push(`    ${eventHeadline(event, undefined)}`);
    lines.push(`    ${style.dim(`source: ${clean(event.source)}`)}`);
  }
  if (events.length > MAX_EVENTS_SHOWN) lines.push(`    ${style.dim(`+${events.length - MAX_EVENTS_SHOWN} more events`)}`);
  return lines;
}

export function registryLine(registry: LoadedRegistry, style: Styler): string[] {
  const date = clean(registry.snapshot.generated_at).slice(0, 10);
  const lines = [style.dim(`Registry: ${date} (${registry.source})`)];
  if (registry.age_days > 7) lines.push(style.yellow(`The registry snapshot is ${registry.age_days} days old, so recent announcements may be missing.`));
  return lines;
}

export function renderScanText(scan: ScanResult, items: ExposureItem[], registry: LoadedRegistry, lockWritten: boolean, style: Styler): string {
  const lines = [`Scanned ${plural(scan.files_scanned, "file")}. Found ${plural(items.length, "model")}.`, ...registryLine(registry, style), ""];
  const changing = [...items].sort(compareItems);
  for (const item of changing) lines.push(...itemLines(item, style), "");
  if (scan.unresolved.length > 0) {
    lines.push(`${plural(scan.unresolved.length, "model call")} could not be read statically:`);
    for (const call of scan.unresolved.slice(0, 5)) lines.push(style.dim(`  ${clean(call.file)}:${call.line}  ${clean(call.reason, 120)}`));
    if (scan.unresolved.length > 5) lines.push(style.dim(`  +${scan.unresolved.length - 5} more`));
    lines.push("");
  }
  const atRisk = items.filter((item) => item.status !== "ok" && item.status !== "unknown").length;
  lines.push(items.length === 0 ? "No model IDs were found in this repo." : `${atRisk} of ${plural(items.length, "model")} ${atRisk === 1 ? "has" : "have"} a change in the registry.`);
  lines.push(style.dim(lockWritten ? "Wrote models.lock." : "Did not write models.lock."));
  return lines.join("\n");
}

function compareItems(a: ExposureItem, b: ExposureItem): number {
  const rank = (item: ExposureItem): number => (item.status === "ok" || item.status === "unknown" ? Number.MAX_SAFE_INTEGER : (item.days_until ?? Number.MAX_SAFE_INTEGER - 1));
  return rank(a) - rank(b) || (a.model < b.model ? -1 : 1);
}

export function renderExposureMarkdown(title: string, items: ExposureItem[], registryDate: string): string {
  const rows = [...items].sort(compareItems).map((item) => {
    const first = orderedEvents(item)[0];
    const where = item.locations.slice(0, MAX_LOCATIONS_SHOWN).map((l) => `${mdEscape(l.file)}:${l.line}`).join(", ");
    const change = first ? mdEscape(eventHeadline(first, item.days_until)) : mdEscape(statusWord(item));
    return `| ${mdEscape(item.model, 120)} | ${change} | ${first ? mdLink("source", first.source) : ""} | ${where} |`;
  });
  return [`## ${title}`, "", `Registry snapshot: ${mdEscape(registryDate.slice(0, 10))}`, "", "| Model | Change | Source | Where |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

export function renderWatchText(result: WatchResult, failWithinDays: number, style: Styler): string {
  const lines = [`Watching ${plural(result.items.length, "model")} from models.lock.`, style.dim(`Registry: ${clean(result.registry_generated_at).slice(0, 10)} (${result.registry_source})`)];
  if (result.registry_age_days > 7) lines.push(style.yellow(`The registry snapshot is ${result.registry_age_days} days old, so recent announcements may be missing.`));
  lines.push("");
  for (const item of [...result.items].sort(compareItems)) lines.push(...itemLines(item, style), "");
  lines.push(
    result.due.length > 0
      ? style.red(`${plural(result.due.length, "model")} changing within ${failWithinDays} days.`)
      : `Nothing changes within ${failWithinDays} days according to the registry.`,
  );
  return lines.join("\n");
}

const REASON_WORD: Record<string, string> = {
  provider_successor: "provider successor",
  same_vendor: "same vendor",
  cheapest: "cheapest",
  other_vendor: "other vendor",
};

function needsSummary(result: FindResult): string {
  const r = result.requirements;
  const needs = (["tools", "structured_output", "vision", "audio", "pdf"] as const).filter((key) => r[key]).map((key) => key.replace("_", " "));
  if (r.min_context > 0) needs.push(`${r.min_context.toLocaleString("en-US")} tokens of context`);
  if (r.min_output > 0) needs.push(`${r.min_output.toLocaleString("en-US")} tokens of output`);
  return needs.length > 0 ? needs.join(", ") : "nothing specific found in the code";
}

export function renderFindText(result: FindResult, style: Styler): string {
  const lines = [`Replacements for ${clean(result.model, 120)}`, style.dim(`Needs: ${needsSummary(result)}`), ""];
  if (result.shortlist.length === 0) {
    lines.push("Nothing in the registry meets these needs and your policy.");
  } else {
    const rows = result.shortlist.map((entry, i) => [
      `${i + 1}`,
      clean(entry.model, 80),
      REASON_WORD[entry.reason] ?? clean(entry.reason),
      `${usd(entry.estimated_usd_per_million_output)}/M output`,
      pct(entry.estimated_cost_change),
      clean(entry.release_date ?? ""),
    ]);
    lines.push(...alignRows(rows).map((row) => `  ${row}`));
    lines.push("", style.dim(`Listed by what the registry says. Prove one on your cases with: swapcheck test --to ${clean(result.shortlist[0]?.model ?? "<model>", 80)}`));
  }
  if (result.rejected.length > 0) {
    lines.push("", style.dim(`Left out ${plural(result.rejected.length, "model")}:`));
    for (const r of result.rejected.slice(0, 5)) lines.push(style.dim(`  ${clean(r.model, 80)}: ${clean(r.reason, 120)}`));
    if (result.rejected.length > 5) lines.push(style.dim(`  +${result.rejected.length - 5} more`));
  }
  if (result.max_usd_to_test !== undefined) lines.push("", style.dim(`Testing the shortlist would cost at most ${usd(result.max_usd_to_test)}.`));
  return lines.join("\n");
}

export function renderFindMarkdown(result: FindResult): string {
  const rows = result.shortlist.map((e) => `| ${mdEscape(e.model, 120)} | ${mdEscape(REASON_WORD[e.reason] ?? e.reason)} | ${usd(e.estimated_usd_per_million_output)} | ${pct(e.estimated_cost_change)} | ${mdLink("source", e.source)} |`);
  return [`## Replacements for ${mdEscape(result.model, 120)}`, "", "| Model | Why | USD per million output | Cost change | Source |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

const VERDICT_WORD: Record<Verdict, string> = {
  NO_CHANGE_DETECTED: "No change detected",
  CHANGED: "Changed",
  REGRESSED: "Regressed",
  NOT_ENOUGH_EVIDENCE: "Not enough evidence",
};

function verdictStyle(verdict: Verdict, style: Styler): (text: string) => string {
  if (verdict === "REGRESSED") return style.red;
  if (verdict === "NO_CHANGE_DETECTED") return style.green;
  return style.yellow;
}

function candidateLines(candidate: CandidateResult, style: Styler): string[] {
  const paint = verdictStyle(candidate.verdict, style);
  const rate = candidate.suite_pass_rate;
  const rows = [
    ["pass rate", `${pct(rate.baseline).replace("+", "")} to ${pct(rate.candidate).replace("+", "")}`],
    ["p50 latency", `${Math.round(candidate.latency_ms_p50.baseline)} ms to ${Math.round(candidate.latency_ms_p50.candidate)} ms`],
    ["cost per case", `${usd(candidate.cost_usd_per_case.baseline)} to ${usd(candidate.cost_usd_per_case.candidate)}`],
    ["spent", usd(candidate.spent_usd)],
  ];
  return [
    `  ${style.bold(clean(candidate.model, 120))}  ${paint(VERDICT_WORD[candidate.verdict])}`,
    `    ${clean(candidate.reason, 300)}`,
    ...alignRows(rows).map((row) => `    ${style.dim(row)}`),
  ];
}

export function renderReportText(report: SwapReport, reportPath: string | undefined, style: Styler): string {
  const lines = [
    `Compared ${clean(report.baseline_model, 120)} on ${plural(report.case_count, "case")}, ${report.runs_per_case} runs each.`,
    style.dim(`Noise: model against itself flagged ${report.noise.flagged_cases} cases (false-change rate ${pct(report.noise.false_change_rate).replace("+", "")}).`),
    "",
  ];
  for (const candidate of report.candidates) lines.push(...candidateLines(candidate, style), "");
  lines.push(`Spent ${usd(report.spent_usd)} of a ${usd(report.budget_usd)} limit.${report.stopped_early ? " Stopped early." : ""}`);
  if (report.vendors_seen.length > 0) lines.push(style.dim(`Vendors that saw case content: ${report.vendors_seen.map((v) => clean(v)).join(", ")}`));
  if (report.limits.length > 0) {
    lines.push("", "Limits of this measurement:");
    for (const limit of report.limits) lines.push(style.dim(`  - ${clean(limit, 300)}`));
  }
  if (reportPath) lines.push("", style.dim(`Saved: ${clean(reportPath)}`));
  return lines.join("\n");
}
