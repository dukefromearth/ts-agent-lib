import { raiseIfFailed } from "./errors";
import { DagExecutor, type StepHandler } from "./executor";
import type { ExecutionState, Plan, StepResult } from "./types";
import { CostBreakdown, PricingRule, Usage, aggregateUsage, estimateCost } from "./usage";

export class TaskOutput<T> {
  readonly value: T;
  readonly usage?: Usage;
  readonly meta: Record<string, unknown>;

  constructor(params: { value: T; usage?: Usage; meta?: Record<string, unknown> }) {
    this.value = params.value;
    this.usage = params.usage;
    this.meta = params.meta ?? {};
  }
}

export function defaultUsageExtractor(res: StepResult): Usage | undefined {
  const out = res.output;
  if (out instanceof TaskOutput) {
    return out.usage;
  }
  return undefined;
}

export async function runPlan(
  plan: Plan,
  handlers: Record<string, StepHandler>,
  options: {
    failOnError?: boolean;
    usageExtractor?: ((res: StepResult) => Usage | undefined) | null;
    pricingRules?: PricingRule[];
    executor?: DagExecutor;
  } = {}
): Promise<[ExecutionState, Usage | undefined, CostBreakdown | undefined]> {
  const execImpl = options.executor ?? new DagExecutor();
  const state = await execImpl.executeAsync(plan, handlers);

  if (options.failOnError ?? true) {
    raiseIfFailed(state);
  }

  let usage: Usage | undefined;
  let costs: CostBreakdown | undefined;

  const extractor = options.usageExtractor === undefined ? defaultUsageExtractor : options.usageExtractor;
  if (extractor) {
    const aggregated = aggregateUsage(state, extractor);
    if (!aggregated.provider && !aggregated.model && Object.keys(aggregated.metrics).length === 0) {
      usage = undefined;
    } else {
      usage = aggregated;
    }
  }

  if (usage && options.pricingRules && options.pricingRules.length > 0) {
    costs = estimateCost(usage, options.pricingRules);
  }

  return [state, usage, costs];
}
