import { loadCases } from "../cases/load.ts";
import { resolveProvider, vendorOf } from "../providers/index.ts";
import { saveReport } from "../report/index.ts";
import { estimateMaxCost } from "../testing/budget.ts";
import { runComparison } from "../testing/runner.ts";
import { EXIT, type Provider, type SwapReport, type TestCase } from "../types.ts";
import { SwapcheckError } from "../util/errors.ts";
import { clean, usd } from "./output.ts";
import type { Project } from "./project.ts";

export interface ComparisonRequest {
  baseline: string;
  candidates: string[];
  runs?: number;
  maxUsd?: number;
  route?: string;
  judge?: string;
  allowUnknownPrices?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ComparisonPlan {
  baseline: string;
  candidates: string[];
  cases: TestCase[];
  runs: number;
  budgetUsd: number;
  maxUsd: number;
  maxCalls: number;
  vendors: string[];
  estimateLines: string[];
  unknownPrices: string[];
  allowUnknownPrices: boolean;
  providerFor: (model: string) => Provider;
  routeFor: (model: string) => string | undefined;
  judge?: Provider & { model?: string };
}

/** Builds everything needed to run, before any money is at stake, so missing keys fail first. */
export async function planComparison(project: Project, request: ComparisonRequest): Promise<ComparisonPlan> {
  const { snapshot } = project.registry;
  const env = request.env ?? process.env;
  const all = await loadCases(project.root, project.config.cases);
  const cases = all.filter((testCase) => testCase.accepted);
  if (cases.length === 0) {
    const drafts = all.length > 0 ? ` ${all.length} generated drafts are waiting; run swapcheck cases accept --all once you have read them.` : " Run swapcheck cases init to create some.";
    throw new SwapcheckError(`There are no accepted cases in ${project.config.cases}.${drafts}`);
  }

  const runs = request.runs ?? project.config.runs;
  const budgetUsd = request.maxUsd ?? project.config.budget.max_usd_per_run;
  const models = [request.baseline, ...request.candidates];
  const routeFor = (model: string): string | undefined =>
    (model === request.baseline ? request.route : undefined) ?? project.config.models.find((m) => m.id === model)?.route;
  const providers = new Map<string, Provider>();
  for (const model of models) providers.set(model, resolveProvider(model, routeFor(model), snapshot, env));

  let judge: ComparisonPlan["judge"];
  if (request.judge) judge = Object.assign(resolveProvider(request.judge, undefined, snapshot, env), { model: request.judge });

  const priced = request.judge ? [...models, request.judge] : models;
  const estimate = estimateMaxCost({ cases, models, runs, snapshot, includeNoise: true, routeFor, ...(request.judge ? { judge: request.judge } : {}) });
  const allowUnknownPrices = request.allowUnknownPrices === true;
  if (estimate.unknown_prices.length > 0 && !allowUnknownPrices) {
    throw new SwapcheckError(
      `The registry has no price for ${estimate.unknown_prices.map((m) => clean(m)).join(", ")}, so the worst-case cost cannot be worked out and nothing was spent. Pick a model the registry prices, update the registry, or pass --allow-unknown-prices to make --max-usd the limit.`,
    );
  }

  const plan: ComparisonPlan = {
    baseline: request.baseline,
    candidates: request.candidates,
    cases,
    runs,
    budgetUsd,
    // An unpriced model has no upper bound of its own, so the budget is the only honest maximum.
    maxUsd: estimate.unknown_prices.length > 0 ? budgetUsd : Math.min(estimate.max_usd, budgetUsd),
    maxCalls: estimate.max_calls,
    vendors: [...new Set(priced.map((model) => vendorOf(model, snapshot)))].sort(),
    estimateLines: estimate.lines,
    unknownPrices: estimate.unknown_prices,
    allowUnknownPrices,
    routeFor,
    providerFor: (model) => {
      const provider = providers.get(model);
      if (!provider) throw new SwapcheckError(`No provider was set up for ${model}.`, EXIT.UNMEASURED);
      return provider;
    },
  };
  if (judge) plan.judge = judge;
  return plan;
}

export function describePlan(plan: ComparisonPlan): string[] {
  const models = [plan.baseline, ...plan.candidates].map((m) => clean(m)).join(", ");
  const capped = plan.maxUsd < plan.budgetUsd ? "" : ` (stopped there by your limit)`;
  return [
    `Models: ${models}`,
    `Cases: ${plan.cases.length}, ${plan.runs} runs each`,
    `Maximum cost: ${usd(plan.maxUsd)}${capped}, up to ${plan.maxCalls} calls`,
    `Vendors that will see your case content: ${plan.vendors.map((v) => clean(v)).join(", ")}`,
  ];
}

export async function runPlan(project: Project, plan: ComparisonPlan, onProgress?: (message: string) => void): Promise<{ report: SwapReport; reportPath: string }> {
  const report = await runComparison({
    baseline: plan.baseline,
    candidates: plan.candidates,
    cases: plan.cases,
    runs: plan.runs,
    budgetUsd: plan.budgetUsd,
    snapshot: project.registry.snapshot,
    registryGeneratedAt: project.registry.snapshot.generated_at,
    providerFor: plan.providerFor,
    routeFor: plan.routeFor,
    judge: plan.judge,
    includeText: project.config.include_text_in_reports,
    onProgress,
    policy: project.config.policy,
    allowUnknownPrices: plan.allowUnknownPrices,
  });
  const reportPath = await saveReport(project.root, report);
  return { report, reportPath };
}
