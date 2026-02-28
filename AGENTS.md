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

- Do the right thing over the easy thing. If uncertain, ask before proceeding.
- Push back respectfully when a request would weaken architecture, contracts, or maintainability.
- Keep the library domain-agnostic. Do not introduce app-, provider-, or product-specific assumptions into core types or executor logic.
- Preserve reliable contracts. Validate boundary inputs/outputs and fail fast with precise errors.
- Refactor for clarity when touching code. Prefer small, composable modules over growing a single file.
- Update documentation with code changes. `README.md` and `EXAMPLE_USAGE.md` must remain accurate.
- A green build is a smoke check, not proof of quality. Validate behavior and contracts, not just command success.
- If you find something odd or risky in code, leave a concise `TODO:` or `GOTCHA:` comment with context.
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
- Never lock `main`.
- Work on a named branch for active changes.
- Use `gh` CLI when creating issues/PRs; include labels when they clarify ownership.
- Avoid dangling branches/PRs; close the loop by merging or explicitly retiring stale work.

### Tooling

- Runtime requirement: Node `>=18.17`.
- Primary commands:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run arch`
- `npm run arch` prints Mermaid architecture graphs to stdout only (no generated files).

## Repository Quality Bar

This repository should optimize for safe change over time:

1. Clear boundaries and intentional coupling.
2. Fast comprehension from a small set of files.
3. Reliable validated contracts and fail-fast invariants.
4. Evolvable structure (no god files, replaceable modules).
5. Tests that protect refactors and critical paths.
6. Documentation that stays true to implementation boundaries.
7. Reproducible, scriptable build/test/typecheck workflows.
8. Consistent directory layout and clear ownership of public API surface.

## Change Checklist

- Keep `src/index.ts` exports aligned with intended public API.
- Ensure new behavior has tests (or existing tests adjusted) in `tests/*.test.ts`.
- Run `npm run typecheck` and `npm test` before finishing.
- If public behavior or APIs changed, update both `README.md` and `EXAMPLE_USAGE.md`.
