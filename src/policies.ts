import type { StepHandler } from "./executor";
import { StepStatus, type StepResult } from "./types";

export interface RetryOptions {
  retries: number;
  delayMs?: number | ((attempt: number, error?: unknown, result?: StepResult) => number);
  retryOn?: (error?: unknown, result?: StepResult) => boolean;
}

export interface TimeoutOptions {
  timeoutMs: number;
}

export function withRetry(handler: StepHandler, options: RetryOptions): StepHandler {
  const maxRetries = Math.max(0, options.retries ?? 0);
  const retryOn = options.retryOn ?? defaultRetryOn;

  return async (step, ctx) => {
    let attempt = 0;

    while (true) {
      if (ctx.signal?.aborted) {
        throw abortError();
      }

      try {
        const result = await handler(step, ctx);
        if (attempt < maxRetries && retryOn(undefined, result)) {
          attempt += 1;
          await sleep(resolveDelay(options.delayMs, attempt, undefined, result), ctx.signal);
          continue;
        }
        return result;
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        if (attempt >= maxRetries || !retryOn(err)) {
          throw err;
        }
        attempt += 1;
        await sleep(resolveDelay(options.delayMs, attempt, err), ctx.signal);
      }
    }
  };
}

export function withTimeout(handler: StepHandler, timeoutMs: number): StepHandler {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return handler;
  }

  return async (step, ctx) => {
    const controller = new AbortController();
    const mergedCtx = ctx.withMergedSignal(controller.signal);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<StepResult>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        const err = new Error(`step timed out after ${timeoutMs}ms`);
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);
    });

    const handlerPromise = handler(step, mergedCtx);

    try {
      return await Promise.race([handlerPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut) {
        return {
          stepId: step.id,
          status: StepStatus.FAILED,
          error: { message: `step timed out after ${timeoutMs}ms`, type: "Timeout" }
        };
      }
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      handlerPromise.catch(() => {});
    }
  };
}

function defaultRetryOn(error?: unknown, result?: StepResult): boolean {
  if (error) {
    return true;
  }
  if (!result) {
    return false;
  }
  if (result.status === StepStatus.CANCELLED || result.status === StepStatus.BLOCKED) {
    return false;
  }
  if (result.status === StepStatus.FAILED) {
    return true;
  }
  return Boolean(result.error);
}

function resolveDelay(
  delayMs: RetryOptions["delayMs"],
  attempt: number,
  error?: unknown,
  result?: StepResult
): number {
  if (typeof delayMs === "function") {
    return Number(delayMs(attempt, error, result));
  }
  return Number(delayMs ?? 0);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: string }).name) : "";
  return name === "AbortError";
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let onAbort: (() => void) | undefined;

    const timer = setTimeout(() => {
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, delay);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort!);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
