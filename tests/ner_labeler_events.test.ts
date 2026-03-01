import { describe, expect, it } from "vitest";
import type { ExecutionEventType } from "../src/index";
import {
  createNerEventSerializer,
  upsertStepTelemetry,
  type NerStepTelemetry
} from "../examples/ner-labeler/src/events";
import { buildInitialStepTelemetry } from "../examples/ner-labeler/src/builders";

describe("ner-labeler event enrichment", () => {
  it("merges step telemetry updates by stepId", () => {
    const store = new Map<string, NerStepTelemetry>();

    upsertStepTelemetry(store, {
      stepId: "extract:person_name",
      action: "extract:person_name",
      label: "person_name",
      input: { userPrompt: "Jordan Lee" }
    });

    const merged = upsertStepTelemetry(store, {
      stepId: "extract:person_name",
      action: "extract:person_name",
      label: "person_name",
      output: {
        label: "person_name",
        matches: ["Jordan Lee"],
        confidence: 0.91
      }
    });

    expect(merged.input).toEqual({ userPrompt: "Jordan Lee" });
    expect(merged.output).toEqual({
      label: "person_name",
      matches: ["Jordan Lee"],
      confidence: 0.91
    });
  });

  it("serializes events with run input and step telemetry", () => {
    const telemetryByStepId = new Map<string, NerStepTelemetry>();
    upsertStepTelemetry(telemetryByStepId, {
      stepId: "extract:person_name",
      action: "extract:person_name",
      label: "person_name",
      input: { userPrompt: "Jordan Lee at City Library" },
      output: {
        label: "person_name",
        matches: ["Jordan Lee"],
        confidence: 0.93
      }
    });

    const serialize = createNerEventSerializer({
      inputText: "Jordan Lee at City Library",
      telemetryByStepId
    });

    const event: ExecutionEventType = {
      type: "step_completed",
      executionId: "exec-1",
      ts: new Date("2026-01-01T00:00:00.000Z"),
      stepId: "extract:person_name"
    };

    const parsed = JSON.parse(serialize(event)) as {
      runInputText: string;
      stepTelemetry?: { output?: { matches?: string[] } };
    };

    expect(parsed.runInputText).toBe("Jordan Lee at City Library");
    expect(parsed.stepTelemetry?.output?.matches).toEqual(["Jordan Lee"]);
  });

  it("includes full telemetry snapshot on execution completion", () => {
    const telemetryByStepId = new Map<string, NerStepTelemetry>();
    upsertStepTelemetry(telemetryByStepId, {
      stepId: "extract:person_name",
      action: "extract:person_name",
      output: { confidence: 0.9 }
    });
    upsertStepTelemetry(telemetryByStepId, {
      stepId: "merge_entity_labels",
      action: "merge_entity_labels",
      output: { entities: { person_name: { confidence: 0.9 } } }
    });

    const serialize = createNerEventSerializer({
      inputText: "Jordan Lee",
      telemetryByStepId
    });

    const event: ExecutionEventType = {
      type: "execution_completed",
      executionId: "exec-1",
      ts: new Date("2026-01-01T00:00:00.000Z"),
      status: "completed",
      finishedAt: new Date("2026-01-01T00:00:01.000Z")
    };

    const parsed = JSON.parse(serialize(event)) as {
      stepTelemetryById?: Record<string, unknown>;
    };

    expect(parsed.stepTelemetryById).toBeDefined();
    expect(parsed.stepTelemetryById?.["extract:person_name"]).toBeDefined();
    expect(parsed.stepTelemetryById?.["merge_entity_labels"]).toBeDefined();
  });

  it("attaches telemetry to step_started events for every seeded step", () => {
    const telemetryByStepId = new Map<string, NerStepTelemetry>();
    const labelSteps = [
      { label: "person_name", systemPrompt: "extract person names" },
      { label: "location_reference", systemPrompt: "extract location references" }
    ];

    for (const telemetry of buildInitialStepTelemetry({
      input: "Jordan Lee at City Library tomorrow 4:30 PM @coach_sam.",
      model: "test-model",
      labelSteps,
      mergeStepId: "merge_entity_labels"
    })) {
      upsertStepTelemetry(telemetryByStepId, telemetry);
    }

    const serialize = createNerEventSerializer({
      inputText: "Jordan Lee at City Library tomorrow 4:30 PM @coach_sam.",
      telemetryByStepId
    });

    const startedEvents = Array.from(telemetryByStepId.keys()).map((stepId) =>
      JSON.parse(
        serialize({
          type: "step_started",
          executionId: "exec-1",
          ts: new Date("2026-01-01T00:00:00.000Z"),
          stepId
        } satisfies ExecutionEventType)
      ) as { stepId?: string; stepTelemetry?: { input?: unknown } }
    );

    expect(startedEvents.length).toBe(3);
    expect(startedEvents.every((event) => event.stepTelemetry?.input !== undefined)).toBe(true);
  });
});
