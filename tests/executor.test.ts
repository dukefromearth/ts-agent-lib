import { describe, expect, it } from "vitest";
import {
  DagExecutor,
  ExecutionStatus,
  PlanBuilder,
  StepStatus,
  type StepHandler
} from "../src/index";

describe("DagExecutor", () => {
  it("executes a linear plan", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "one" });
    builder.addStep({ id: "b", action: "two", deps: ["a"] });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      one: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED }),
      two: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor({ maxParallelSteps: 2 });
    const state = await executor.executeAsync(plan, handlers);

    expect(state.status).toBe(ExecutionStatus.COMPLETED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.COMPLETED);
    expect(state.steps.get("b")?.status).toBe(StepStatus.COMPLETED);
  });

  it("respects failFast and blocks pending steps", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "fail" });
    builder.addStep({ id: "b", action: "ok" });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      fail: async (step) => ({
        stepId: step.id,
        status: StepStatus.FAILED,
        error: { message: "boom", type: "Error" }
      }),
      ok: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor({ maxParallelSteps: 1, failFast: true });
    const state = await executor.executeAsync(plan, handlers);

    expect(state.status).toBe(ExecutionStatus.FAILED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.FAILED);
    expect(state.steps.get("b")?.status).toBe(StepStatus.BLOCKED);
  });

  it("cancels pending steps when aborted", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "noop" });
    builder.addStep({ id: "b", action: "noop", deps: ["a"] });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      noop: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const controller = new AbortController();
    controller.abort();

    const executor = new DagExecutor();
    const state = await executor.executeAsync(plan, handlers, {
      cancelSignal: controller.signal
    });

    expect(state.status).toBe(ExecutionStatus.CANCELLED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.CANCELLED);
    expect(state.steps.get("b")?.status).toBe(StepStatus.CANCELLED);
  });

  it("streams events", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "one" });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      one: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor();
    const events: string[] = [];

    for await (const event of executor.streamExecute(plan, handlers)) {
      events.push(event.type);
    }

    expect(events).toContain("execution_started");
    expect(events).toContain("execution_completed");
    expect(events).toContain("step_completed");
  });
});
