import { describe, expect, it } from "vitest";
import { Plan, StepSchema } from "../src/index";

describe("zod validation", () => {
  it("applies defaults for deps", () => {
    const step = StepSchema.parse({ id: "a", action: "act" });
    expect(step.deps).toEqual([]);
  });

  it("rejects invalid step input", () => {
    expect(() => StepSchema.parse({ id: 123, action: "act" })).toThrow();
  });

  it("validates plan steps", () => {
    const plan = new Plan({
      a: { id: "a", action: "act", deps: [] }
    });
    expect(plan.getStep("a").id).toBe("a");
    expect(() => new Plan({ a: { id: 123, action: "act" } } as unknown as any)).toThrow();
  });

  it("rejects plans with unknown dependencies", () => {
    expect(() =>
      new Plan({
        a: { id: "a", action: "act", deps: ["missing"] }
      })
    ).toThrow("step 'a' depends on unknown step 'missing'");
  });

  it("rejects plans with self dependencies", () => {
    expect(() =>
      new Plan({
        a: { id: "a", action: "act", deps: ["a"] }
      })
    ).toThrow("step 'a' cannot depend on itself");
  });

  it("rejects plans with cycles", () => {
    expect(() =>
      new Plan({
        a: { id: "a", action: "act", deps: ["b"] },
        b: { id: "b", action: "act", deps: ["a"] }
      })
    ).toThrow("cycle detected in plan");
  });
});
