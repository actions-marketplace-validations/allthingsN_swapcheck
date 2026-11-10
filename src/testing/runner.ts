import type {
  CandidateResult, CaseComparison, CaseOrigin, ChatMessage, MetricDelta, PolicyConfig, Provider, ProviderResponse, RegistrySnapshot, RunRecord, SwapReport, TestCase, ToolCall,
} from "../types.ts";
import { EXIT } from "../types.ts";
import { findModel, vendorOf } from "../providers/index.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, ProviderError, type BudgetedRequest, type NormalizedResponse } from "../providers/shared.ts";
import { SwapcheckError } from "../util/errors.ts";
import { hashOf } from "../util/hash.ts";
import { redactSecrets } from "../util/redact.ts";
import { VERSION } from "../version.ts";
import { BudgetExhausted, BudgetLedger, JUDGE_MAX_TOKENS, highestKnownPrice, priceOf, usdFor, worstCaseUsd, type Price, type Reservation } from "./budget.ts";
import { checkLabel, evaluateCheck, type CheckContext, type CheckOutcome } from "./checks.ts";
import { benjaminiHochberg, bootstrapCI, fisherExact, fisherExactLower, p50, pairedPermutationTest } from "./stats.ts";
import {
  CONFIRMATION_ALPHA, ESCALATION_P, SUITE_ALPHA, decideCandidateVerdict, decideCaseVerdict, detectChangeSignals, signalsBeyondNoise, type CaseSignals, type ChangeSignal,
} from "./verdict.ts";

export interface RunOptions {
  baseline: string;
  candidates: string[];
  cases: TestCase[];
  runs: number;
  budgetUsd: number;
  snapshot: RegistrySnapshot;
  registryGeneratedAt: string;
  providerFor: (model: string) => Provider;
  judge?: Provider & { model?: string };
  includeText?: boolean;
  concurrency?: number;
  onProgress?: (msg: string) => void;
  policy?: PolicyConfig;
  now?: Date;
  /** Run models with no listed price, bounding them at the highest price in the registry. */
  allowUnknownPrices?: boolean;
  /** The route each model is called on, so the budget uses that route's price. */
  routeFor?: (model: string) => string | undefined;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const STALE_REGISTRY_DAYS = 7;
const ERROR_TEXT_LIMIT = 500;

interface Observation {
  caseId: string;
  checks: Map<string, boolean>;
  tools: string[];
  scored: boolean;
  record: RunRecord;
}

type Sample = Map<string, Observation[]>;

/**
 * Keeps the transcript up to the last user message. Trailing tool results the case supplied are
 * kept, since they are the case's mocked inputs; any logged model reply after that point is not.
 */
export function replayMessages(messages: ChatMessage[]): ChatMessage[] {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  if (lastUser < 0) return messages;
  const trailing = messages.slice(lastUser + 1);
  let index = 0;
  while (index < trailing.length) {
    const message = trailing[index]!;
    if (message.role !== "assistant" || !message.tool_calls?.length) break;
    let next = index + 1;
    while (trailing[next]?.role === "tool") next++;
    if (next === index + 1) break;
    index = next;
  }
  return index === trailing.length && trailing.length > 0 ? messages : messages.slice(0, lastUser + 1);
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]!);
  });
  await Promise.all(runners);
}

function seedFor(...parts: unknown[]): number {
  return Number.parseInt(hashOf(parts).slice(0, 8), 16);
}

/** The error most runs failed with, so a fully failed comparison says why. */
function mostCommonError(sample: Sample): string | undefined {
  const counts = new Map<string, number>();
  for (const observation of [...sample.values()].flat()) {
    const error = observation.record.error;
    if (error !== undefined) counts.set(error, (counts.get(error) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [error, count] of counts) if (best === undefined || count > counts.get(best)!) best = error;
  return best === undefined ? undefined : best.slice(0, 200);
}

function policyProblem(model: string, snapshot: RegistrySnapshot, policy: PolicyConfig): string | undefined {
  const entry = findModel(model, snapshot);
  const listed = (rule: string): string => `${model} cannot be checked against the ${rule} policy because the registry has no such data for it.`;
  if (policy.providers?.length) {
    const vendor = vendorOf(model, snapshot);
    if (!policy.providers.map((name) => name.toLowerCase()).includes(vendor)) return `${model} is from ${vendor}, which is not in the allowed providers (${policy.providers.join(", ")}).`;
  }
  if (policy.regions?.length) {
    if (!entry?.region?.length) return listed("regions");
    if (!entry.region.some((region) => policy.regions!.includes(region))) return `${model} is not available in the allowed regions (${policy.regions.join(", ")}).`;
  }
  if (policy.licenses?.length) {
    if (!entry?.license) return listed("licenses");
    if (!policy.licenses.includes(entry.license)) return `${model} has the license ${entry.license}, which is not in the allowed licenses (${policy.licenses.join(", ")}).`;
  }
  if (policy.max_usd_per_million_output !== undefined) {
    const price = priceOf(model, snapshot);
    if (!price) return listed("price");
    if (price.output > policy.max_usd_per_million_output) return `${model} costs up to $${price.output} per million output tokens, above the policy limit of $${policy.max_usd_per_million_output}.`;
  }
  return undefined;
}

function isAliasOf(requested: string, served: string): boolean {
  const bare = requested.includes("/") ? requested.slice(requested.lastIndexOf("/") + 1) : requested;
  if (served === requested || served === bare) return true;
  return served.startsWith(`${bare}-`) && /^-(\d{4}-?\d{2}-?\d{2}|\d{3})$/.test(served.slice(bare.length));
}

function emptySignals(): CaseSignals {
  return { passes: 0, runs: 0, checks: new Map(), tools: new Map(), outputTokens: [] };
}

function usable(observations: Observation[] | undefined): Observation[] {
  return (observations ?? []).filter((observation) => observation.scored && observation.record.error === undefined);
}

function summarize(observations: Observation[]): CaseSignals {
  const signals = emptySignals();
  for (const observation of usable(observations)) {
    signals.runs++;
    if (observation.record.passed) signals.passes++;
    signals.outputTokens.push(observation.record.output_tokens);
    for (const [label, passed] of observation.checks) {
      const type = label.split("#")[0]!;
      const current = signals.checks.get(type) ?? [0, 0];
      signals.checks.set(type, [current[0] + (passed ? 1 : 0), current[1] + 1]);
    }
    for (const name of new Set(observation.tools)) signals.tools.set(name, (signals.tools.get(name) ?? 0) + 1);
  }
  return signals;
}

function summarizeAll(sample: Sample, extra?: Sample): Map<string, CaseSignals> {
  const out = new Map<string, CaseSignals>();
  for (const [caseId, observations] of sample) {
    out.set(caseId, summarize([...observations, ...(extra?.get(caseId) ?? [])]));
  }
  return out;
}

function delta(baseline: number, candidate: number, ci95?: [number, number]): MetricDelta {
  const result: MetricDelta = { baseline, candidate, delta: baseline === 0 ? null : candidate / baseline - 1 };
  if (ci95) result.ci95 = ci95;
  return result;
}

function usableRecords(sample: Sample): RunRecord[] {
  return [...sample.values()].flat().filter((observation) => observation.record.error === undefined).map((observation) => observation.record);
}

function perCaseMean(sample: Sample, select: (record: RunRecord) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const caseId of sample.keys()) {
    const values = usableRecords(new Map([[caseId, sample.get(caseId)!]])).map(select);
    if (values.length > 0) out.set(caseId, arithmeticMean(values));
  }
  return out;
}

/** The summary uses every run; the interval is on paired per-case differences. */
function metricDelta(baseline: Sample, candidate: Sample, select: (record: RunRecord) => number, seed: number, summarizeValues: (values: number[]) => number): MetricDelta {
  const baseMeans = perCaseMean(baseline, select);
  const candMeans = perCaseMean(candidate, select);
  const differences = [...baseMeans.keys()].filter((id) => candMeans.has(id)).map((id) => candMeans.get(id)! - baseMeans.get(id)!);
  return delta(summarizeValues(usableRecords(baseline).map(select)), summarizeValues(usableRecords(candidate).map(select)), bootstrapCI(differences, { seed }));
}

function arithmeticMean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export async function runComparison(opts: RunOptions): Promise<SwapReport> {
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new SwapcheckError("The number of runs per case must be a whole number of at least 1.");
  if (!(opts.budgetUsd > 0)) throw new SwapcheckError("The budget must be greater than zero. Set budget.max_usd_per_run in swapcheck.yaml.");

  const cases = opts.cases.filter((testCase) => testCase.accepted);
  if (cases.length === 0) {
    throw new SwapcheckError("There are no accepted cases to run. Add cases to the cases folder or accept generated drafts with swapcheck cases accept.", EXIT.USAGE);
  }

  const models = [opts.baseline, ...opts.candidates];
  if (opts.policy) {
    for (const candidate of opts.candidates) {
      const problem = policyProblem(candidate, opts.snapshot, opts.policy);
      if (problem) throw new SwapcheckError(`The candidate was refused by policy: ${problem}`, EXIT.USAGE);
    }
  }

  const prices = new Map<string, Price>();
  const unknownPrices: string[] = [];
  const pricedModels = opts.judge ? [...models, opts.judge.model ?? "the judge model"] : models;
  for (const model of pricedModels) {
    const price = priceOf(model, opts.snapshot, models.includes(model) ? opts.routeFor?.(model) : undefined);
    if (price) prices.set(model, price);
    else if (!unknownPrices.includes(model)) unknownPrices.push(model);
  }
  if (unknownPrices.length > 0) {
    if (!opts.allowUnknownPrices) {
      throw new SwapcheckError(`The price of ${unknownPrices.join(", ")} is not known, so the budget cannot bound the run. Pass the budget override to run anyway at the highest price in the registry, or choose a listed model.`, EXIT.USAGE);
    }
    const assumed = highestKnownPrice(opts.snapshot);
    for (const model of unknownPrices) prices.set(model, assumed);
  }

  // Resolved up front so a missing key fails before any money is spent.
  const providers = new Map(models.map((model) => [model, opts.providerFor(model)]));

  const ledger = new BudgetLedger(opts.budgetUsd);
  /** A response without believable usage may still have been billed, so its reservation is not refunded. */
  const settleUsage = (reservation: Reservation, usage: ProviderResponse["usage"] | undefined, price: Price): number => {
    const known = (count: unknown): count is number => typeof count === "number" && Number.isFinite(count) && count > 0;
    if (!known(usage?.input_tokens) || !known(usage?.output_tokens)) {
      ledger.keepWorstCase(reservation);
      return reservation.amount;
    }
    const cost = usdFor(usage.input_tokens, usage.output_tokens, price);
    ledger.settle(reservation, cost);
    return cost;
  };
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY));
  const includeText = opts.includeText ?? false;
  const records: RunRecord[] = [];
  const notes = {
    servedMismatch: new Map<string, number>(),
    droppedParams: new Set<string>(),
    meaningSkipped: 0,
    judgeFailures: 0,
    otherSkips: new Set<string>(),
  };
  let stopped = false;
  const progress = (message: string): void => opts.onProgress?.(redactSecrets(message));
  const vendorsSeen = new Set<string>();

  const judgeModel = opts.judge?.model ?? "the judge model";
  const callJudge: CheckContext["callJudge"] = opts.judge
    ? async (system, user) => {
        const judge = opts.judge!;
        const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: user }];
        const price = prices.get(judgeModel)!;
        const request: BudgetedRequest = { model: judge.model ?? "judge", messages, max_tokens: JUDGE_MAX_TOKENS };
        const worst = worstCaseUsd(request, price);
        let current = ledger.reserve(worst);
        request.beforeRetry = () => {
          ledger.keepWorstCase(current);
          current = ledger.reserve(worst);
        };
        vendorsSeen.add(judge.model ? vendorOf(judge.model, opts.snapshot) : "unknown");
        try {
          const response = await judge.complete(request);
          settleUsage(current, response.usage, price);
          return response.text;
        } catch (error) {
          if (error instanceof ProviderError && error.billing === "none") ledger.settle(current, 0);
          else ledger.keepWorstCase(current);
          throw error;
        }
      }
    : undefined;

  /** Runs one call. Returns null only when the budget stopped it. */
  async function observe(model: string, testCase: TestCase, run: number): Promise<Observation | null> {
    if (stopped) return null;
    const provider = providers.get(model)!;
    const price = prices.get(model)!;
    const request: BudgetedRequest = {
      model,
      messages: replayMessages(testCase.messages),
      tools: testCase.tools,
      response_format: testCase.response_format,
      max_tokens: testCase.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      params: testCase.params,
    };
    const worst = worstCaseUsd(request, price);
    let reservation: Reservation;
    try {
      reservation = ledger.reserve(worst);
    } catch {
      stopped = true;
      return null;
    }
    let current = reservation;
    request.beforeRetry = () => {
      // A failed attempt keeps its charge; the retry must find room of its own.
      ledger.keepWorstCase(current);
      current = ledger.reserve(worst);
    };
    vendorsSeen.add(vendorOf(model, opts.snapshot));

    const started = performance.now();
    let response: ProviderResponse;
    try {
      response = await provider.complete(request);
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        stopped = true;
        return null;
      }
      if (error instanceof ProviderError && error.billing === "none") ledger.settle(current, 0);
      else ledger.keepWorstCase(current);
      const message = error instanceof Error ? error.message : String(error);
      const record: RunRecord = {
        case_id: testCase.id, model, run, passed: false, failed_checks: [],
        latency_ms: performance.now() - started, input_tokens: 0, output_tokens: 0, cost_usd: 0,
        error: redactSecrets(message).slice(0, ERROR_TEXT_LIMIT),
      };
      records.push(record);
      return { caseId: testCase.id, checks: new Map(), tools: [], scored: true, record };
    }

    const costUsd = settleUsage(current, response.usage, price);

    const dropped = (response as NormalizedResponse).dropped_params;
    if (dropped) for (const name of dropped) notes.droppedParams.add(`${model}: ${name}`);
    if (response.served_model && !isAliasOf(model, response.served_model)) {
      const key = `${model} -> ${response.served_model}`;
      notes.servedMismatch.set(key, (notes.servedMismatch.get(key) ?? 0) + 1);
    }

    const outcomes: CheckOutcome[] = [];
    const context: CheckContext = { testCase, callJudge };
    for (let index = 0; index < testCase.checks.length; index++) {
      const check = testCase.checks[index]!;
      try {
        outcomes.push(await evaluateCheck(check, index, response, context));
      } catch (error) {
        if (error instanceof BudgetExhausted) {
          // The model answered and was paid for; only the judged check is lost.
          stopped = true;
          outcomes.push({ label: "meaning", status: "skip", detail: "budget reached" });
          break;
        }
        // Hostile output, such as JSON nested past the stack limit, must not abort a paid run.
        outcomes.push({ label: checkLabel(check, index), status: "skip", detail: `A ${check.type} check could not be evaluated on a response, so it did not count.` });
      }
    }

    const checks = new Map<string, boolean>();
    for (const outcome of outcomes) {
      if (outcome.status === "skip") {
        if (outcome.label.startsWith("meaning")) {
          if (outcome.detail === "no judge configured") notes.meaningSkipped++;
          else notes.judgeFailures++;
        } else {
          notes.otherSkips.add(outcome.detail ?? outcome.label);
        }
      } else {
        checks.set(outcome.label, outcome.status === "pass");
      }
    }
    const failed = outcomes.filter((outcome) => outcome.status === "fail").map((outcome) => outcome.label);
    const record: RunRecord = {
      case_id: testCase.id, model, run,
      passed: failed.length === 0,
      failed_checks: failed,
      latency_ms: response.latency_ms,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: costUsd,
    };
    if (response.served_model) record.served_model = response.served_model;
    if (includeText) record.output_text = redactSecrets(response.text);
    records.push(record);
    return { caseId: testCase.id, checks, tools: response.tool_calls.map((call: ToolCall) => call.name), scored: checks.size > 0, record };
  }

  async function collect(model: string, targets: TestCase[], firstRun: number, runs: number): Promise<Sample> {
    const sample: Sample = new Map(targets.map((testCase) => [testCase.id, []]));
    const tasks: Array<{ testCase: TestCase; run: number }> = [];
    for (const testCase of targets) for (let run = firstRun; run < firstRun + runs; run++) tasks.push({ testCase, run });
    await runPool(tasks, concurrency, async ({ testCase, run }) => {
      const observation = await observe(model, testCase, run);
      if (observation) sample.get(testCase.id)!.push(observation);
    });
    return sample;
  }

  const n = opts.runs;
  progress(`Measuring ${opts.baseline} on ${cases.length} cases, ${n} runs each.`);
  const baselineFirst = await collect(opts.baseline, cases, 0, n);
  progress(`Estimating noise with a second sample of ${opts.baseline}.`);
  const baselineSecond = await collect(opts.baseline, cases, n, n);

  const firstHalf = summarizeAll(baselineFirst);
  const secondHalf = summarizeAll(baselineSecond);
  const noiseSeed = seedFor("noise", opts.baseline);
  const noiseSignals = detectChangeSignals(firstHalf, secondHalf, noiseSeed);
  let flaggedCases = 0;
  let comparableCases = 0;
  for (const testCase of cases) {
    const first = firstHalf.get(testCase.id)!;
    const second = secondHalf.get(testCase.id)!;
    if (first.runs === 0 || second.runs === 0) continue;
    comparableCases++;
    if (fisherExact(first.passes, first.runs, second.passes, second.runs) < ESCALATION_P) flaggedCases++;
  }
  const noise = { false_change_rate: comparableCases > 0 ? flaggedCases / comparableCases : 0, flagged_cases: flaggedCases };

  const pooledBaseline = summarizeAll(baselineFirst, baselineSecond);
  const allBaselineObservations: Sample = new Map(cases.map((testCase) => [testCase.id, [...baselineFirst.get(testCase.id)!, ...baselineSecond.get(testCase.id)!]]));
  const freshBaseline: Sample = new Map();
  const results: CandidateResult[] = [];

  const countRate = (sample: Sample): number => {
    const all = [...sample.values()].flat();
    return all.length > 0 ? all.filter((observation) => observation.record.error !== undefined).length / all.length : 0;
  };

  for (const candidate of opts.candidates) {
    progress(`Measuring ${candidate} on ${cases.length} cases, ${n} runs each.`);
    const firstCandidate = await collect(candidate, cases, 0, n);
    const candidateSummary = summarizeAll(firstCandidate);
    const seed = seedFor(opts.baseline, candidate, cases.map((testCase) => testCase.id));

    const rows = cases.map((testCase) => {
      const base = pooledBaseline.get(testCase.id)!;
      const cand = candidateSummary.get(testCase.id)!;
      const evaluated = base.runs > 0 && cand.runs > 0;
      const p = evaluated ? fisherExact(base.passes, base.runs, cand.passes, cand.runs) : 1;
      const lower = evaluated && cand.passes / cand.runs < base.passes / base.runs;
      return { testCase, base, cand, evaluated, p, lower, difference: evaluated ? cand.passes / cand.runs - base.passes / base.runs : 0 };
    });
    const q = benjaminiHochberg(rows.map((row) => row.p));

    const evaluatedRows = rows.filter((row) => row.evaluated);
    const suiteTest = pairedPermutationTest(evaluatedRows.map((row) => row.difference), { seed });
    const suiteLower = suiteTest.p < SUITE_ALPHA && suiteTest.mean < 0;
    const escalated = new Set(rows.filter((row) => row.lower && row.p < ESCALATION_P).map((row) => row.testCase.id));

    // A suite-wide drop re-runs everything; a per-case escalation re-runs only those cases.
    const toConfirm = suiteLower ? cases : cases.filter((testCase) => escalated.has(testCase.id));
    let freshCandidate: Sample = new Map();
    if (toConfirm.length > 0) {
      progress(`Re-running ${toConfirm.length} ${toConfirm.length === 1 ? "case" : "cases"} on a fresh sample to see whether differences reproduce.`);
      const missing = toConfirm.filter((testCase) => !freshBaseline.has(testCase.id));
      if (missing.length > 0) {
        const collected = await collect(opts.baseline, missing, 2 * n, n);
        for (const [caseId, observations] of collected) freshBaseline.set(caseId, observations);
      }
      freshCandidate = await collect(candidate, toConfirm, n, n);
    }

    const bonferroni = Math.max(1, escalated.size);
    const comparisons: CaseComparison[] = rows.map((row, index) => {
      const id = row.testCase.id;
      const freshCand = freshCandidate.has(id) ? summarize(freshCandidate.get(id)!) : undefined;
      const freshBase = freshBaseline.has(id) ? summarize(freshBaseline.get(id)!) : undefined;
      let confirmed = false;
      let confirmationComplete = true;
      if (escalated.has(id)) {
        confirmationComplete = (freshCand?.runs ?? 0) > 0;
        if (freshCand && freshCand.runs > 0) {
          const pooledPasses = row.base.passes + (freshBase?.passes ?? 0);
          const pooledRuns = row.base.runs + (freshBase?.runs ?? 0);
          confirmed = freshCand.passes / freshCand.runs < pooledPasses / pooledRuns
            && fisherExactLower(pooledPasses, pooledRuns, freshCand.passes, freshCand.runs) < CONFIRMATION_ALPHA / bonferroni;
        }
      }
      const complete = row.evaluated && row.cand.runs + errorsIn(firstCandidate, id) >= n;
      const failed = new Set<string>();
      for (const observation of [...firstCandidate.get(id)!, ...(freshCandidate.get(id) ?? [])]) for (const label of observation.record.failed_checks) failed.add(label);
      return {
        case_id: id,
        case_hash: hashOf(row.testCase),
        baseline_passes: row.base.passes,
        baseline_runs: row.base.runs,
        candidate_passes: row.cand.passes,
        candidate_runs: row.cand.runs,
        p_value: row.p,
        q_value: q[index]!,
        confirmed,
        verdict: decideCaseVerdict({ complete, confirmed, escalated: escalated.has(id), confirmationComplete, qValue: q[index]! }),
        failed_checks: [...failed].sort(),
      };
    });

    let suiteConfirmed = false;
    if (suiteLower) {
      const differences: number[] = [];
      for (const testCase of cases) {
        const freshCand = freshCandidate.has(testCase.id) ? summarize(freshCandidate.get(testCase.id)!) : undefined;
        const freshBase = freshBaseline.has(testCase.id) ? summarize(freshBaseline.get(testCase.id)!) : undefined;
        if (freshCand?.runs && freshBase?.runs) differences.push(freshCand.passes / freshCand.runs - freshBase.passes / freshBase.runs);
      }
      const freshTest = pairedPermutationTest(differences, { seed: seed + 1, alternative: "lower" });
      suiteConfirmed = differences.length === cases.length && freshTest.p < SUITE_ALPHA && freshTest.mean < 0;
    }

    const changeSignals: ChangeSignal[] = signalsBeyondNoise(detectChangeSignals(pooledBaseline, candidateSummary, seed + 2), noiseSignals);

    const candidateObservations: Sample = new Map(cases.map((testCase) => [testCase.id, [...firstCandidate.get(testCase.id)!, ...(freshCandidate.get(testCase.id) ?? [])]]));
    const errorRate = countRate(candidateObservations);
    const baselineErrorRate = countRate(allBaselineObservations);
    const incomplete = rows.some((row) => row.cand.runs < n && row.cand.runs + errorsIn(firstCandidate, row.testCase.id) < n);
    const unconfirmed = comparisons.some((comparison) => escalated.has(comparison.case_id) && comparison.verdict === "NOT_ENOUGH_EVIDENCE");
    const suiteUnconfirmed = suiteLower && !suiteConfirmed && [...freshCandidate.values()].some((observations) => observations.length < n);
    const unfinished = stopped && (incomplete || unconfirmed || suiteUnconfirmed);
    const { verdict, reason } = decideCandidateVerdict({
      caseCount: cases.length,
      evaluatedCases: evaluatedRows.length,
      confirmedCases: comparisons.filter((comparison) => comparison.confirmed).length,
      suiteConfirmed,
      errorRate,
      baselineErrorRate,
      unfinished,
      changeSignals,
      commonError: mostCommonError(errorRate >= baselineErrorRate ? candidateObservations : allBaselineObservations),
    });

    const suiteDifferences = evaluatedRows.map((row) => row.difference);
    const passBase = arithmeticMean(evaluatedRows.map((row) => row.base.passes / row.base.runs));
    const passCand = arithmeticMean(evaluatedRows.map((row) => row.cand.passes / row.cand.runs));
    const entry = findModel(candidate, opts.snapshot);
    const result: CandidateResult = {
      model: candidate,
      verdict,
      reason,
      cases: comparisons,
      suite_pass_rate: { baseline: passBase, candidate: passCand, ci95: bootstrapCI(suiteDifferences, { seed: seed + 3 }), p_value: suiteTest.p },
      latency_ms_p50: metricDelta(allBaselineObservations, firstCandidate, (record) => record.latency_ms, seed + 4, p50),
      cost_usd_per_case: metricDelta(allBaselineObservations, firstCandidate, (record) => record.cost_usd, seed + 5, arithmeticMean),
      error_rate: errorRate,
      spent_usd: [...candidateObservations.values()].flat().reduce((total, observation) => total + observation.record.cost_usd, 0),
    };
    if (entry?.route) result.route = entry.route;
    results.push(result);
    if (stopped) {
      for (const remaining of opts.candidates.slice(results.length)) results.push(notMeasured(remaining, cases, opts.snapshot));
      break;
    }
  }

  const now = opts.now ?? new Date();
  const origins: Record<CaseOrigin, number> = { team: 0, trace: 0, imported: 0, generated: 0 };
  for (const testCase of cases) origins[testCase.origin]++;

  const limits = buildLimits({ cases, unknownPrices, notes, noise, stopped, ledger, registryGeneratedAt: opts.registryGeneratedAt, now, comparableCases });
  records.sort((a, b) => (a.model === b.model ? 0 : a.model === opts.baseline ? -1 : b.model === opts.baseline ? 1 : a.model < b.model ? -1 : 1) || (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0) || a.run - b.run);

  const report: SwapReport = {
    schema: "swapcheck.report/v1",
    id: "",
    created_at: now.toISOString(),
    swapcheck_version: VERSION,
    registry_generated_at: opts.registryGeneratedAt,
    baseline_model: opts.baseline,
    runs_per_case: n,
    case_count: cases.length,
    case_origins: origins,
    noise,
    candidates: results,
    spent_usd: ledger.spentUsd,
    budget_usd: opts.budgetUsd,
    stopped_early: stopped,
    vendors_seen: [...vendorsSeen].sort(),
    limits,
    runs: records,
  };
  report.id = `${now.toISOString().slice(0, 10)}-${hashOf([report.baseline_model, opts.candidates, cases.map((testCase) => hashOf(testCase)), report.created_at])}`;
  return report;
}

function errorsIn(sample: Sample, caseId: string): number {
  return (sample.get(caseId) ?? []).filter((observation) => observation.record.error !== undefined).length;
}

function notMeasured(model: string, cases: TestCase[], snapshot: RegistrySnapshot): CandidateResult {
  const empty: MetricDelta = { baseline: 0, candidate: 0, delta: null };
  const result: CandidateResult = {
    model,
    verdict: "NOT_ENOUGH_EVIDENCE",
    reason: "The budget ran out before this candidate was measured.",
    cases: cases.map((testCase) => ({
      case_id: testCase.id, case_hash: hashOf(testCase), baseline_passes: 0, baseline_runs: 0, candidate_passes: 0, candidate_runs: 0,
      p_value: 1, q_value: 1, confirmed: false, verdict: "NOT_ENOUGH_EVIDENCE" as const, failed_checks: [],
    })),
    suite_pass_rate: { baseline: 0, candidate: 0, ci95: [0, 0], p_value: 1 },
    latency_ms_p50: empty,
    cost_usd_per_case: empty,
    error_rate: 0,
    spent_usd: 0,
  };
  const route = findModel(model, snapshot)?.route;
  if (route) result.route = route;
  return result;
}

interface LimitInputs {
  cases: TestCase[];
  unknownPrices: string[];
  notes: { servedMismatch: Map<string, number>; droppedParams: Set<string>; meaningSkipped: number; judgeFailures: number; otherSkips: Set<string> };
  noise: { false_change_rate: number; flagged_cases: number };
  stopped: boolean;
  ledger: BudgetLedger;
  registryGeneratedAt: string;
  now: Date;
  comparableCases: number;
}

function buildLimits(input: LimitInputs): string[] {
  const { cases, notes } = input;
  const limits = [
    `Only the ${cases.length} ${cases.length === 1 ? "case" : "cases"} tested are covered. Behavior on anything else was not measured.`,
    "API replay cannot see changes to a consumer product or an agent harness around the model, such as system prompts, tools or routing added outside this API.",
    "Pass rates come from a small number of runs per case, so small differences can go undetected.",
  ];
  if (cases.some((testCase) => testCase.origin === "generated")) limits.push("Some cases are generated contract checks. They test the shape of responses, not whether the content is right.");
  if (input.stopped) limits.push("The budget was reached, so the run stopped early and some work was not done.");
  if (input.ledger.unknownBillingUsd > 0) limits.push(`Spend includes $${input.ledger.unknownBillingUsd.toFixed(4)} held at worst case for attempts whose billing could not be determined, so the true figure may be lower.`);
  if (input.comparableCases > 0 && input.noise.false_change_rate > 0.1) limits.push(`The model differed from itself on ${Math.round(input.noise.false_change_rate * 100)}% of cases between two samples, so results on this suite are noisy.`);
  if (notes.meaningSkipped > 0) limits.push(`${notes.meaningSkipped} meaning ${notes.meaningSkipped === 1 ? "check was" : "checks were"} skipped because no judge model is configured.`);
  if (notes.judgeFailures > 0) limits.push(`${notes.judgeFailures} meaning ${notes.judgeFailures === 1 ? "check" : "checks"} could not be judged and did not count.`);
  for (const detail of [...notes.otherSkips].slice(0, 10)) limits.push(`A check was skipped: ${detail}`);
  if (input.unknownPrices.length > 0) limits.push(`No price is listed for ${input.unknownPrices.join(", ")}. The budget override was used and the budget was enforced at the highest price in the registry, so cost figures for these models are assumed.`);
  for (const dropped of [...notes.droppedParams].sort().slice(0, 20)) limits.push(`Not sent to the provider (${dropped}), because that API does not accept it for this model.`);
  for (const [mapping, count] of [...notes.servedMismatch].sort().slice(0, 20)) limits.push(`The provider reported serving a different model than requested (${mapping}) on ${count} ${count === 1 ? "run" : "runs"}.`);
  const generated = Date.parse(input.registryGeneratedAt);
  if (!Number.isNaN(generated)) {
    const ageDays = (input.now.getTime() - generated) / 86_400_000;
    if (ageDays > STALE_REGISTRY_DAYS) limits.push(`The registry snapshot from ${input.registryGeneratedAt} is ${Math.floor(ageDays)} days old, so prices may have changed.`);
  }
  return limits.map((limit) => redactSecrets(limit));
}
