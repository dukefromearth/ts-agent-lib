# Example Usage (Domain-Agnostic)

This document captures a real-world pattern one team used with `ts-agent-lib`:

- represent an async workflow as a DAG (steps + dependencies)
- execute it with explicit semantics (fail-fast, cancellation, max-parallelism, per-action caps)
- stream or observe execution events
- validate inputs/outputs at runtime (zod, like pydantic in the Python version)
- optionally aggregate `Usage` and estimate cost via pricing rules
- optionally snapshot and resume execution state
- optionally apply retry/timeout policies per action

The example intentionally avoids any domain- or application-specific logic. Replace the placeholder work in handlers with your own calls.

For a concrete, adapter-first NER labeling scaffold with strict structured outputs and Jinja-style prompt templating, see `examples/ner-labeler/README.md`.

## Core Concepts

- `Step`: a unit of work with an `id`, `action`, optional `deps`, and optional `payload`.
- `Plan`: an immutable set of steps (validated and frozen).
- `PlanBuilder`: a mutable helper that builds a validated `Plan` (unique ids, valid deps, acyclic).
- `DagExecutor`: runs a `Plan` by scheduling steps when all dependencies are `completed`.
- `ExecutionEventType`: strongly-typed events emitted during execution (scheduled/started/completed/failed/blocked/cancelled).
- `runPlan`: convenience helper to execute and (optionally) aggregate `Usage` + compute costs.

## Minimal Plan + Handlers

```ts
import {
  DagExecutor,
  PlanBuilder,
  StepStatus,
  TaskOutput,
  Usage,
  type StepHandler
} from "ts-agent-lib";

// 1) Define a small DAG.
const builder = new PlanBuilder();

// Two independent steps can run in parallel.
builder.addStep({ id: "step-a", action: "work" });
builder.addStep({ id: "step-b", action: "work" });

// This step depends on both of the above completing successfully.
builder.addStep({ id: "step-c", action: "work", deps: ["step-a", "step-b"] });

const plan = builder.build();

// 2) Provide action handlers.
const handlers: Record<string, StepHandler> = {
  work: async (step, ctx) => {
    // Cooperative cancellation: handlers should check periodically.
    if (ctx.isCancelled()) {
      return { stepId: step.id, status: StepStatus.CANCELLED };
    }

    // Do your work here.
    const value = { ok: true, stepId: step.id };

    // Optional: attach usage metrics in a provider-agnostic shape.
    const usage = new Usage({
      provider: "example-provider",
      model: "example-model",
      metrics: { requests: 1, input_tokens: 128, output_tokens: 64 }
    });

    return {
      stepId: step.id,
      status: StepStatus.COMPLETED,
      output: new TaskOutput({ value, usage })
    };
  }
};

// 3) Execute.
const executor = new DagExecutor({ maxParallelSteps: 8, failFast: false });
const state = await executor.executeAsync(plan, handlers);

// 4) Interpret outputs from the final state.
const values: unknown[] = [];
for (const res of state.steps.values()) {
  if (res.status === StepStatus.COMPLETED && res.output instanceof TaskOutput) {
    values.push(res.output.value);
  }
}
```

## Usage + Cost Estimation (Optional)

If handlers return `TaskOutput` with `Usage`, `runPlan` can aggregate it across all steps and estimate cost using simple pricing rules.

```ts
import { PlanBuilder, runPlan, PricingRule } from "ts-agent-lib";

const builder = new PlanBuilder();
builder.addStep({ id: "a", action: "work" });
const plan = builder.build();

const pricing: PricingRule[] = [
  { metric: "input_tokens", perUnit: 0.25, scale: 1_000_000 },
  { metric: "output_tokens", perUnit: 2.0, scale: 1_000_000 }
];

const [state, usage, costs] = await runPlan(plan, handlers, {
  pricingRules: pricing
});

// usage/costs are undefined if no usage was produced (or pricing rules weren't provided).
```

## Events, Observers, and Backpressure

### Event callback

```ts
import { DagExecutor } from "ts-agent-lib";

const executor = new DagExecutor();
await executor.executeAsync(plan, handlers, {
  onEvent: async (event) => {
    // event.type is one of: execution_started, step_scheduled, step_started, ...
    // Keep this callback low-latency; offload heavy work if needed.
    // eslint-disable-next-line no-console
    console.log(event.type, "stepId" in event ? event.stepId : "");
  }
});
```

### Composing observers

```ts
import {
  composeObserversParallel,
  ObserverFailurePolicy,
  type ExecutionObserver
} from "ts-agent-lib";

class DebugObserver implements ExecutionObserver {
  onEvent(event: any) {
    // eslint-disable-next-line no-console
    console.log(event.type);
  }
}

class CounterObserver implements ExecutionObserver {
  count = 0;
  onEvent() {
    this.count += 1;
  }
}

const counter = new CounterObserver();
const onEvent = composeObserversParallel([new DebugObserver(), counter], {
  failurePolicy: ObserverFailurePolicy.LENIENT
});

await new DagExecutor().executeAsync(plan, handlers, { onEvent });
```

### Buffered observers

For higher-volume events or expensive processing, a `BufferedObserver` lets you enqueue events and process them in a background loop. It supports simple overflow policies:

```ts
import { BufferedObserver, OverflowPolicy, type ExecutionEventType } from "ts-agent-lib";

class BufferedLogger extends BufferedObserver {
  protected async process(event: ExecutionEventType) {
    // Heavy/slow work belongs here, not in DagExecutor's scheduling loop.
    // eslint-disable-next-line no-console
    console.log("event:", event.type);
  }
}

const logger = new BufferedLogger({
  maxQueueSize: 1000,
  overflowPolicy: OverflowPolicy.DROP_OLDEST
});

await logger.start();
try {
  const onEvent = (event: ExecutionEventType) => logger.onEvent(event);
  await new DagExecutor().executeAsync(plan, handlers, { onEvent });
} finally {
  await logger.stop();
}
```

If you only need event logs in NDJSON format, `JsonlEventObserver` is available as a built-in adapter.

## Cancellation

Use `AbortController` to cancel an execution. Pending steps become `cancelled`. Handlers should check `ctx.isCancelled()` (or `ctx.signal?.aborted`) and return promptly.

```ts
import { DagExecutor } from "ts-agent-lib";

const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const state = await new DagExecutor().executeAsync(plan, handlers, {
  cancelSignal: controller.signal
});
```

## Execution snapshots + resume

Persist execution state and resume later without re-running completed steps:

```ts
import {
  DagExecutor,
  serializeExecutionState,
  deserializeExecutionState
} from "ts-agent-lib";

const state = await new DagExecutor().executeAsync(plan, handlers);
const snapshot = serializeExecutionState(state);

// Persist snapshot as JSON...
const restored = deserializeExecutionState(snapshot);

const resumed = await new DagExecutor().executeAsync(plan, handlers, {
  resumeFrom: restored
});
```

## Per-action concurrency + retry/timeout policies

```ts
import { DagExecutor, withRetry, withTimeout, StepStatus } from "ts-agent-lib";

const executor = new DagExecutor({
  maxParallelSteps: 8,
  actionConcurrency: { llm: 2 }
});

const handlers = {
  llm: withRetry(
    withTimeout(async (step) => {
      return { stepId: step.id, status: StepStatus.COMPLETED };
    }, 5_000),
    { retries: 2, delayMs: 250 }
  )
};

await executor.executeAsync(plan, handlers);
```

## Runtime Validation (zod)

`ts-agent-lib` exposes zod schemas for the core models so you can validate inputs at boundaries (config files, network payloads, persisted state, etc.).

```ts
import {
  StepSchema,
  StepResultSchema,
  ExecutionStateSchema,
  ExecutionEventTypeSchema
} from "ts-agent-lib";

const step = StepSchema.parse({ id: "x", action: "work" }); // deps defaults to []

// Validate a handler result shape (the executor also validates handler results internally).
const stepResult = StepResultSchema.parse({ stepId: "x", status: "completed" });

// Validate persisted/transported state.
const state = ExecutionStateSchema.parse({
  executionId: "exec-1",
  status: "completed",
  steps: {
    x: { stepId: "x", status: "completed" }
  }
});

// Validate an event payload you received externally.
ExecutionEventTypeSchema.parse({
  type: "step_started",
  executionId: "exec-1",
  ts: new Date(),
  stepId: "x"
});
```
