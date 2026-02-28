import { randomUUID } from "crypto";
import { AsyncQueue } from "./internal/async_queue";
import {
  BlockedReason,
  ExecutionStatus,
  ExecutionStateSchema,
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
  resumeFrom?: ExecutionState;
}

export class StepContext {
  private readonly _executionId: string;
  private readonly _stepId: string;
  private readonly _signal?: AbortSignal;
  private readonly _plan: Plan;
  private readonly _getResult: (stepId: string) => StepResult | undefined;

  constructor(params: {
    executionId: string;
    stepId: string;
    signal?: AbortSignal;
    plan: Plan;
    getResult: (stepId: string) => StepResult | undefined;
  }) {
    this._executionId = params.executionId;
    this._stepId = params.stepId;
    this._signal = params.signal;
    this._plan = params.plan;
    this._getResult = params.getResult;
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

  getStep(stepId: string): Step {
    return this._plan.getStep(stepId);
  }

  getResult(stepId: string): Readonly<StepResult> | undefined {
    const res = this._getResult(stepId);
    return res ? cloneStepResult(res) : undefined;
  }

  requireResult(stepId: string): Readonly<StepResult> {
    const res = this.getResult(stepId);
    if (!res) {
      throw new Error(`missing result for step '${stepId}'`);
    }
    return res;
  }

  getDependencyResults(): Readonly<Record<string, StepResult>> {
    const step = this._plan.getStep(this._stepId);
    const deps: Record<string, StepResult> = {};
    for (const depId of step.deps) {
      const res = this._getResult(depId);
      if (res && res.status === StepStatus.COMPLETED) {
        deps[depId] = cloneStepResult(res);
      }
    }
    return deps;
  }

  getDependencyOutputs<T = unknown>(): Readonly<Record<string, T>> {
    const results = this.getDependencyResults();
    const outputs: Record<string, T> = {};
    for (const [depId, res] of Object.entries(results)) {
      outputs[depId] = res.output as T;
    }
    return outputs;
  }

  withSignal(signal?: AbortSignal): StepContext {
    return new StepContext({
      executionId: this._executionId,
      stepId: this._stepId,
      signal,
      plan: this._plan,
      getResult: this._getResult
    });
  }

  withMergedSignal(signal?: AbortSignal): StepContext {
    return this.withSignal(mergeAbortSignals(this._signal, signal));
  }
}

type SchedulerState = {
  running: Map<Promise<void>, { stepId: string; action: string }>;
  failFast: boolean;
  stopScheduling: boolean;
  failFastTriggered: boolean;
};

export class DagExecutor {
  private readonly maxParallelSteps: number;
  private readonly failFast: boolean;
  private readonly cancelRunningOnFailFast: boolean;
  private readonly actionConcurrency: Map<string, number>;

  constructor(
    params: {
      maxParallelSteps?: number;
      failFast?: boolean;
      cancelRunningOnFailFast?: boolean;
      actionConcurrency?: Record<string, number> | Map<string, number>;
    } = {}
  ) {
    const {
      maxParallelSteps = 8,
      failFast = false,
      cancelRunningOnFailFast = false,
      actionConcurrency
    } = params;
    if (maxParallelSteps <= 0) {
      throw new Error("maxParallelSteps must be > 0");
    }
    this.maxParallelSteps = maxParallelSteps;
    this.failFast = failFast;
    this.cancelRunningOnFailFast = cancelRunningOnFailFast;
    this.actionConcurrency = normalizeActionConcurrency(actionConcurrency);
  }

  async executeAsync(
    plan: Plan,
    handlers: Record<string, StepHandler>,
    options: ExecuteOptions = {}
  ): Promise<ExecutionState> {
    const resumeState = options.resumeFrom
      ? ExecutionStateSchema.parse(options.resumeFrom)
      : undefined;
    const execId = options.executionId ?? resumeState?.executionId ?? randomUUID();
    const state: ExecutionState = {
      executionId: execId,
      status: ExecutionStatus.RUNNING,
      steps: new Map(),
      startedAt: utcNow()
    };

    const allSteps = new Map<string, Step>();
    for (const step of plan) {
      allSteps.set(step.id, step);
    }

    if (resumeState) {
      for (const stepId of resumeState.steps.keys()) {
        if (!allSteps.has(stepId)) {
          throw new Error(`snapshot includes unknown step '${stepId}'`);
        }
      }
    }

    for (const step of plan) {
      const resumed = resumeState?.steps.get(step.id);
      if (resumed && resumed.stepId !== step.id) {
        throw new Error(
          `snapshot stepId '${resumed.stepId}' does not match plan step '${step.id}'`
        );
      }
      if (resumed && resumed.status === StepStatus.COMPLETED) {
        state.steps.set(step.id, cloneStepResult(resumed));
      } else {
        state.steps.set(step.id, {
          stepId: step.id,
          status: StepStatus.PENDING
        });
      }
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
      stopScheduling: false,
      failFastTriggered: false
    };

    const failFastController =
      this.failFast && this.cancelRunningOnFailFast ? new AbortController() : undefined;
    const handlerSignal = mergeAbortSignals(options.cancelSignal, failFastController?.signal);

    const isCancelled = (): boolean => options.cancelSignal?.aborted ?? false;

    const runningByAction = new Map<string, number>();

    const hasActionCapacity = (action: string): boolean => {
      const limit = this.actionConcurrency.get(action);
      if (!limit || !Number.isFinite(limit)) {
        return true;
      }
      const runningCount = runningByAction.get(action) ?? 0;
      return runningCount < limit;
    };

    const incrementAction = (action: string): void => {
      runningByAction.set(action, (runningByAction.get(action) ?? 0) + 1);
    };

    const decrementAction = (action: string): void => {
      const next = (runningByAction.get(action) ?? 0) - 1;
      if (next <= 0) {
        runningByAction.delete(action);
      } else {
        runningByAction.set(action, next);
      }
    };

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

    const pickNextReady = (): string | undefined => {
      for (let i = 0; i < ready.length; i++) {
        const stepId = ready[i]!;
        const step = allSteps.get(stepId);
        if (!step) {
          continue;
        }
        if (!hasActionCapacity(step.action)) {
          continue;
        }
        ready.splice(i, 1);
        readySet.delete(stepId);
        return stepId;
      }
      return undefined;
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
        if (!schedState.failFastTriggered) {
          schedState.failFastTriggered = true;
          if (failFastController) {
            failFastController.abort();
          }
        }
      }
    };

    const blockStep = async (
      stepId: string,
      res: StepResult,
      reason?: string
    ): Promise<void> => {
      res.status = StepStatus.BLOCKED;
      if (reason && !res.blockedReason) {
        res.blockedReason = reason;
      }
      if (!res.finishedAt) {
        res.finishedAt = utcNow();
      }
      await emit({
        type: "step_blocked",
        executionId: execId,
        ts: utcNow(),
        stepId,
        blockedReason: res.blockedReason
      } satisfies StepBlocked);
    };

    const deriveBlockedReason = (stepId: string): string | undefined => {
      const step = allSteps.get(stepId);
      if (!step) {
        return undefined;
      }

      let hasFailed = false;
      let hasCancelled = false;
      let hasBlocked = false;

      for (const depId of step.deps) {
        const depRes = state.steps.get(depId);
        if (!depRes) {
          throw new Error(`unknown dependency '${depId}' for step '${stepId}'`);
        }
        if (depRes.status === StepStatus.FAILED) {
          hasFailed = true;
        } else if (depRes.status === StepStatus.CANCELLED) {
          hasCancelled = true;
        } else if (depRes.status === StepStatus.BLOCKED) {
          hasBlocked = true;
        }
      }

      if (hasFailed) {
        return BlockedReason.DEPENDENCY_FAILED;
      }
      if (hasCancelled) {
        return BlockedReason.DEPENDENCY_CANCELLED;
      }
      if (hasBlocked) {
        return BlockedReason.DEPENDENCY_BLOCKED;
      }
      if (schedState.failFastTriggered) {
        return BlockedReason.FAIL_FAST;
      }
      return undefined;
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
        signal: handlerSignal,
        plan,
        getResult: (id) => state.steps.get(id)
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
      res.blockedReason = status === StepStatus.BLOCKED ? result.blockedReason : undefined;
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
        const stepId = pickNextReady();
        if (!stepId) {
          break;
        }
        const stepRes = state.steps.get(stepId);
        if (!stepRes || stepRes.status !== StepStatus.PENDING) {
          continue;
        }
        const step = allSteps.get(stepId);
        if (!step) {
          continue;
        }
        await emit({
          type: "step_scheduled",
          executionId: execId,
          ts: utcNow(),
          stepId
        } satisfies StepScheduled);

        const task = runStep(stepId);
        schedState.running.set(task, { stepId, action: step.action });
        incrementAction(step.action);
      }

      if (schedState.running.size === 0) {
        if (schedState.stopScheduling || ready.length === 0) {
          break;
        }
      }

      if (schedState.running.size > 0) {
        try {
          const { task: finished } = await waitForAny(schedState.running.keys());
          const info = schedState.running.get(finished);
          if (info) {
            decrementAction(info.action);
          }
          schedState.running.delete(finished);
        } catch (err) {
          if (isTaskError(err)) {
            const info = schedState.running.get(err.task);
            if (info) {
              decrementAction(info.action);
            }
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

    const newlyBlocked: string[] = [];
    for (const [stepId, res] of state.steps.entries()) {
      if (res.status === StepStatus.PENDING) {
        res.status = StepStatus.BLOCKED;
        newlyBlocked.push(stepId);
      }
    }

    for (const stepId of newlyBlocked) {
      const res = state.steps.get(stepId);
      if (!res) {
        continue;
      }
      const reason = deriveBlockedReason(stepId);
      await blockStep(stepId, res, reason);
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
        if (options.onEvent) {
          await options.onEvent(event);
        }
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

function normalizeActionConcurrency(
  actionConcurrency?: Record<string, number> | Map<string, number>
): Map<string, number> {
  const normalized = new Map<string, number>();
  if (!actionConcurrency) {
    return normalized;
  }

  const entries =
    actionConcurrency instanceof Map ? actionConcurrency.entries() : Object.entries(actionConcurrency);

  for (const [action, rawLimit] of entries) {
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit) && limit !== Infinity) {
      throw new Error(`actionConcurrency limit for '${action}' must be a number`);
    }
    if (limit <= 0) {
      throw new Error(`actionConcurrency limit for '${action}' must be > 0`);
    }
    normalized.set(action, limit);
  }

  return normalized;
}

function cloneStepResult(res: StepResult): StepResult {
  return {
    ...res,
    error: res.error ? { ...res.error } : undefined,
    startedAt: res.startedAt ? new Date(res.startedAt) : undefined,
    finishedAt: res.finishedAt ? new Date(res.finishedAt) : undefined
  };
}
