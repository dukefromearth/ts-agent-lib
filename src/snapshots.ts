import {
  ExecutionStateSchema,
  type ErrorInfo,
  type ExecutionState,
  type ExecutionStatus,
  type StepResult,
  type StepStatus
} from "./types";

export type StepResultSnapshot = {
  stepId: string;
  status: StepStatus;
  output?: unknown;
  error?: ErrorInfo;
  blockedReason?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ExecutionStateSnapshot = {
  executionId: string;
  status: ExecutionStatus;
  steps: Record<string, StepResultSnapshot>;
  startedAt?: string;
  finishedAt?: string;
};

export function serializeExecutionState(state: ExecutionState): ExecutionStateSnapshot {
  const steps: Record<string, StepResultSnapshot> = Object.create(null);
  for (const [stepId, res] of state.steps.entries()) {
    steps[stepId] = serializeStepResult(res);
  }

  return {
    executionId: state.executionId,
    status: state.status,
    steps,
    startedAt: state.startedAt ? state.startedAt.toISOString() : undefined,
    finishedAt: state.finishedAt ? state.finishedAt.toISOString() : undefined
  };
}

export function deserializeExecutionState(snapshot: ExecutionStateSnapshot): ExecutionState {
  return ExecutionStateSchema.parse(snapshot);
}

function serializeStepResult(res: StepResult): StepResultSnapshot {
  return {
    stepId: res.stepId,
    status: res.status,
    output: res.output,
    error: res.error ? { ...res.error } : undefined,
    blockedReason: res.blockedReason,
    startedAt: res.startedAt ? res.startedAt.toISOString() : undefined,
    finishedAt: res.finishedAt ? res.finishedAt.toISOString() : undefined
  };
}
