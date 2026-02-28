import { describe, expect, it, vi } from "vitest";
import {
  BlockedReason,
  DagExecutor,
  deserializeExecutionState,
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

  it("exposes dependency outputs safely", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "produce" });
    builder.addStep({ id: "b", action: "consume", deps: ["a"] });
    const plan = builder.build();

    let seenOutputs: Record<string, number> | undefined;

    const handlers: Record<string, StepHandler> = {
      produce: async (step) => ({
        stepId: step.id,
        status: StepStatus.COMPLETED,
        output: 123
      }),
      consume: async (step, ctx) => {
        const outputs = ctx.getDependencyOutputs<number>();
        seenOutputs = outputs;
        const depResults = ctx.getDependencyResults();
        if (depResults.a) {
          depResults.a.status = StepStatus.FAILED;
        }
        const dep = ctx.requireResult("a");
        return {
          stepId: step.id,
          status: StepStatus.COMPLETED,
          output: (dep.output as number) + 1
        };
      }
    };

    const executor = new DagExecutor({ maxParallelSteps: 1 });
    const state = await executor.executeAsync(plan, handlers);

    expect(seenOutputs).toEqual({ a: 123 });
    expect(state.status).toBe(ExecutionStatus.COMPLETED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.COMPLETED);
    expect(state.steps.get("b")?.output).toBe(124);
  });

  it("blocks dependents when a dependency fails", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "fail" });
    builder.addStep({ id: "b", action: "consume", deps: ["a"] });
    const plan = builder.build();

    const consume = vi.fn(async (step) => ({
      stepId: step.id,
      status: StepStatus.COMPLETED
    }));

    const handlers: Record<string, StepHandler> = {
      fail: async (step) => ({
        stepId: step.id,
        status: StepStatus.FAILED
      }),
      consume
    };

    const executor = new DagExecutor({ maxParallelSteps: 1 });
    const state = await executor.executeAsync(plan, handlers);

    expect(consume).not.toHaveBeenCalled();
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

  it("calls user onEvent during stream execution", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "one" });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      one: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor();
    const callbackEvents: string[] = [];
    const streamEvents: string[] = [];

    for await (const event of executor.streamExecute(plan, handlers, {
      onEvent: (event) => {
        callbackEvents.push(event.type);
      }
    })) {
      streamEvents.push(event.type);
    }

    expect(callbackEvents.length).toBeGreaterThan(0);
    expect(callbackEvents).toEqual(streamEvents);
  });

  it("exposes blocked reasons for dependency failures", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "fail" });
    builder.addStep({ id: "b", action: "noop", deps: ["a"] });
    const plan = builder.build();

    let blockedReason: string | undefined;

    const handlers: Record<string, StepHandler> = {
      fail: async (step) => ({
        stepId: step.id,
        status: StepStatus.FAILED,
        error: { message: "boom", type: "Error" }
      }),
      noop: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor();
    const state = await executor.executeAsync(plan, handlers, {
      onEvent: (event) => {
        if (event.type === "step_blocked") {
          blockedReason = event.blockedReason;
        }
      }
    });

    expect(state.steps.get("b")?.status).toBe(StepStatus.BLOCKED);
    expect(state.steps.get("b")?.blockedReason).toBe(BlockedReason.DEPENDENCY_FAILED);
    expect(blockedReason).toBe(BlockedReason.DEPENDENCY_FAILED);
  });

  it("propagates blocked reasons for pending dependencies", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "noop", deps: ["b"] });
    builder.addStep({ id: "b", action: "noop", deps: ["c"] });
    builder.addStep({ id: "c", action: "fail" });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      fail: async (step) => ({
        stepId: step.id,
        status: StepStatus.FAILED,
        error: { message: "boom", type: "Error" }
      }),
      noop: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })
    };

    const executor = new DagExecutor();
    const state = await executor.executeAsync(plan, handlers);

    expect(state.steps.get("b")?.status).toBe(StepStatus.BLOCKED);
    expect(state.steps.get("b")?.blockedReason).toBe(BlockedReason.DEPENDENCY_FAILED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.BLOCKED);
    expect(state.steps.get("a")?.blockedReason).toBe(BlockedReason.DEPENDENCY_BLOCKED);
  });

  it("cancels running steps on failFast when configured", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "fail" });
    builder.addStep({ id: "b", action: "slow" });
    const plan = builder.build();

    const handlers: Record<string, StepHandler> = {
      fail: async (step) => ({
        stepId: step.id,
        status: StepStatus.FAILED,
        error: { message: "boom", type: "Error" }
      }),
      slow: async (step, ctx) => {
        for (let i = 0; i < 50; i++) {
          if (ctx.signal?.aborted) {
            return { stepId: step.id, status: StepStatus.CANCELLED };
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        return { stepId: step.id, status: StepStatus.COMPLETED };
      }
    };

    const executor = new DagExecutor({
      maxParallelSteps: 2,
      failFast: true,
      cancelRunningOnFailFast: true
    });
    const state = await executor.executeAsync(plan, handlers);

    expect(state.status).toBe(ExecutionStatus.FAILED);
    expect(state.steps.get("a")?.status).toBe(StepStatus.FAILED);
    expect(state.steps.get("b")?.status).toBe(StepStatus.CANCELLED);
  });

  it("resumes without rerunning completed steps", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "noop" });
    builder.addStep({ id: "b", action: "noop", deps: ["a"] });
    const plan = builder.build();

    const snapshot = deserializeExecutionState({
      executionId: "exec-1",
      status: "failed",
      steps: {
        a: { stepId: "a", status: "completed", output: 123 },
        b: { stepId: "b", status: "blocked" }
      }
    });

    const noop = vi.fn(async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED }));
    const handlers: Record<string, StepHandler> = { noop };

    const executor = new DagExecutor();
    const state = await executor.executeAsync(plan, handlers, { resumeFrom: snapshot });

    expect(noop).toHaveBeenCalledTimes(1);
    expect(state.steps.get("a")?.output).toBe(123);
    expect(state.steps.get("a")?.status).toBe(StepStatus.COMPLETED);
    expect(state.steps.get("b")?.status).toBe(StepStatus.COMPLETED);
  });

  it("errors on unknown step ids in snapshots", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "noop" });
    const plan = builder.build();

    const snapshot = deserializeExecutionState({
      executionId: "exec-1",
      status: "failed",
      steps: {
        a: { stepId: "a", status: "completed" },
        extra: { stepId: "extra", status: "completed" }
      }
    });

    const executor = new DagExecutor();

    await expect(
      executor.executeAsync(plan, { noop: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED }) }, {
        resumeFrom: snapshot
      })
    ).rejects.toThrow("snapshot includes unknown step 'extra'");
  });

  it("applies per-action concurrency limits", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a1", action: "alpha" });
    builder.addStep({ id: "a2", action: "alpha" });
    builder.addStep({ id: "b1", action: "beta" });
    const plan = builder.build();

    let runningAlpha = 0;
    let maxRunningAlpha = 0;

    const handlers: Record<string, StepHandler> = {
      alpha: async (step) => {
        runningAlpha += 1;
        maxRunningAlpha = Math.max(maxRunningAlpha, runningAlpha);
        await new Promise((resolve) => setTimeout(resolve, 10));
        runningAlpha -= 1;
        return { stepId: step.id, status: StepStatus.COMPLETED };
      },
      beta: async (step) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { stepId: step.id, status: StepStatus.COMPLETED };
      }
    };

    const executor = new DagExecutor({
      maxParallelSteps: 3,
      actionConcurrency: { alpha: 1 }
    });
    const state = await executor.executeAsync(plan, handlers);

    expect(state.status).toBe(ExecutionStatus.COMPLETED);
    expect(maxRunningAlpha).toBe(1);
  });
});
