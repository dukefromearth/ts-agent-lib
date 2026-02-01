import { z } from "zod";

const stepStatusValues = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;

export const StepStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
  CANCELLED: "cancelled"
} as const;

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export const StepStatusSchema = z.enum(stepStatusValues);

const executionStatusValues = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export const ExecutionStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;

export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

export const ExecutionStatusSchema = z.enum(executionStatusValues);

const depsSchema = z.array(z.string()).optional().transform((val) => val ?? []);

export const StepSchema = z.object({
  id: z.string(),
  action: z.string(),
  deps: depsSchema,
  payload: z.unknown().optional()
});

export type Step = z.infer<typeof StepSchema>;

export function utcNow(): Date {
  return new Date();
}

export const ErrorInfoSchema = z.object({
  message: z.string(),
  type: z.string().optional(),
  traceback: z.string().optional()
});

export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  status: StepStatusSchema.default(StepStatus.PENDING),
  output: z.unknown().optional(),
  error: ErrorInfoSchema.optional(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional()
});

export type StepResult = z.infer<typeof StepResultSchema>;

const stepResultMapSchema = z.preprocess(
  (val) => {
    if (val instanceof Map) {
      return val;
    }
    if (val && typeof val === "object") {
      return new Map(Object.entries(val as Record<string, unknown>));
    }
    return val;
  },
  z.map(z.string(), StepResultSchema)
);

export const ExecutionStateSchema = z.object({
  executionId: z.string(),
  status: ExecutionStatusSchema.default(ExecutionStatus.PENDING),
  steps: stepResultMapSchema,
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional()
});

export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const ExecutionEventSchema = z.object({
  executionId: z.string(),
  ts: z.coerce.date(),
  type: z.string()
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

export const ExecutionStartedSchema = ExecutionEventSchema.extend({
  type: z.literal("execution_started"),
  startedAt: z.coerce.date()
});

export type ExecutionStarted = z.infer<typeof ExecutionStartedSchema>;

export const ExecutionCompletedSchema = ExecutionEventSchema.extend({
  type: z.literal("execution_completed"),
  status: ExecutionStatusSchema,
  finishedAt: z.coerce.date()
});

export type ExecutionCompleted = z.infer<typeof ExecutionCompletedSchema>;

export const ExecutionCancelledSchema = ExecutionEventSchema.extend({
  type: z.literal("execution_cancelled"),
  finishedAt: z.coerce.date()
});

export type ExecutionCancelled = z.infer<typeof ExecutionCancelledSchema>;

export const StepScheduledSchema = ExecutionEventSchema.extend({
  type: z.literal("step_scheduled"),
  stepId: z.string()
});

export type StepScheduled = z.infer<typeof StepScheduledSchema>;

export const StepStartedSchema = ExecutionEventSchema.extend({
  type: z.literal("step_started"),
  stepId: z.string()
});

export type StepStarted = z.infer<typeof StepStartedSchema>;

export const StepCompletedSchema = ExecutionEventSchema.extend({
  type: z.literal("step_completed"),
  stepId: z.string()
});

export type StepCompleted = z.infer<typeof StepCompletedSchema>;

export const StepFailedSchema = ExecutionEventSchema.extend({
  type: z.literal("step_failed"),
  stepId: z.string(),
  error: ErrorInfoSchema
});

export type StepFailed = z.infer<typeof StepFailedSchema>;

export const StepBlockedSchema = ExecutionEventSchema.extend({
  type: z.literal("step_blocked"),
  stepId: z.string()
});

export type StepBlocked = z.infer<typeof StepBlockedSchema>;

export const StepCancelledSchema = ExecutionEventSchema.extend({
  type: z.literal("step_cancelled"),
  stepId: z.string()
});

export type StepCancelled = z.infer<typeof StepCancelledSchema>;

export const ExecutionEventTypeSchema = z.union([
  ExecutionStartedSchema,
  ExecutionCompletedSchema,
  ExecutionCancelledSchema,
  StepScheduledSchema,
  StepStartedSchema,
  StepCompletedSchema,
  StepFailedSchema,
  StepBlockedSchema,
  StepCancelledSchema
]);

export type ExecutionEventType = z.infer<typeof ExecutionEventTypeSchema>;

const stepMapSchema = z.preprocess(
  (val) => {
    if (val instanceof Map) {
      return val;
    }
    if (val && typeof val === "object") {
      return new Map(Object.entries(val as Record<string, unknown>));
    }
    return val;
  },
  z.map(z.string(), StepSchema)
);

export type StepsInput = Map<string, Step> | Record<string, Step>;

export const PlanSchema = z.object({
  steps: stepMapSchema
});

export type PlanInput = z.infer<typeof PlanSchema>;

export class Plan implements Iterable<Step> {
  private readonly _steps: ReadonlyMap<string, Step>;

  constructor(steps: StepsInput) {
    const parsedSteps = stepMapSchema.parse(steps);
    const normalized = new Map<string, Step>();
    for (const [key, step] of parsedSteps.entries()) {
      if (key !== step.id) {
        throw new Error(`step key '${key}' does not match step.id '${step.id}'`);
      }
      normalized.set(step.id, freezeStep(step));
    }
    this._steps = normalized;
  }

  [Symbol.iterator](): Iterator<Step> {
    return this._steps.values();
  }

  get steps(): ReadonlyMap<string, Step> {
    return this._steps;
  }

  getStep(stepId: string): Step {
    const step = this._steps.get(stepId);
    if (!step) {
      throw new Error(`unknown step '${stepId}'`);
    }
    return step;
  }
}

function freezeStep(step: Step): Step {
  const deps = Array.isArray(step.deps) ? [...step.deps] : [];
  Object.freeze(deps);
  const frozen: Step = {
    id: step.id,
    action: step.action,
    deps,
    payload: step.payload
  };
  return Object.freeze(frozen);
}
