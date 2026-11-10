import type { Verdict } from "../types.ts";
import { benjaminiHochberg, pairedPermutationTest } from "./stats.ts";

export const ERROR_RATE_LIMIT = 0.2;
/** With fewer cases a sign-flip test cannot reach p < 0.05 at all (2/2^5 = 0.0625). */
export const MIN_CASES_FOR_EVIDENCE = 6;
/** A case is re-run when its first sample looks lower at this level. Only the re-run can confirm. */
export const ESCALATION_P = 0.1;
export const CONFIRMATION_ALPHA = 0.1;
export const SUITE_ALPHA = 0.05;
const CHANGE_SIGNAL_Q = 0.02;
const TOKEN_PRACTICAL_RATIO = 0.2;
const SIGNAL_PERMUTATIONS = 2_000;

export interface CaseSignals {
  passes: number;
  runs: number;
  /** Check type to [passes, runs]. */
  checks: Map<string, [number, number]>;
  /** Tool name to number of runs that called it. */
  tools: Map<string, number>;
  outputTokens: number[];
}

export interface ChangeSignal {
  key: string;
  p: number;
  description: string;
}

function rate(passes: number, runs: number): number {
  return runs > 0 ? passes / runs : 0;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

/**
 * Compares two groups of runs on everything except confirmed pass-rate drops. The same function
 * compares the two baseline halves, so a signal present in the noise comparison can be discounted.
 */
export function detectChangeSignals(reference: Map<string, CaseSignals>, other: Map<string, CaseSignals>, seed: number): ChangeSignal[] {
  const caseIds = [...reference.keys()].filter((id) => (other.get(id)?.runs ?? 0) > 0 && (reference.get(id)?.runs ?? 0) > 0);
  const pairs = caseIds.map((id) => ({ a: reference.get(id)!, b: other.get(id)! }));
  const signals: ChangeSignal[] = [];
  const test = (key: string, description: string, differences: number[]): void => {
    if (differences.length > 0) signals.push({ key, description, p: pairedPermutationTest(differences, { seed, iterations: SIGNAL_PERMUTATIONS }).p });
  };

  test("pass_rate", "The suite pass rate differs", pairs.map(({ a, b }) => rate(b.passes, b.runs) - rate(a.passes, a.runs)));

  const checkTypes = new Set(pairs.flatMap(({ a, b }) => [...a.checks.keys(), ...b.checks.keys()]));
  for (const type of checkTypes) {
    const relevant = pairs.filter(({ a, b }) => a.checks.has(type) && b.checks.has(type));
    test(`check:${type}`, `Results of the ${type} check differ`, relevant.map(({ a, b }) => {
      const [aPass, aRuns] = a.checks.get(type)!;
      const [bPass, bRuns] = b.checks.get(type)!;
      return rate(bPass, bRuns) - rate(aPass, aRuns);
    }));
  }

  const toolNames = new Set(pairs.flatMap(({ a, b }) => [...a.tools.keys(), ...b.tools.keys()]));
  for (const name of toolNames) {
    test(`tool:${name}`, `How often the tool ${name} is called differs`, pairs.map(({ a, b }) => rate(b.tools.get(name) ?? 0, b.runs) - rate(a.tools.get(name) ?? 0, a.runs)));
  }

  const logRatios = pairs
    .filter(({ a, b }) => mean(a.outputTokens) > 0 && mean(b.outputTokens) > 0)
    .map(({ a, b }) => Math.log(mean(b.outputTokens) / mean(a.outputTokens)));
  if (logRatios.length > 0 && Math.abs(Math.exp(mean(logRatios)) - 1) > TOKEN_PRACTICAL_RATIO) {
    test("tokens", "Output length differs", logRatios);
  }
  return signals;
}

/** Signals that survive false-discovery control and do not also appear between the baseline halves. */
export function signalsBeyondNoise(candidate: ChangeSignal[], noise: ChangeSignal[]): ChangeSignal[] {
  const significant = (signals: ChangeSignal[]): ChangeSignal[] => {
    const q = benjaminiHochberg(signals.map((signal) => signal.p));
    return signals.filter((_, index) => q[index]! < CHANGE_SIGNAL_Q);
  };
  const noisy = new Set(significant(noise).map((signal) => signal.key));
  return significant(candidate).filter((signal) => !noisy.has(signal.key));
}

export interface CaseVerdictInput {
  complete: boolean;
  confirmed: boolean;
  escalated: boolean;
  confirmationComplete: boolean;
  qValue: number;
}

export function decideCaseVerdict(input: CaseVerdictInput): Verdict {
  if (!input.complete || (input.escalated && !input.confirmationComplete)) return "NOT_ENOUGH_EVIDENCE";
  if (input.confirmed) return "REGRESSED";
  return input.qValue < 0.1 ? "CHANGED" : "NO_CHANGE_DETECTED";
}

export interface CandidateVerdictInput {
  caseCount: number;
  /** Cases with at least one usable run on both sides. */
  evaluatedCases: number;
  confirmedCases: number;
  suiteConfirmed: boolean;
  errorRate: number;
  baselineErrorRate: number;
  /** True when the budget stopped work that this candidate still needed. */
  unfinished: boolean;
  changeSignals: ChangeSignal[];
  /** The most frequent error, quoted when errors decide the verdict. */
  commonError?: string;
}

export function decideCandidateVerdict(input: CandidateVerdictInput): { verdict: Verdict; reason: string } {
  const tested = `the ${input.caseCount} ${input.caseCount === 1 ? "case" : "cases"} tested`;
  const errorRate = Math.max(input.errorRate, input.baselineErrorRate);
  if (errorRate > ERROR_RATE_LIMIT) {
    const who = input.errorRate >= input.baselineErrorRate ? "candidate" : "baseline";
    return { verdict: "NOT_ENOUGH_EVIDENCE", reason: `${Math.round(errorRate * 100)}% of ${who} calls failed, above the ${Math.round(ERROR_RATE_LIMIT * 100)}% limit, so the comparison could not be measured.${input.commonError ? ` Most common error: ${input.commonError}` : ""}` };
  }
  if (input.confirmedCases > 0 || input.suiteConfirmed) {
    const parts: string[] = [];
    if (input.confirmedCases > 0) parts.push(`${input.confirmedCases} of ${input.caseCount} ${input.caseCount === 1 ? "case" : "cases"} passed less often on the candidate and the drop reproduced on a fresh sample`);
    if (input.suiteConfirmed) parts.push("the suite pass rate as a whole was lower and that reproduced on a fresh sample");
    return { verdict: "REGRESSED", reason: `${parts.join("; ")}.` };
  }
  if (input.unfinished) return { verdict: "NOT_ENOUGH_EVIDENCE", reason: `The budget ran out before this candidate was fully measured on ${tested}.` };
  if (input.evaluatedCases < MIN_CASES_FOR_EVIDENCE) {
    return { verdict: "NOT_ENOUGH_EVIDENCE", reason: `Only ${input.evaluatedCases} usable ${input.evaluatedCases === 1 ? "case" : "cases"} were measured; at least ${MIN_CASES_FOR_EVIDENCE} are needed before a difference could reach significance.` };
  }
  if (input.changeSignals.length > 0) {
    return { verdict: "CHANGED", reason: `No drop was confirmed on ${tested}, but differences beyond the measured noise were found: ${input.changeSignals.map((signal) => signal.description).join("; ")}.` };
  }
  return { verdict: "NO_CHANGE_DETECTED", reason: `No difference beyond the measured noise was detected on ${tested}. This covers only those cases.` };
}
