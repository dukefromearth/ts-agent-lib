import { ErrorInfo, ExecutionState, ExecutionStatus, StepStatus } from "./types";

export class ExecutionError extends Error {
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly errors: ErrorInfo[];

  constructor(params: { executionId: string; status: ExecutionStatus; errors: ErrorInfo[] }) {
    const { executionId, status, errors } = params;
    const prefix = `Execution ${executionId} ended with status ${status}`;
    const detail = errors.length > 0 ? `${errors[0].type ?? "Error"}: ${errors[0].message}` : "";
    super(detail ? `${prefix}: ${detail}` : prefix);
    this.executionId = executionId;
    this.status = status;
    this.errors = errors;
  }

  static fromState(state: ExecutionState): ExecutionError {
    const errors: ErrorInfo[] = [];
    for (const result of state.steps.values()) {
      if (result.error) {
        errors.push(result.error);
      } else if (result.status === StepStatus.BLOCKED || result.status === StepStatus.CANCELLED) {
        const detail =
          result.status === StepStatus.BLOCKED && result.blockedReason
            ? ` (${result.blockedReason})`
            : "";
        errors.push({
          message: `step ${result.stepId} ended with status ${result.status}${detail}`,
          type: "ExecutionStatus"
        });
      }
    }
    if (errors.length === 0) {
      errors.push({ message: "execution failed without detailed errors", type: "ExecutionError" });
    }
    return new ExecutionError({
      executionId: state.executionId,
      status: state.status,
      errors
    });
  }
}

export function raiseIfFailed(state: ExecutionState): void {
  if (state.status !== ExecutionStatus.COMPLETED) {
    throw ExecutionError.fromState(state);
  }
}
