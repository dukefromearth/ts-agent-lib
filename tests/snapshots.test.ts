import { describe, expect, it } from "vitest";
import {
  ExecutionStatus,
  StepStatus,
  deserializeExecutionState,
  serializeExecutionState,
  type ExecutionState
} from "../src/index";

describe("execution snapshots", () => {
  it("serializes and deserializes execution state", () => {
    const startedAt = new Date("2024-01-01T00:00:00.000Z");
    const finishedAt = new Date("2024-01-01T00:00:05.000Z");

    const state: ExecutionState = {
      executionId: "exec-1",
      status: ExecutionStatus.COMPLETED,
      startedAt,
      finishedAt,
      steps: new Map([
        [
          "a",
          {
            stepId: "a",
            status: StepStatus.COMPLETED,
            output: { ok: true },
            startedAt,
            finishedAt
          }
        ]
      ])
    };

    const snapshot = serializeExecutionState(state);

    expect(snapshot.steps).not.toBeInstanceOf(Map);
    expect(snapshot.startedAt).toBe("2024-01-01T00:00:00.000Z");

    const restored = deserializeExecutionState(snapshot);
    expect(restored.steps).toBeInstanceOf(Map);
    expect(restored.startedAt).toBeInstanceOf(Date);
    expect(restored.steps.get("a")?.status).toBe(StepStatus.COMPLETED);
  });

  it("preserves prototype-like step ids", () => {
    const state: ExecutionState = {
      executionId: "exec-2",
      status: ExecutionStatus.FAILED,
      steps: new Map([
        ["__proto__", { stepId: "__proto__", status: StepStatus.COMPLETED }],
        ["constructor", { stepId: "constructor", status: StepStatus.FAILED }]
      ])
    };

    const snapshot = serializeExecutionState(state);

    expect(Object.prototype.hasOwnProperty.call(snapshot.steps, "__proto__")).toBe(true);
    expect(snapshot.steps["__proto__"]?.status).toBe(StepStatus.COMPLETED);

    const restored = deserializeExecutionState(snapshot);
    expect(restored.steps.get("__proto__")?.status).toBe(StepStatus.COMPLETED);
    expect(restored.steps.get("constructor")?.status).toBe(StepStatus.FAILED);
  });
});
