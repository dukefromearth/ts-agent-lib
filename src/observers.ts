import { AsyncQueue } from "./internal/async_queue";
import type { EventHandler } from "./executor";
import type { ExecutionEventType } from "./types";

export interface ExecutionObserver {
  onEvent(event: ExecutionEventType): void | Promise<void>;
}

export type ObserverErrorHandler = (
  observer: ExecutionObserver,
  event: ExecutionEventType,
  error: Error
) => void | Promise<void>;

export const ObserverFailurePolicy = {
  LENIENT: "lenient",
  STRICT: "strict"
} as const;

export type ObserverFailurePolicy =
  (typeof ObserverFailurePolicy)[keyof typeof ObserverFailurePolicy];

async function callObserverErrorHandler(
  handler: ObserverErrorHandler | undefined,
  observer: ExecutionObserver,
  event: ExecutionEventType,
  error: Error
): Promise<void> {
  if (!handler) {
    return;
  }
  await handler(observer, event, error);
}

export function composeObservers(
  observers: Iterable<ExecutionObserver>,
  options: {
    onError?: ObserverErrorHandler;
    failurePolicy?: ObserverFailurePolicy;
  } = {}
): EventHandler {
  const list = Array.from(observers);
  const failurePolicy = options.failurePolicy ?? ObserverFailurePolicy.LENIENT;

  return async (event: ExecutionEventType): Promise<void> => {
    for (const obs of list) {
      try {
        await obs.onEvent(event);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        await callObserverErrorHandler(options.onError, obs, event, error);
        if (failurePolicy === ObserverFailurePolicy.STRICT) {
          throw error;
        }
      }
    }
  };
}

export function composeObserversParallel(
  observers: Iterable<ExecutionObserver>,
  options: {
    onError?: ObserverErrorHandler;
    failurePolicy?: ObserverFailurePolicy;
  } = {}
): EventHandler {
  const list = Array.from(observers);
  const failurePolicy = options.failurePolicy ?? ObserverFailurePolicy.LENIENT;

  return async (event: ExecutionEventType): Promise<void> => {
    const results = await Promise.allSettled(list.map((obs) => obs.onEvent(event)));
    const errors: Array<{ observer: ExecutionObserver; error: Error }> = [];

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        errors.push({ observer: list[index], error });
      }
    });

    if (errors.length === 0) {
      return;
    }

    for (const entry of errors) {
      await callObserverErrorHandler(options.onError, entry.observer, event, entry.error);
    }

    if (failurePolicy === ObserverFailurePolicy.STRICT) {
      throw errors[0].error;
    }
  };
}

export const OverflowPolicy = {
  BLOCK: "block",
  DROP_NEW: "drop_new",
  DROP_OLDEST: "drop_oldest"
} as const;

export type OverflowPolicy = (typeof OverflowPolicy)[keyof typeof OverflowPolicy];

export abstract class BufferedObserver implements ExecutionObserver {
  readonly maxQueueSize: number;
  readonly overflowPolicy: OverflowPolicy;
  readonly onError?: (event: ExecutionEventType, error: Error) => void | Promise<void>;

  private readonly queue: AsyncQueue<ExecutionEventType>;
  private task: Promise<void> | null = null;
  private started = false;
  private abortController: AbortController | null = null;

  dropped = 0;
  failed = false;
  lastError: Error | null = null;

  constructor(params: {
    maxQueueSize?: number;
    overflowPolicy?: OverflowPolicy;
    onError?: (event: ExecutionEventType, error: Error) => void | Promise<void>;
  } = {}) {
    this.maxQueueSize = params.maxQueueSize ?? 1000;
    this.overflowPolicy = params.overflowPolicy ?? OverflowPolicy.BLOCK;
    this.onError = params.onError;
    this.queue = new AsyncQueue<ExecutionEventType>(this.maxQueueSize);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.abortController = new AbortController();
    this.task = this.run(this.abortController.signal);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.abortController?.abort();
    if (this.task) {
      try {
        await this.task;
      } catch {
        // Swallow: failure is captured via failed/lastError.
      }
    }
  }

  async onEvent(event: ExecutionEventType): Promise<void> {
    if (this.failed) {
      if (this.lastError) {
        throw this.lastError;
      }
      throw new Error("buffered observer worker has failed");
    }

    if (!this.started) {
      await this.process(event);
      return;
    }

    if (this.overflowPolicy === OverflowPolicy.BLOCK) {
      await this.queue.put(event);
      return;
    }

    if (this.queue.tryPut(event)) {
      return;
    }

    this.dropped += 1;
    if (this.overflowPolicy === OverflowPolicy.DROP_NEW) {
      return;
    }

    if (this.overflowPolicy === OverflowPolicy.DROP_OLDEST) {
      this.queue.shift();
      if (!this.queue.tryPut(event)) {
        return;
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let event: ExecutionEventType;
      try {
        event = await this.queue.get(signal);
      } catch (err) {
        if (isAbortError(err)) {
          break;
        }
        throw err;
      }

      try {
        await this.process(event);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.failed = true;
        this.lastError = error;
        if (this.onError) {
          await this.onError(event, error);
        }
        break;
      }
    }
  }

  protected abstract process(event: ExecutionEventType): void | Promise<void>;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: string }).name) : "";
  return name === "AbortError";
}
