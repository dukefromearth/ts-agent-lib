import { Plan, Step, StepSchema } from "./types";

export class PlanBuilder {
  private readonly steps = new Map<string, Step>();

  addStep(params: {
    id: string;
    action: string;
    deps?: Iterable<string>;
    payload?: unknown;
  }): this {
    const { id, action, deps, payload } = params;
    if (this.steps.has(id)) {
      throw new Error(`step id '${id}' already exists in plan`);
    }

    const depsList = deps ? Array.from(deps) : [];
    const step: Step = {
      id,
      action,
      deps: depsList,
      payload
    };

    this.steps.set(id, step);
    return this;
  }

  addStepObj(step: Step): this {
    StepSchema.parse(step);
    if (this.steps.has(step.id)) {
      throw new Error(`step id '${step.id}' already exists in plan`);
    }
    this.steps.set(step.id, step);
    return this;
  }

  build(): Plan {
    const stepsCopy = new Map(this.steps);
    this.validateDependencies(stepsCopy);
    this.validateAcyclic(stepsCopy);
    return new Plan(stepsCopy);
  }

  private validateDependencies(steps: Map<string, Step>): void {
    const ids = new Set(steps.keys());
    for (const step of steps.values()) {
      for (const dep of step.deps) {
        if (!ids.has(dep)) {
          throw new Error(`step '${step.id}' depends on unknown step '${dep}'`);
        }
        if (dep === step.id) {
          throw new Error(`step '${step.id}' cannot depend on itself`);
        }
      }
    }
  }

  private validateAcyclic(steps: Map<string, Step>): void {
    const cycle = findCycle(steps);
    if (cycle) {
      throw new Error(`cycle detected in plan: ${cycle.join(" -> ")}`);
    }
  }
}

function findCycle(steps: Map<string, Step>): string[] | null {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const current = state.get(node);
    if (current === "visiting") {
      const idx = stack.indexOf(node);
      return idx >= 0 ? stack.slice(idx).concat(node) : [node, node];
    }
    if (current === "visited") {
      return null;
    }

    state.set(node, "visiting");
    stack.push(node);
    const step = steps.get(node);
    if (step) {
      for (const dep of step.deps) {
        const cycle = visit(dep);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    state.set(node, "visited");
    return null;
  };

  for (const id of steps.keys()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}
