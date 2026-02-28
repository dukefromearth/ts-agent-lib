# Overview

`ts-agent-lib` is a minimal, domain-agnostic DAG scheduler/executor for step-based workflows.
It provides a strongly-typed execution core (planning, scheduling, cancellation, events, snapshots, and policy helpers) without embedding application- or vendor-specific logic.

## Core Modules

- `src/types.ts`
  - Canonical schemas and domain models (`Step`, `Plan`, `StepResult`, execution/event types).
  - `Plan` is immutable; validation is done with zod.
- `src/planning.ts`
  - `PlanBuilder` with dependency and cycle validation.
- `src/executor.ts`
  - `DagExecutor`, `StepContext`, scheduling loop, fail-fast behavior, cancellation, and event streaming.
- `src/snapshots.ts`
  - Serialize/deserialize execution state for persistence/resume.
- `src/policies.ts`
  - `withRetry` and `withTimeout` wrappers for step handlers.
- `src/observers.ts`
  - Observer composition and buffered observer utilities.
- `src/runner.ts` and `src/usage.ts`
  - Higher-level runner helpers plus usage aggregation/cost estimation.
- `src/index.ts`
  - Public API surface. Keep exports intentional and stable.

## Engineering Principles

- Keep the library domain-agnostic. Do not introduce app-, provider-, or product-specific assumptions into core types or executor logic.
- Preserve reliable contracts. Validate boundary inputs/outputs and fail fast with precise errors.
- Refactor for clarity when touching code. Prefer small, composable modules over growing a single file.
- Update documentation with code changes. `README.md` and `EXAMPLE_USAGE.md` must remain accurate.
- If behavior changes, update or add tests in `tests/` in the same change.

## Execution Invariants (Do Not Regress)

- Plans must have unique step IDs, known dependencies, no self-deps, and no cycles.
- Steps are schedulable only when all dependencies are `completed`.
- `StepContext.getDependencyResults()` / `getDependencyOutputs()` expose only completed dependency results.
- `failFast` stops new scheduling after first failure; `cancelRunningOnFailFast` cooperatively aborts running handlers.
- On cancellation, pending steps become `cancelled`.
- Resuming from snapshots must not re-run completed steps and must reject unknown step IDs.

## Development Workflow

### Git

- Start by checking repository state:
  - `git fetch origin`
  - `git status -sb`
- Work on a named branch for active changes.

### Tooling

- Runtime requirement: Node `>=18.17`.
- Primary commands:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run arch:deps`

There is currently no `arch:gen`, `test:all`, or lint script in this repo. Do not reference non-existent commands in docs or PR notes.

## Change Checklist

- Keep `src/index.ts` exports aligned with intended public API.
- Ensure new behavior has tests (or existing tests adjusted) in `tests/*.test.ts`.
- Run `npm run typecheck` and `npm test` before finishing.
- If public behavior or APIs changed, update both `README.md` and `EXAMPLE_USAGE.md`.
