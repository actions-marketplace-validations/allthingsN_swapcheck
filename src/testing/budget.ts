import type { ProviderRequest, RegistrySnapshot, TestCase } from "../types.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_ATTEMPTS } from "../providers/shared.ts";

export interface Price {
  input: number;
  output: number;
}

/** Thrown when one more call would not fit. The runner stops cleanly on it. */
export class BudgetExhausted extends Error {
  constructor() {
    super("The budget was reached.");
    this.name = "BudgetExhausted";
  }
}

/** The price on `route`. With no matching route, the highest price listed for the ID, so the budget still bounds it. */
export function priceOf(model: string, snapshot: RegistrySnapshot, route?: string): Price | undefined {
  const rows = snapshot.models.filter((candidate) => candidate.id === model);
  if (rows.length === 0) return undefined;
  const exact = route === undefined ? undefined : rows.find((row) => row.route === route);
  if (exact) return exact.cost;
  return { input: Math.max(...rows.map((row) => row.cost.input)), output: Math.max(...rows.map((row) => row.cost.output)) };
}

/** Used only with an explicit override, so the budget still bounds a model with no listed price. */
export function highestKnownPrice(snapshot: RegistrySnapshot): Price {
  const fallback = { input: 100, output: 400 };
  if (snapshot.models.length === 0) return fallback;
  return {
    input: Math.max(...snapshot.models.map((entry) => entry.cost.input)),
    output: Math.max(...snapshot.models.map((entry) => entry.cost.output)),
  };
}

// No tokenizer produces more tokens than UTF-8 bytes in ordinary text, so bytes bound the input.
function inputTokenBound(req: Pick<ProviderRequest, "messages" | "tools" | "response_format">): number {
  const payload = JSON.stringify([req.messages, req.tools ?? null, req.response_format ?? null]);
  return Buffer.byteLength(payload, "utf8") + 16;
}

export function usdFor(inputTokens: number, outputTokens: number, price: Price): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** The most one attempt can cost: every input byte as a token, and the full output allowance. */
export function worstCaseUsd(req: Pick<ProviderRequest, "messages" | "tools" | "response_format" | "max_tokens">, price: Price): number {
  return usdFor(inputTokenBound(req), req.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, price);
}

export const JUDGE_MAX_TOKENS = 256;
/** Far above real tokens, but it makes the judge's input, and so its worst-case price, finite. */
const JUDGE_ANSWER_CHARS_PER_TOKEN = 16;
/** The judge's instructions, fences and JSON framing. */
const JUDGE_PROMPT_OVERHEAD_BYTES = 2048;
/** The longest JSON spelling of one UTF-16 unit is a six-byte escape. */
const MAX_JSON_BYTES_PER_CHAR = 6;

/** How much of an answer the judge sees. */
export function judgedAnswerLimit(testCase: Pick<TestCase, "max_tokens">): number {
  return (testCase.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * JUDGE_ANSWER_CHARS_PER_TOKEN;
}

function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function worstJudgeUsd(testCase: TestCase, rubric: string | undefined, price: Price): number {
  const lastUser = [...testCase.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const inputBytes = JUDGE_PROMPT_OVERHEAD_BYTES + jsonBytes(rubric ?? "") + jsonBytes(lastUser) + judgedAnswerLimit(testCase) * MAX_JSON_BYTES_PER_CHAR;
  return usdFor(inputBytes, JUDGE_MAX_TOKENS, price);
}

export interface Reservation {
  amount: number;
  settled: boolean;
}

/** Tracks money committed. Reserving before sending means concurrent calls cannot overshoot. */
export class BudgetLedger {
  readonly limitUsd: number;
  private committed = 0;
  /** Charged at worst case because the provider gave no usage for the attempt. */
  unknownBillingUsd = 0;

  constructor(limitUsd: number) {
    this.limitUsd = limitUsd;
  }

  reserve(amount: number): Reservation {
    if (this.committed + amount > this.limitUsd + 1e-12) throw new BudgetExhausted();
    this.committed += amount;
    return { amount, settled: false };
  }

  /** Replaces a reservation with the true cost once the provider reports usage. */
  settle(reservation: Reservation, actualUsd: number): void {
    if (reservation.settled) return;
    this.committed += actualUsd - reservation.amount;
    reservation.amount = actualUsd;
    reservation.settled = true;
  }

  /** Keeps the worst-case charge: the attempt may have been billed and no figure came back. */
  keepWorstCase(reservation: Reservation): void {
    if (reservation.settled) return;
    this.unknownBillingUsd += reservation.amount;
    reservation.settled = true;
  }

  get spentUsd(): number {
    return this.committed;
  }
}

export interface MaxCostInput {
  cases: TestCase[];
  /** The baseline first, then the candidates. */
  models: string[];
  runs: number;
  snapshot: RegistrySnapshot;
  includeNoise: boolean;
  /** The route each model is called on, when configured. */
  routeFor?: (model: string) => string | undefined;
  /** The judge model, when meaning checks will be graded. */
  judge?: string;
}

export interface MaxCost {
  max_usd: number;
  max_calls: number;
  unknown_prices: string[];
  lines: string[];
}

function usd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/**
 * The most a comparison can spend if every call uses its whole allowance and is retried to the
 * limit. Confirmation runs are included for every case, and the baseline is re-sampled once.
 */
export function estimateMaxCost(input: MaxCostInput): MaxCost {
  const cases = input.cases.filter((testCase) => testCase.accepted);
  const hasCandidates = input.models.length > 1;
  const baselineSets = 1 + (input.includeNoise ? 1 : 0) + (hasCandidates ? 1 : 0);
  const candidateSets = 2;
  const lines: string[] = [];
  const unknown: string[] = [];
  let maxUsd = 0;
  let calls = 0;
  let observations = 0;

  input.models.forEach((model, index) => {
    const sets = index === 0 ? baselineSets : candidateSets;
    observations += input.runs * sets;
    const modelCalls = cases.length * input.runs * sets;
    calls += modelCalls;
    const price = priceOf(model, input.snapshot, input.routeFor?.(model));
    if (!price) {
      unknown.push(model);
      lines.push(`${model}: up to ${modelCalls} calls; no price is listed for this model, so its cost cannot be bounded.`);
      return;
    }
    let modelUsd = 0;
    for (const testCase of cases) modelUsd += worstCaseUsd(testCase, price) * input.runs * sets;
    maxUsd += modelUsd * MAX_ATTEMPTS;
    lines.push(`${model}: up to ${modelCalls} calls, at most ${usd(modelUsd)} without retries.`);
  });

  // Every answer collected above, including escalation re-runs, can be graded once per meaning check.
  const meaning = cases.flatMap((testCase) => testCase.checks.flatMap((check) => (check.type === "meaning" ? [{ testCase, rubric: check.rubric }] : [])));
  if (input.judge !== undefined && meaning.length > 0) {
    const judgeCalls = meaning.length * observations;
    calls += judgeCalls;
    const price = priceOf(input.judge, input.snapshot);
    if (price) {
      const judgeUsd = meaning.reduce((total, item) => total + worstJudgeUsd(item.testCase, item.rubric, price), 0) * observations;
      maxUsd += judgeUsd * MAX_ATTEMPTS;
      lines.push(`${input.judge} (judge): up to ${judgeCalls} calls, one per meaning check on every answer, at most ${usd(judgeUsd)} without retries.`);
    } else {
      unknown.push(input.judge);
      lines.push(`${input.judge} (judge): up to ${judgeCalls} calls; no price is listed for this model, so its cost cannot be bounded.`);
    }
  }

  lines.push(`Every call can be retried, up to ${MAX_ATTEMPTS} attempts each. The worst case of ${usd(maxUsd)} assumes all of them are; the budget stops the run earlier if it is reached.`);
  return { max_usd: maxUsd, max_calls: calls * MAX_ATTEMPTS, unknown_prices: unknown, lines };
}
