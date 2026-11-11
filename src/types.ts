/** Shared contracts. Every module depends on these; change them deliberately. */

export type EventType =
  | "retirement"
  | "reroute"
  | "alias_move"
  | "price_change"
  | "parameter_change"
  | "capability_change"
  | "new_model";

export type Confidence = "high" | "medium" | "low";
export type DatePrecision = "exact" | "earliest_possible" | "estimated";

export interface RegistryEvent {
  id: string;
  type: EventType;
  provider: string;
  /** Where the model is served, e.g. "anthropic-api", "aws-bedrock", "google-ai-studio". */
  route: string;
  model: string;
  /** Replacement model, when the provider names one or one is inferred. */
  to?: string;
  /** ISO date YYYY-MM-DD. */
  effective?: string;
  date_precision?: DatePrecision;
  billing?: "replacement_rates" | "unchanged" | "unknown";
  successor_basis?: "provider_named" | "inferred" | "none";
  /** For parameter_change: the rejected request parameters. */
  params?: string[];
  /** The regions a change covers, with each group's date. A region not listed has no announced change. */
  region_schedule?: Array<{ regions: string[]; effective: string }>;
  source: string;
  confidence: Confidence;
  first_seen: string;
  last_verified: string;
  report_url?: string;
  notes?: string;
}

export interface ModelCapabilities {
  tools: boolean;
  structured_output: boolean;
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  pdf: boolean;
}

export interface RegistryModel {
  id: string;
  provider: string;
  route: string;
  name: string;
  family?: string;
  release_date?: string;
  status: "active" | "deprecated" | "retired" | "unknown";
  capabilities: ModelCapabilities;
  limit: { context: number; output: number };
  /** USD per million tokens. */
  cost: { input: number; output: number };
  license?: string;
  open_weights?: boolean;
  region?: string[];
  source: string;
}

export interface RegistrySnapshot {
  version: 1;
  generated_at: string;
  events: RegistryEvent[];
  models: RegistryModel[];
}

export type FindingKind = "code" | "config" | "env" | "docs";

export interface ScanFinding {
  model: string;
  file: string;
  line: number;
  column: number;
  kind: FindingKind;
  provider?: string;
  route?: string;
  /** Cloud regions the call can run in, when the code or config says (such as Bedrock's aws_region_name). */
  regions?: string[];
  /** True when the string matched a model in the registry (not only a naming pattern). */
  known: boolean;
}

export interface UnresolvedCall {
  file: string;
  line: number;
  column: number;
  expression: string;
  reason: string;
}

export interface ScanResult {
  root: string;
  files_scanned: number;
  findings: ScanFinding[];
  unresolved: UnresolvedCall[];
}

export interface ExposureItem {
  model: string;
  route: string;
  locations: Array<{ file: string; line: number }>;
  events: RegistryEvent[];
  status: "ok" | "unknown" | ModelStatus;
  days_until?: number;
  /** Dated registry IDs used because the ID as written is not listed on this route, such as a provider alias. */
  resolved_as?: string[];
  /** Cloud regions the call can run in; region-specific changes elsewhere are left out. */
  regions?: string[];
  /** Region-limited events left out because the call runs elsewhere. */
  other_regions?: RegistryEvent[];
}

export type ModelStatus = "retiring" | "retired" | "reroute_scheduled" | "rerouted" | "repricing" | "parameter_change";

export interface WatchResult {
  registry_generated_at: string;
  registry_age_days: number;
  registry_source: "remote" | "cache" | "bundled";
  items: ExposureItem[];
  due: ExposureItem[];
}

export interface LockEntry {
  id: string;
  route: string;
  regions?: string[];
  status: ExposureItem["status"];
  reroute_to?: string;
  effective?: string;
  registry_event?: string;
  verified_at: string | null;
  baseline: string | null;
  cost?: { input: number; output: number };
  capabilities?: ModelCapabilities;
}

export interface LockFile {
  version: 1;
  models: LockEntry[];
}

export interface PolicyConfig {
  providers?: string[];
  regions?: string[];
  licenses?: string[];
  max_usd_per_million_output?: number;
}

export interface SwapcheckConfig {
  models: Array<{ id: string; route?: string; paths?: string[] }>;
  cases: string;
  runs: number;
  budget: { max_usd_per_run: number };
  policy: PolicyConfig;
  watch: { fail_within_days: number };
  include_text_in_reports: boolean;
  exclude: string[];
}

/** One deterministic or judged check applied to a response. */
export type Check =
  | { type: "json_valid" }
  | { type: "json_schema"; schema: Record<string, unknown> }
  | { type: "label_in"; labels: string[] }
  | { type: "contains"; text: string; ignore_case?: boolean }
  | { type: "not_contains"; text: string; ignore_case?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "tool_called"; name: string }
  | { type: "tool_not_called"; name: string }
  | { type: "tool_args_valid" }
  | { type: "no_refusal" }
  | { type: "refusal" }
  | { type: "max_tokens_output"; max: number }
  | { type: "meaning"; rubric?: string };

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Set when arguments could not be parsed as JSON. */
  raw_arguments?: string;
}

export type CaseOrigin = "team" | "trace" | "imported" | "generated";

export interface TestCase {
  id: string;
  origin: CaseOrigin;
  /** Generated cases are excluded until accepted. */
  accepted: boolean;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  response_format?: { type: "json_object" } | { type: "json_schema"; schema: Record<string, unknown>; name?: string };
  max_tokens?: number;
  params?: Record<string, unknown>;
  checks: Check[];
  tags?: string[];
}

export interface ProviderRequest {
  model: string;
  route?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  response_format?: TestCase["response_format"];
  max_tokens?: number;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  tool_calls: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  /** The model the provider reports it actually served. */
  served_model?: string;
  finish_reason?: string;
}

export interface Provider {
  name: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export interface RunRecord {
  case_id: string;
  model: string;
  run: number;
  passed: boolean;
  failed_checks: string[];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  served_model?: string;
  error?: string;
  /** Present only when include_text_in_reports is true. */
  output_text?: string;
}

export type Verdict = "NO_CHANGE_DETECTED" | "CHANGED" | "REGRESSED" | "NOT_ENOUGH_EVIDENCE";

export interface CaseComparison {
  case_id: string;
  case_hash: string;
  baseline_passes: number;
  baseline_runs: number;
  candidate_passes: number;
  candidate_runs: number;
  p_value: number;
  /** Benjamini-Hochberg adjusted. */
  q_value: number;
  confirmed: boolean;
  verdict: Verdict;
  failed_checks: string[];
}

export interface MetricDelta {
  baseline: number;
  candidate: number;
  /** Fractional change, candidate/baseline - 1. Null when baseline is 0. */
  delta: number | null;
  ci95?: [number, number];
}

export interface CandidateResult {
  model: string;
  route?: string;
  verdict: Verdict;
  reason: string;
  cases: CaseComparison[];
  suite_pass_rate: { baseline: number; candidate: number; ci95: [number, number]; p_value: number };
  latency_ms_p50: MetricDelta;
  cost_usd_per_case: MetricDelta;
  error_rate: number;
  spent_usd: number;
}

export interface SwapReport {
  schema: "swapcheck.report/v1";
  id: string;
  created_at: string;
  swapcheck_version: string;
  registry_generated_at: string;
  baseline_model: string;
  runs_per_case: number;
  case_count: number;
  case_origins: Record<CaseOrigin, number>;
  noise: { false_change_rate: number; flagged_cases: number };
  candidates: CandidateResult[];
  spent_usd: number;
  budget_usd: number;
  stopped_early: boolean;
  vendors_seen: string[];
  limits: string[];
  runs: RunRecord[];
}

export interface ShortlistEntry {
  model: string;
  provider: string;
  route: string;
  reason: "provider_successor" | "same_vendor" | "cheapest" | "other_vendor";
  estimated_usd_per_million_output: number;
  estimated_cost_change: number | null;
  release_date?: string;
  capabilities: ModelCapabilities;
  source: string;
}

export interface Requirements {
  tools: boolean;
  structured_output: boolean;
  vision: boolean;
  audio: boolean;
  pdf: boolean;
  min_context: number;
  min_output: number;
  evidence: string[];
}

export interface FindResult {
  model: string;
  requirements: Requirements;
  shortlist: ShortlistEntry[];
  rejected: Array<{ model: string; reason: string }>;
  tested: boolean;
  max_usd_to_test?: number;
}

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, UNMEASURED: 3 } as const;
