import { describe, expect, it } from "vitest";
import { DagExecutor, PlanBuilder, StepStatus, withRetry, withTimeout } from "../src/index";

describe("policy helpers", () => {
  it("retries failed handlers", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "work" });
    const plan = builder.build();

    let attempts = 0;
    const handlers = {
      work: withRetry(
        async (step) => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("boom");
          }
          return { stepId: step.id, status: StepStatus.COMPLETED };
        },
        { retries: 2, delayMs: 1 }
      )
    };

    const state = await new DagExecutor().executeAsync(plan, handlers);

    expect(attempts).toBe(3);
    expect(state.status).toBe("completed");
    expect(state.steps.get("a")?.status).toBe(StepStatus.COMPLETED);
  });

  it("fails steps on timeout", async () => {
    const builder = new PlanBuilder();
    builder.addStep({ id: "a", action: "work" });
    const plan = builder.build();

    const handlers = {
      work: withTimeout(async (step) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { stepId: step.id, status: StepStatus.COMPLETED };
      }, 5)
    };

    const state = await new DagExecutor().executeAsync(plan, handlers);

    expect(state.status).toBe("failed");
    expect(state.steps.get("a")?.status).toBe(StepStatus.FAILED);
    expect(state.steps.get("a")?.error?.type).toBe("Timeout");
  });
});
