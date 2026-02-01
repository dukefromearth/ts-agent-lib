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
});
