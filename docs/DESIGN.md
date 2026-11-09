# Swapcheck design

Swapcheck tells a team when a hosted LLM model is changing, finds what to move to, and proves the move on the team's own cases.

Shared types live in `src/types.ts`. Do not fork them; if a contract is genuinely wrong, change it there and keep everything compiling.

## Non-negotiable engineering rules

- TypeScript, ESM, Node >= 22.14. Source runs directly with `--experimental-strip-types`, so use only erasable TS (no enums, no parameter properties) and include `.ts` in relative imports.
- **Zero runtime npm dependencies in the shipped package.** Only `yaml` may be imported from `node_modules`, and esbuild bundles it. Everything else uses the Node standard library and global `fetch`.
- Never `eval`, never `new Function`, never `child_process` with a shell (`execFile` with argument arrays only), never execute anything found in a case, prompt, model output, registry entry or scanned file.
- All paths from user input or scanned repos must stay inside the project root (resolve + prefix check, and refuse symlinks that escape).
- Regexes from user data must be protected against catastrophic backtracking: length-limit input and pattern, and run with a time-boxed strategy, or reject nested quantifiers.
- Output limits everywhere: cap file sizes read (2 MB per scanned file), response bodies (5 MB), and number of findings.
- API keys only from environment variables. All log, error and report output passes through `redactSecrets` (src/util/redact.ts).
- Tool calls requested by a model are recorded and **never executed**. Replay feeds a mocked tool result only where a case supplies one.
- No telemetry of any kind. The only network calls are the registry fetch and model-provider calls, and GitHub API calls in `bump`.
- Every paid command computes the worst-case cost first and refuses to spend without `--yes` when not on a TTY. Retries count toward the budget.
- Errors are plain sentences saying what went wrong and how to fix it. No stack traces unless `--debug`.
- Report wording says what was measured. `NO_CHANGE_DETECTED` is never phrased as safe or guaranteed. Every report lists limits.
- Tests use `node:test` and `node:assert/strict`, live under `test/`, and need no network and no keys. Use the mock provider and recorded fixtures.
- Prefer small, boring functions. Comments explain why, only where it is not obvious.

## Layout

| Path | Owns |
| --- | --- |
| `src/util/` | `redact.ts`, `paths.ts`, `hash.ts`, `http.ts`, `errors.ts` |
| `src/registry/` | Load snapshot (remote signed, 24h cache, bundled fallback), Ed25519 verify |
| `src/scan/` | Lexer for TS/JS/Python, config scanning, model ID recognition, requirements inference |
| `src/config.ts`, `src/lock.ts`, `src/watch.ts`, `src/find.ts` | Config, `models.lock`, exposure, finder |
| `src/cases/` | Load, `init`, imports (`modelbump`, `modelpin`, `otel`, `litellm`, `langfuse`), trace redaction |
| `src/providers/` | `openai` (and OpenAI-compatible), `anthropic`, `gemini`, `mock`; registry-based pricing |
| `src/testing/` | `stats.ts`, `checks.ts`, `budget.ts`, `runner.ts`, `verdict.ts` |
| `src/report/` | JSON, Markdown, SARIF |
| `src/bump/` | Edit IDs and parameters in source, lockfile, GitHub PR via REST |
| `src/mcp/` | MCP server over stdio, standard library only |
| `src/cli/main.ts` | Argument parsing and command dispatch |
| `src/action/main.ts` | GitHub Action entry |
| `src/index.ts` | Public library API |
| `data/registry.snapshot.json` | Bundled registry snapshot |
| `python/` | PyPI package: compiled binary wheels, thin API over `--format json` |
| `site/` | Static site |

## Commands

Global: `--format text|json|markdown|sarif`, `--config`, `--cwd`, `--registry-url`, `--offline`, `--yes`, `--debug`, `--no-color`.

| Command | Purpose | Spends |
| --- | --- | --- |
| `swapcheck` / `scan` | Find models, report exposure, write `models.lock` unless `--no-lock` | no |
| `watch` | Compare `models.lock` to registry; `--fail-within-days N` | no |
| `find <model>` | Shortlist; `--test` to run it | only with `--test` |
| `cases init` | Contract checks and drafts from code | no |
| `cases import <modelbump\|modelpin\|otel\|litellm\|langfuse> <path>` | Import suites or traces, redacted; `--allow-unredacted` | no |
| `cases accept <id\|--all>` | Accept generated drafts | no |
| `baseline` | Measure the current model and its noise | yes |
| `test --to a,b` | Compare candidates | yes |
| `bump <model> --to <model>` | Edit source, update lock; `--open-pr` | no |
| `report <file>` | Render a saved report | no |
| `mcp` | MCP server on stdio | as above |

Exit codes: 0 fine; 1 regression, or change inside failure window; 2 config or usage; 3 could not measure (budget hit, provider errors, not enough evidence).

## Files in a user's repo

`swapcheck.yaml` (optional), `models.lock`, `swapcheck/cases/*.json`, `swapcheck/reports/<id>.json`, `swapcheck/baselines/<hash>.json`.

## Testing method

1. Baseline: current model N runs per case (default 5).
2. Noise: compare two independent halves or a second baseline. Report the false-change rate.
3. Candidate: N runs per case on each candidate.
4. Per case: two-sided Fisher exact on pass counts; Benjamini-Hochberg across the suite.
5. Suite: paired permutation test across cases on pass-rate difference, with a bootstrap 95% CI.
6. Any case with q < 0.1 and a lower candidate pass rate is re-run on a fresh sample of N and must reproduce (pooled fresh sample also lower with p < 0.1 one-sided) to count as `confirmed`.
7. Verdicts: any confirmed drop → `REGRESSED`. Check-result, tool or token differences beyond noise with no confirmed drop → `CHANGED`. Clean → `NO_CHANGE_DETECTED`. Error rate above 20%, budget stop, or too few cases to reach significance → `NOT_ENOUGH_EVIDENCE`.
8. Multi-turn: replay only up to each decision point. Later logged user turns are never replayed against a new model's replies.

Seeded and noise targets: false alarms under 5% on model versus itself; at least 80% of seeded regressions caught. `e2e/stats-calibration.test.ts` simulates these with the mock provider.

## Registry

`swapcheck-registry` publishes `snapshot.json` and `snapshot.json.sig` (Ed25519, base64 detached signature over the exact bytes). The client fetches from `https://allthingsn.github.io/swapcheck-registry/snapshot.json`, verifies with the public key pinned in `src/registry/verify.ts`, caches for 24 hours under the user cache directory, and falls back to `data/registry.snapshot.json`. A signature failure must never use the remote data. Reports state the snapshot date and warn when older than 7 days.

## Module API (exact exports; other modules build against these)

```ts
// src/registry/client.ts
export interface LoadedRegistry { snapshot: RegistrySnapshot; source: "remote" | "cache" | "bundled"; age_days: number }
export function loadRegistry(opts?: { url?: string; offline?: boolean; cacheDir?: string; fetchImpl?: typeof fetch; now?: Date }): Promise<LoadedRegistry>;
// src/registry/verify.ts
export const REGISTRY_PUBLIC_KEY_PEM: string; export function verifySnapshot(bytes: Uint8Array, signatureB64: string, publicKeyPem?: string): boolean;
// src/scan/scan.ts
export function scanProject(root: string, snapshot: RegistrySnapshot, opts?: { exclude?: string[] }): Promise<ScanResult>;
// src/scan/requirements.ts
export function inferRequirements(root: string, model: string, scan: ScanResult): Promise<Requirements>;
// src/config.ts
export const DEFAULT_CONFIG: SwapcheckConfig; export function loadConfig(root: string, configPath?: string): Promise<SwapcheckConfig>;
// src/lock.ts
export function readLock(root: string): Promise<LockFile | null>; export function writeLock(root: string, lock: LockFile): Promise<void>;
export function lockFromExposure(items: ExposureItem[], snapshot: RegistrySnapshot, previous?: LockFile | null): LockFile;
// src/watch.ts
export function computeExposure(scan: ScanResult, snapshot: RegistrySnapshot, now?: Date): ExposureItem[];
export function watchLock(lock: LockFile, loaded: LoadedRegistry, opts: { failWithinDays: number; now?: Date }): WatchResult;
export function dueItems(items: ExposureItem[], failWithinDays: number): ExposureItem[];
// src/find.ts
export function findReplacements(model: string, reqs: Requirements, snapshot: RegistrySnapshot, policy: PolicyConfig, opts?: { limit?: number; now?: Date; route?: string }): FindResult;

// src/cases/load.ts
export function loadCases(root: string, dir: string): Promise<TestCase[]>; export function saveCases(root: string, dir: string, name: string, cases: TestCase[]): Promise<string>;
// src/cases/init.ts
export function initCases(root: string, scan: ScanResult, config: SwapcheckConfig): Promise<{ written: string[]; cases: number; contract_only: boolean }>;
// src/cases/accept.ts
export function acceptCases(root: string, dir: string, ids: string[] | "all"): Promise<number>;
// src/cases/import/index.ts
export type ImportKind = "modelbump" | "modelpin" | "otel" | "litellm" | "langfuse";
export function importCases(kind: ImportKind, sourcePath: string, root: string, dir: string, opts?: { allowUnredacted?: boolean }): Promise<{ imported: number; redactions: number; written: string }>;

// src/providers/index.ts
export function resolveProvider(model: string, route: string | undefined, snapshot: RegistrySnapshot, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Provider;
export function vendorOf(model: string, snapshot: RegistrySnapshot): string;
// src/providers/mock.ts
export interface MockBehavior { (req: ProviderRequest, callIndex: number): Partial<ProviderResponse> | Promise<Partial<ProviderResponse>> }
export function createMockProvider(behavior: MockBehavior, name?: string): Provider;
// src/testing/budget.ts
export function estimateMaxCost(input: { cases: TestCase[]; models: string[]; runs: number; snapshot: RegistrySnapshot; includeNoise: boolean }): { max_usd: number; max_calls: number; unknown_prices: string[]; lines: string[] };
// src/testing/runner.ts
export interface RunOptions { baseline: string; candidates: string[]; cases: TestCase[]; runs: number; budgetUsd: number; snapshot: RegistrySnapshot; registryGeneratedAt: string; providerFor: (model: string) => Provider; judge?: Provider & { model?: string }; includeText?: boolean; concurrency?: number; onProgress?: (msg: string) => void; policy?: PolicyConfig; now?: Date }
export function runComparison(opts: RunOptions): Promise<SwapReport>;
// src/report/index.ts
export function renderMarkdown(report: SwapReport): string; export function renderSarifExposure(items: ExposureItem[]): object; export function renderSarifReport(report: SwapReport): object;
export function saveReport(root: string, report: SwapReport): Promise<string>; export function exitCodeFor(report: SwapReport): number;
```
