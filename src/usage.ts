import { ExecutionState, StepResult } from "./types";

export type NumberLike = number;

export class Usage {
  readonly provider?: string;
  readonly model?: string;
  readonly metrics: Record<string, NumberLike>;

  constructor(params: { provider?: string; model?: string; metrics?: Record<string, NumberLike> } = {}) {
    this.provider = params.provider;
    this.model = params.model;
    this.metrics = { ...(params.metrics ?? {}) };
  }

  add(other: Usage): Usage {
    const provider = this.provider === other.provider ? this.provider : undefined;
    const model = this.model === other.model ? this.model : undefined;
    const merged: Record<string, NumberLike> = { ...this.metrics };
    for (const [key, value] of Object.entries(other.metrics)) {
      merged[key] = (merged[key] ?? 0) + Number(value);
    }
    return new Usage({ provider, model, metrics: merged });
  }
}

export function aggregateUsage(
  state: ExecutionState,
  extract: (result: StepResult) => Usage | undefined
): Usage {
  let total = new Usage();
  let first = true;

  for (const res of state.steps.values()) {
    const usage = extract(res);
    if (!usage) {
      continue;
    }
    if (first) {
      total = usage;
      first = false;
    } else {
      total = total.add(usage);
    }
  }

  return total;
}

export interface PricingRule {
  metric: string;
  perUnit: number;
  scale?: number;
}

export interface CostBreakdown {
  byMetric: Record<string, number>;
  total: number;
}

export function estimateCost(usage: Usage, rules: PricingRule[]): CostBreakdown {
  const costs: Record<string, number> = {};

  for (const rule of rules) {
    const value = Number(usage.metrics[rule.metric] ?? 0);
    if (!value) {
      continue;
    }
    const scale = rule.scale ?? 1;
    const cost = (value / scale) * rule.perUnit;
    costs[rule.metric] = (costs[rule.metric] ?? 0) + cost;
  }

  const total = Object.values(costs).reduce((sum, value) => sum + value, 0);
  return { byMetric: costs, total };
}
