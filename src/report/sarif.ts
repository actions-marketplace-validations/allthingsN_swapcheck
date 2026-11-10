import type { CandidateResult, ExposureItem, SwapReport } from "../types.ts";
import { redactSecrets } from "../util/redact.ts";
import { VERSION } from "../version.ts";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/allthingsN/swapcheck";
const MAX_RESULTS = 2000;

interface Rule {
  id: string;
  name: string;
  shortDescription: { text: string };
}

function sarifLog(rules: Rule[], results: object[]): object {
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "swapcheck", version: VERSION, informationUri: INFORMATION_URI, rules } }, results: results.slice(0, MAX_RESULTS) }],
  };
}

function physical(uri: string, line: number): object {
  return { physicalLocation: { artifactLocation: { uri: uri.split("\\").join("/") }, region: { startLine: Math.max(1, line) } } };
}

const EXPOSURE_RULES: Rule[] = [
  { id: "model-at-risk", name: "ModelAtRisk", shortDescription: { text: "A model in use is scheduled to change or has changed." } },
  { id: "model-unknown", name: "ModelUnknown", shortDescription: { text: "A model in use is not in the registry." } },
];

function exposureLevel(item: ExposureItem): string {
  if (item.status === "retired" || item.status === "rerouted") return "error";
  if (item.status === "ok" || item.status === "unknown") return "note";
  return "warning";
}

export function renderSarifExposure(items: ExposureItem[]): object {
  const results = items.filter((item) => item.status !== "ok").flatMap((item) => {
    const when = item.days_until === undefined ? "" : ` Effective in ${item.days_until} days.`;
    const text = redactSecrets(`${item.model} (${item.route}) has status ${item.status}.${when}`);
    const locations = item.locations.length > 0 ? item.locations : [{ file: "models.lock", line: 1 }];
    return locations.map((location) => ({
      ruleId: item.status === "unknown" ? "model-unknown" : "model-at-risk",
      level: exposureLevel(item),
      message: { text },
      locations: [physical(location.file, location.line)],
    }));
  });
  return sarifLog(EXPOSURE_RULES, results);
}

const REPORT_RULES: Rule[] = [
  { id: "candidate-regressed", name: "CandidateRegressed", shortDescription: { text: "A confirmed pass-rate drop was measured for a candidate model." } },
  { id: "candidate-changed", name: "CandidateChanged", shortDescription: { text: "Differences beyond noise were measured for a candidate model." } },
  { id: "candidate-not-measured", name: "CandidateNotMeasured", shortDescription: { text: "There was not enough evidence to compare a candidate model." } },
  { id: "candidate-no-change-detected", name: "CandidateNoChangeDetected", shortDescription: { text: "No difference was detected on the cases tested." } },
];

const VERDICT_RULES: Record<CandidateResult["verdict"], { ruleId: string; level: string }> = {
  REGRESSED: { ruleId: "candidate-regressed", level: "error" },
  CHANGED: { ruleId: "candidate-changed", level: "warning" },
  NOT_ENOUGH_EVIDENCE: { ruleId: "candidate-not-measured", level: "warning" },
  NO_CHANGE_DETECTED: { ruleId: "candidate-no-change-detected", level: "note" },
};

export function renderSarifReport(report: SwapReport): object {
  const uri = `swapcheck/reports/${report.id}.json`;
  const results = report.candidates.map((candidate) => {
    const rule = VERDICT_RULES[candidate.verdict];
    return {
      ruleId: rule.ruleId,
      level: rule.level,
      message: { text: redactSecrets(`${candidate.model} compared with ${report.baseline_model}: ${candidate.reason}`) },
      locations: [physical(uri, 1)],
      properties: { verdict: candidate.verdict, pass_rate_baseline: candidate.suite_pass_rate.baseline, pass_rate_candidate: candidate.suite_pass_rate.candidate },
    };
  });
  return sarifLog(REPORT_RULES, results);
}
