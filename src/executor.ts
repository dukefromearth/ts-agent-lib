import { randomUUID } from "crypto";
import { AsyncQueue } from "./internal/async_queue";
import {
  ExecutionStatus,
  StepResultSchema,
  StepStatus,
  utcNow
} from "./types";
import type {
  ErrorInfo,
  ExecutionCancelled,
  ExecutionCompleted,
  ExecutionEventType,
  ExecutionStarted,
  ExecutionState,
  Plan,
  Step,
  StepBlocked,
  StepCancelled,
  StepCompleted,
  StepFailed,
  StepResult,
  StepScheduled,
  StepStarted
} from "./types";

export type StepHandler = (step: Step, ctx: StepContext) => Promise<StepResult>;
export type EventHandler = (event: ExecutionEventType) => void | Promise<void>;

export interface ExecuteOptions {
  onEvent?: EventHandler;
  cancelSignal?: AbortSignal;
  executionId?: string;
}

export class StepContext {
  private readonly _executionId: string;
  private readonly _stepId: string;
  private readonly _signal?: AbortSignal;

  constructor(params: { executionId: string; stepId: string; signal?: AbortSignal }) {
    this._executionId = params.executionId;
    this._stepId = params.stepId;
    this._signal = params.signal;
  }

  get executionId(): string {
    return this._executionId;
  }

  get stepId(): string {
    return this._stepId;
  }

  get signal(): AbortSignal | undefined {
    return this._signal;
  }

  isCancelled(): boolean {
    return this._signal?.aborted ?? false;
  }
}

type SchedulerState = {
  running: Map<Promise<void>, string>;
  failFast: boolean;
  stopScheduling: boolean;
};

export class DagExecutor {
  private readonly maxParallelSteps: number;
  private readonly failFast: boolean;

  constructor(params: { maxParallelSteps?: number; failFast?: boolean } = {}) {
    const { maxParallelSteps = 8, failFast = false } = params;
    if (maxParallelSteps <= 0) {
      throw new Error("maxParallelSteps must be > 0");
    }
    this.maxParallelSteps = maxParallelSteps;
    this.failFast = failFast;
  }

  async executeAsync(
    plan: Plan,
    handlers: Record<string, StepHandler>,
    options: ExecuteOptions = {}
  ): Promise<ExecutionState> {
    const execId = options.executionId ?? randomUUID();
    const state: ExecutionState = {
      executionId: execId,
      status: ExecutionStatus.RUNNING,
      steps: new Map(),
      startedAt: utcNow()
    };

    const allSteps = new Map<string, Step>();
    for (const step of plan) {
      allSteps.set(step.id, step);
      state.steps.set(step.id, {
        stepId: step.id,
        status: StepStatus.PENDING
      });
    }

    const emit = async (event: ExecutionEventType): Promise<void> => {
      if (options.onEvent) {
        await options.onEvent(event);
      }
    };

    await emit({
      type: "execution_started",
      executionId: execId,
      ts: state.startedAt ?? utcNow(),
      startedAt: state.startedAt ?? utcNow()
    } satisfies ExecutionStarted);

    const ready: string[] = [];
    const readySet = new Set<string>();
    const schedState: SchedulerState = {
      running: new Map(),
      failFast: this.failFast,
      stopScheduling: false
    };

    const isCancelled = (): boolean => options.cancelSignal?.aborted ?? false;

    const canRun = (step: Step): boolean => {
      const res = state.steps.get(step.id);
      if (!res || res.status !== StepStatus.PENDING) {
        return false;
      }
      for (const depId of step.deps) {
        const depRes = state.steps.get(depId);
        if (!depRes) {
          throw new Error(`unknown dependency '${depId}' for step '${step.id}'`);
        }
        if (depRes.status !== StepStatus.COMPLETED) {
          return false;
        }
      }
      return true;
    };

    const refreshReady = (): void => {
      for (const step of allSteps.values()) {
        if (readySet.has(step.id)) {
          continue;
        }
        if (canRun(step)) {
          ready.push(step.id);
          readySet.add(step.id);
        }
      }
    };

    const cancelStep = async (stepId: string, res: StepResult): Promise<void> => {
      res.status = StepStatus.CANCELLED;
      if (!res.finishedAt) {
        res.finishedAt = utcNow();
      }
      await emit({
        type: "step_cancelled",
        executionId: execId,
        ts: utcNow(),
        stepId
      } satisfies StepCancelled);
    };

    const failStep = async (stepId: string, res: StepResult, err: ErrorInfo): Promise<void> => {
      res.status = StepStatus.FAILED;
      res.error = err;
      if (!res.finishedAt) {
        res.finishedAt = utcNow();
      }
      await emit({
        type: "step_failed",
        executionId: execId,
        ts: utcNow(),
        stepId,
        error: err
      } satisfies StepFailed);
      if (schedState.failFast) {
        schedState.stopScheduling = true;
      }
    };

    const blockStep = async (stepId: string, res: StepResult): Promise<void> => {
      res.status = StepStatus.BLOCKED;
      if (!res.finishedAt) {
        res.finishedAt = utcNow();
      }
      await emit({
        type: "step_blocked",
        executionId: execId,
        ts: utcNow(),
        stepId
      } satisfies StepBlocked);
    };

    const runStep = async (stepId: string): Promise<void> => {
      const step = allSteps.get(stepId)!;
      const res = state.steps.get(stepId)!;

      if (isCancelled()) {
        await cancelStep(stepId, res);
        return;
      }

      res.status = StepStatus.RUNNING;
      res.startedAt = utcNow();
      await emit({
        type: "step_started",
        executionId: execId,
        ts: utcNow(),
        stepId
      } satisfies StepStarted);

      const handler = handlers[step.action];
      if (!handler) {
        await failStep(stepId, res, {
          message: `no handler for action '${step.action}'`,
          type: "MissingHandler"
        });
        return;
      }

      const ctx = new StepContext({
        executionId: execId,
        stepId,
        signal: options.cancelSignal
      });

      let result: StepResult;
      try {
        result = StepResultSchema.parse(await handler(step, ctx));
      } catch (err) {
        if (isAbortError(err)) {
          await cancelStep(stepId, res);
          return;
        }
        const errorInfo: ErrorInfo = {
          message: err instanceof Error ? err.message : String(err),
          type: err instanceof Error ? err.name : "Error",
          traceback: err instanceof Error ? err.stack : undefined
        };
        await failStep(stepId, res, errorInfo);
        return;
      }

      let status = result.status;
      if (status === StepStatus.PENDING || status === StepStatus.RUNNING) {
        status = result.error ? StepStatus.FAILED : StepStatus.COMPLETED;
      } else if (status === StepStatus.COMPLETED && result.error) {
        status = StepStatus.FAILED;
      }

      res.status = status;
      res.output = result.output;
      res.error = result.error;
      res.startedAt = res.startedAt ?? result.startedAt ?? utcNow();
      res.finishedAt = result.finishedAt ?? utcNow();

      if (res.status === StepStatus.COMPLETED) {
        await emit({
          type: "step_completed",
          executionId: execId,
          ts: utcNow(),
          stepId
        } satisfies StepCompleted);
      } else if (res.status === StepStatus.FAILED) {
        await failStep(
          stepId,
          res,
          res.error ?? { message: "step failed", type: "Unknown" }
        );
      } else if (res.status === StepStatus.CANCELLED) {
        await cancelStep(stepId, res);
      } else if (res.status === StepStatus.BLOCKED) {
        await blockStep(stepId, res);
      }
    };

    refreshReady();

    while (true) {
      if (isCancelled()) {
        schedState.stopScheduling = true;
      }

      while (!schedState.stopScheduling && schedState.running.size < this.maxParallelSteps) {
        if (ready.length === 0) {
          break;
        }
        const stepId = ready.shift()!;
        readySet.delete(stepId);
        const stepRes = state.steps.get(stepId);
        if (!stepRes || stepRes.status !== StepStatus.PENDING) {
          continue;
        }
        await emit({
          type: "step_scheduled",
          executionId: execId,
          ts: utcNow(),
          stepId
        } satisfies StepScheduled);

        const task = runStep(stepId);
        schedState.running.set(task, stepId);
      }

      if (schedState.running.size === 0) {
        if (schedState.stopScheduling || ready.length === 0) {
          break;
        }
      }

      if (schedState.running.size > 0) {
        try {
          const { task: finished } = await waitForAny(schedState.running.keys());
          schedState.running.delete(finished);
        } catch (err) {
          if (isTaskError(err)) {
            schedState.running.delete(err.task);
            throw err.error;
          }
          throw err;
        }
      }

      refreshReady();
    }

    if (isCancelled()) {
      for (const [stepId, res] of state.steps.entries()) {
        if (res.status === StepStatus.PENDING) {
          await cancelStep(stepId, res);
        }
      }
      state.status = ExecutionStatus.CANCELLED;
      state.finishedAt = utcNow();
      await emit({
        type: "execution_cancelled",
        executionId: execId,
        ts: utcNow(),
        finishedAt: state.finishedAt
      } satisfies ExecutionCancelled);
      return state;
    }

    for (const [stepId, res] of state.steps.entries()) {
      if (res.status === StepStatus.PENDING) {
        await blockStep(stepId, res);
      }
    }

    const allCompleted = Array.from(state.steps.values()).every(
      (res) => res.status === StepStatus.COMPLETED
    );
    state.status = allCompleted ? ExecutionStatus.COMPLETED : ExecutionStatus.FAILED;
    state.finishedAt = utcNow();

    await emit({
      type: "execution_completed",
      executionId: execId,
      ts: utcNow(),
      status: state.status,
      finishedAt: state.finishedAt
    } satisfies ExecutionCompleted);

    return state;
  }

  execute(
    plan: Plan,
    handlers: Record<string, StepHandler>,
    options: ExecuteOptions = {}
  ): Promise<ExecutionState> {
    return this.executeAsync(plan, handlers, options);
  }

  async *streamExecute(
    plan: Plan,
    handlers: Record<string, StepHandler>,
    options: ExecuteOptions = {}
  ): AsyncIterable<ExecutionEventType> {
    const queue = new AsyncQueue<ExecutionEventType | null>(Infinity);
    const controller = new AbortController();
    const signal = mergeAbortSignals(options.cancelSignal, controller.signal);
    let execError: unknown;

    const task = this.executeAsync(plan, handlers, {
      ...options,
      cancelSignal: signal,
      onEvent: async (event) => {
        await queue.put(event);
      }
    })
      .catch((err) => {
        execError = err;
      })
      .finally(async () => {
        await queue.put(null);
      });

    try {
      while (true) {
        const event = await queue.get();
        if (event === null) {
          break;
        }
        yield event;
      }
    } finally {
      controller.abort();
      await task;
      if (execError) {
        throw execError;
      }
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: string }).name) : "";
  return name === "AbortError";
}

type TaskError = { task: Promise<void>; error: unknown };

function isTaskError(err: unknown): err is TaskError {
  return (
    typeof err === "object" &&
    err !== null &&
    "task" in err &&
    "error" in err
  );
}

async function waitForAny(tasks: Iterable<Promise<void>>): Promise<{ task: Promise<void> }> {
  const list = Array.from(tasks);
  if (list.length === 0) {
    throw new Error("waitForAny called with no tasks");
  }
  return Promise.race(
    list.map((task) =>
      task.then(
        () => ({ task }),
        (error) => {
          const taskError: TaskError = { task, error };
          throw taskError;
        }
      )
    )
  );
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter(Boolean) as AbortSignal[];
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}
