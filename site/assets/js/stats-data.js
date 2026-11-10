// Illustrative scenarios for the statistics diagram, shared by build.mjs and the browser.
// The counts are invented. The p and q values are what src/testing/stats.ts returns for
// these counts (fisherExact, benjaminiHochberg, fisherExactLower).
export const STAT_RUNS = 5;

export const SCENARIOS = {
  regressed: {
    verdict: "REGRESSED",
    tone: "bad",
    note: "refund-policy fell from 5 of 5 to 0 of 5 (p = 0.008, q = 0.063), then passed 1 of 5 on a fresh sample (p = 0.024). The drop happened twice, so it counts. Exit code 1.",
    cases: [
      { id: "refund-policy", base: "11111", cand: "00000", fresh: "01000", q: "0.06", flag: true },
      { id: "json-invoice", base: "11111", cand: "11111", q: "1.00" },
      { id: "tool-lookup", base: "11111", cand: "11101", q: "1.00" },
      { id: "tone-check", base: "11011", cand: "11111", q: "1.00" },
      { id: "date-parse", base: "11111", cand: "11111", q: "1.00" },
      { id: "summary-len", base: "11111", cand: "11111", q: "1.00" },
      { id: "label-ticket", base: "11111", cand: "10111", q: "1.00" },
      { id: "safety-refuse", base: "11111", cand: "11111", q: "1.00" },
    ],
  },
  noise: {
    verdict: "NO CHANGE DETECTED",
    tone: "ok",
    note: "refund-policy moved from 5 of 5 to 3 of 5 (p = 0.44, q = 1.00). Chance alone produces that often at five runs, so nothing is re-run and no drop is counted. Exit code 0. It only knows what these eight cases cover.",
    cases: [
      { id: "refund-policy", base: "11111", cand: "10110", q: "1.00" },
      { id: "json-invoice", base: "11111", cand: "11111", q: "1.00" },
      { id: "tool-lookup", base: "11101", cand: "11111", q: "1.00" },
      { id: "tone-check", base: "11111", cand: "11111", q: "1.00" },
      { id: "date-parse", base: "11111", cand: "01111", q: "1.00" },
      { id: "summary-len", base: "11111", cand: "11111", q: "1.00" },
      { id: "label-ticket", base: "11111", cand: "11111", q: "1.00" },
      { id: "safety-refuse", base: "10101", cand: "11101", q: "1.00" },
    ],
  },
};
