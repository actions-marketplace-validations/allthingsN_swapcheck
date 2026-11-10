/** Exact and resampling statistics, from scratch so the shipped package has no dependencies. */

const logFactorials: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) {
    logFactorials[i] = logFactorials[i - 1]! + Math.log(i);
  }
  return logFactorials[n]!;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** log P(the first row holds `a` successes) for the 2x2 table with these fixed margins. */
function logTableProbability(a: number, row1: number, row2: number, successes: number): number {
  return logChoose(row1, a) + logChoose(row2, successes - a) - logChoose(row1 + row2, successes);
}

function assertCounts(passesA: number, runsA: number, passesB: number, runsB: number): void {
  const counts = [passesA, runsA, passesB, runsB];
  if (counts.some((n) => !Number.isInteger(n) || n < 0) || passesA > runsA || passesB > runsB) {
    throw new RangeError(`Fisher exact needs whole counts with passes <= runs, got ${counts.join(", ")}.`);
  }
}

// Table probabilities that tie the observed one differ only by floating-point error.
const TIE_TOLERANCE = 1 + 1e-7;

/** Two-sided Fisher exact on pass counts: sums every table no more likely than the observed one. */
export function fisherExact(passesA: number, runsA: number, passesB: number, runsB: number): number {
  assertCounts(passesA, runsA, passesB, runsB);
  const successes = passesA + passesB;
  const low = Math.max(0, successes - runsB);
  const high = Math.min(runsA, successes);
  const observed = Math.exp(logTableProbability(passesA, runsA, runsB, successes));
  let total = 0;
  for (let a = low; a <= high; a++) {
    const p = Math.exp(logTableProbability(a, runsA, runsB, successes));
    if (p <= observed * TIE_TOLERANCE) total += p;
  }
  return Math.min(1, total);
}

/** One-sided Fisher exact: the chance B passes this few times or fewer, if A and B share a pass rate. */
export function fisherExactLower(passesA: number, runsA: number, passesB: number, runsB: number): number {
  assertCounts(passesA, runsA, passesB, runsB);
  const successes = passesA + passesB;
  const low = Math.max(0, successes - runsA);
  let total = 0;
  for (let b = low; b <= passesB; b++) {
    total += Math.exp(logTableProbability(b, runsB, runsA, successes));
  }
  return Math.min(1, total);
}

/** Benjamini-Hochberg adjusted p-values, returned in the input order. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const entry = order[rank - 1]!;
    running = Math.min(running, (entry.p * m) / rank);
    adjusted[entry.index] = Math.min(1, running);
  }
  return adjusted;
}

/** Small, fast, seedable generator (mulberry32) so permutation and bootstrap results reproduce. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PermutationResult {
  p: number;
  mean: number;
  exact: boolean;
}

export interface PermutationOptions {
  seed?: number;
  iterations?: number;
  /** "lower" tests whether the mean difference is below zero. Default "two-sided". */
  alternative?: "two-sided" | "lower";
}

const EXACT_PERMUTATION_LIMIT = 14;

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Sign-flip permutation test on paired differences. Exact up to 14 non-zero pairs, sampled beyond. */
export function pairedPermutationTest(differences: readonly number[], options: PermutationOptions = {}): PermutationResult {
  const nonZero = differences.filter((d) => d !== 0);
  const mean = differences.length > 0 ? sum(differences) / differences.length : 0;
  if (nonZero.length === 0) return { p: 1, mean, exact: true };
  const observed = sum(nonZero);
  const lower = options.alternative === "lower";
  const tolerance = 1e-9;
  const isExtreme = (candidate: number): boolean =>
    lower ? candidate <= observed + tolerance : Math.abs(candidate) >= Math.abs(observed) - tolerance;

  if (nonZero.length <= EXACT_PERMUTATION_LIMIT) {
    // Gray code: each step flips one sign, so the sum updates in constant time.
    const total = 2 ** nonZero.length;
    const signs = nonZero.map(() => 1);
    let candidate = observed;
    let extreme = isExtreme(candidate) ? 1 : 0;
    for (let step = 1; step < total; step++) {
      const flip = Math.log2(step & -step);
      candidate -= 2 * signs[flip]! * nonZero[flip]!;
      signs[flip] = -signs[flip]!;
      if (isExtreme(candidate)) extreme++;
    }
    return { p: extreme / total, mean, exact: true };
  }

  const iterations = options.iterations ?? 10_000;
  const random = seededRandom(options.seed ?? 1);
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let candidate = 0;
    for (const difference of nonZero) candidate += random() < 0.5 ? -difference : difference;
    if (isExtreme(candidate)) extreme++;
  }
  return { p: (extreme + 1) / (iterations + 1), mean, exact: false };
}

export interface BootstrapOptions {
  seed?: number;
  iterations?: number;
  confidence?: number;
}

/** Percentile bootstrap confidence interval for the mean. */
export function bootstrapCI(values: readonly number[], options: BootstrapOptions = {}): [number, number] {
  if (values.length === 0) return [0, 0];
  const iterations = options.iterations ?? 2_000;
  const confidence = options.confidence ?? 0.95;
  const random = seededRandom(options.seed ?? 1);
  const means = new Float64Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]!;
    means[iteration] = total / values.length;
  }
  means.sort();
  const tail = (1 - confidence) / 2;
  const lowIndex = Math.min(iterations - 1, Math.floor(tail * iterations));
  const highIndex = Math.min(iterations - 1, Math.ceil((1 - tail) * iterations) - 1);
  return [means[lowIndex]!, means[highIndex]!];
}

export function p50(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
