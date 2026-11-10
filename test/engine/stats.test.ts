import { test } from "node:test";
import assert from "node:assert/strict";
import { benjaminiHochberg, bootstrapCI, fisherExact, fisherExactLower, p50, pairedPermutationTest, seededRandom } from "../../src/testing/stats.ts";

const close = (actual: number, expected: number, tolerance = 1e-3): void => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not close to ${expected}`);
};

test("two-sided Fisher exact matches the known values", () => {
  close(fisherExact(5, 5, 1, 5), 0.0476, 5e-4);
  close(fisherExact(5, 5, 2, 5), 0.1667, 5e-4);
  close(fisherExact(5, 5, 5, 5), 1);
  close(fisherExact(5, 5, 0, 5), 0.0079, 5e-4);
  // Classic worked example: 8/10 vs 2/10.
  close(fisherExact(8, 10, 2, 10), 0.02301, 5e-4);
});

test("Fisher exact is symmetric in its two samples", () => {
  close(fisherExact(3, 7, 9, 12), fisherExact(9, 12, 3, 7), 1e-12);
});

test("one-sided Fisher matches a hand-computed tail", () => {
  // Tail of 5/5 vs 2/5: tables with B at 2 or fewer given 7 total passes.
  close(fisherExactLower(5, 5, 2, 5), 1 / 12, 1e-3);
  close(fisherExactLower(5, 5, 5, 5), 1);
});

test("Fisher exact refuses impossible counts", () => {
  assert.throws(() => fisherExact(6, 5, 1, 5), RangeError);
  assert.throws(() => fisherExact(-1, 5, 1, 5), RangeError);
});

test("Benjamini-Hochberg matches a known adjustment and keeps input order", () => {
  const adjusted = benjaminiHochberg([0.005, 0.001, 0.02, 0.05]);
  assert.deepEqual(adjusted.map((q) => Number(q.toFixed(6))), [0.01, 0.004, 0.026667, 0.05]);
  assert.deepEqual(benjaminiHochberg([]), []);
  assert.ok(benjaminiHochberg([0.9, 0.95]).every((q) => q <= 1));
});

test("Benjamini-Hochberg output is monotone in the p-values", () => {
  const ps = [0.04, 0.01, 0.2, 0.03, 0.5];
  const qs = benjaminiHochberg(ps);
  const byP = ps.map((p, i) => ({ p, q: qs[i]! })).sort((a, b) => a.p - b.p);
  for (let i = 1; i < byP.length; i++) assert.ok(byP[i]!.q >= byP[i - 1]!.q);
});

test("paired permutation test is exact for small samples", () => {
  // Five positive differences: only the two extreme sign patterns of 32 are as large.
  const result = pairedPermutationTest([1, 2, 3, 4, 5], {});
  assert.equal(result.exact, true);
  close(result.p, 2 / 32, 1e-9);
  const lower = pairedPermutationTest([-1, -2, -3, -4, -5], { alternative: "lower" });
  close(lower.p, 1 / 32, 1e-9);
  assert.equal(pairedPermutationTest([0, 0, 0]).p, 1);
});

test("paired permutation test reproduces with a seed and differs without", () => {
  const data = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -0.2 : 0.1));
  const a = pairedPermutationTest(data, { seed: 42 });
  const b = pairedPermutationTest(data, { seed: 42 });
  const c = pairedPermutationTest(data, { seed: 43 });
  assert.equal(a.exact, false);
  assert.equal(a.p, b.p);
  assert.notEqual(a.p, c.p);
});

test("bootstrap CI is seeded, contains the mean and handles constants", () => {
  const data = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const a = bootstrapCI(data, { seed: 7 });
  assert.deepEqual(a, bootstrapCI(data, { seed: 7 }));
  assert.ok(a[0] < 0.45 && a[1] > 0.45);
  assert.deepEqual(bootstrapCI([3, 3, 3], { seed: 1 }), [3, 3]);
  assert.deepEqual(bootstrapCI([]), [0, 0]);
});

test("p50 handles odd, even and empty inputs", () => {
  assert.equal(p50([3, 1, 2]), 2);
  assert.equal(p50([1, 2, 3, 4]), 2.5);
  assert.equal(p50([]), 0);
});

test("seeded random is deterministic and uniform enough", () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  const values = Array.from({ length: 2000 }, () => a());
  assert.equal(values[100], Array.from({ length: 101 }, () => b())[100]);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
});
