# ts-agent-lib

Minimal, domain-agnostic DAG scheduler/executor for step-based workflows. It runs a plan of steps with dependencies, supports cancellation and event streaming, and stays decoupled from any specific domain (LLM, agent, etc.).

## Installation

```bash
npm i ts-agent-lib
```

## 5-minute example (DAG + dataflow)

```ts
import {
  DagExecutor,
  PlanBuilder,
  StepStatus,
  type StepHandler
} from "ts-agent-lib";

// 1) Define a plan.
const builder = new PlanBuilder();
builder.addStep({ id: "pick-files", action: "pick" });
builder.addStep({ id: "edit-files", action: "edit", deps: ["pick-files"] });
const plan = builder.build();

// 2) Define handlers.
const handlers: Record<string, StepHandler> = {
  pick: async (step) => ({
    stepId: step.id,
    status: StepStatus.COMPLETED,
    output: ["src/app.ts", "src/utils.ts"]
  }),
  edit: async (step, ctx) => {
    const deps = ctx.getDependencyOutputs<string[]>();
    const files = deps["pick-files"] ?? [];

    // Use files to do work...
    return {
      stepId: step.id,
      status: StepStatus.COMPLETED,
      output: { edited: files.length }
    };
  }
};

// 3) Execute.
const executor = new DagExecutor({ maxParallelSteps: 4, failFast: false });
const state = await executor.executeAsync(plan, handlers);

// 4) Inspect results.
const edited = state.steps.get("edit-files")?.output;
console.log("edit result", edited);
```

## Dataflow across dependencies

Step handlers receive a `StepContext` with read-only access to the plan and the current execution results:

- `getStep(stepId)` returns the immutable plan step.
- `getResult(stepId)` returns a copy of the latest `StepResult` (or undefined).
- `requireResult(stepId)` throws if the result is missing.
- `getDependencyResults()` returns completed dependency results keyed by dep id.
- `getDependencyOutputs()` returns completed dependency outputs keyed by dep id.

Behavior:

- Only **completed** dependencies appear in `getDependencyResults()` / `getDependencyOutputs()`.
- Outputs are user data; the executor does not clone or sanitize them.
- Results returned by the context are shallow copies, so handler code cannot mutate executor state.

## Cancellation and failFast

Use `AbortController` to cancel an execution. Pending steps become `cancelled`. Handlers should check `ctx.isCancelled()` or `ctx.signal?.aborted` and return promptly.

`failFast: true` stops scheduling new steps after the first failure. (Running steps are not cancelled today; see roadmap.)

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const state = await new DagExecutor().executeAsync(plan, handlers, {
  cancelSignal: controller.signal
});
```

## Events and observers

You can observe execution events via `onEvent` or by iterating `streamExecute`:

```ts
for await (const event of executor.streamExecute(plan, handlers)) {
  console.log(event.type);
}
```

Events include: `execution_started`, `step_scheduled`, `step_started`, `step_completed`, `step_failed`, `step_blocked`, `step_cancelled`, `execution_completed`, and `execution_cancelled`.

## Validation

The library exposes zod schemas for validation at boundaries:

```ts
import { StepSchema, ExecutionStateSchema } from "ts-agent-lib";

const step = StepSchema.parse({ id: "x", action: "work" });
const state = ExecutionStateSchema.parse({
  executionId: "exec-1",
  status: "completed",
  steps: { x: { stepId: "x", status: "completed" } }
});
```

## Roadmap (design stubs)

- Execution snapshots: JSON-serializable snapshots with `serializeExecutionState` / `deserializeExecutionState`, plus resume support. Proposed semantics: steps marked `running` in a snapshot resume as `pending`, and snapshots referencing unknown step IDs raise an error.
- Fail-fast cancellation: when `failFast` is enabled, abort a shared signal so running steps can exit early.
- Explainable blocked steps: add a `blockedReason` on results or on `step_blocked` events.
- Optional step policies: minimal retry/timeout helpers.
- Optional concurrency lanes: per-action caps in addition to global `maxParallelSteps`.
