import { DagExecutor, PlanBuilder, StepStatus, raiseIfFailed } from "ts-agent-lib";
import type { ExecuteOptions, StepHandler, StructuredLlmClient } from "ts-agent-lib";
import { loadPromptHandlers } from "../prompts/prompt_handlers.ts";
import {
  InferenceInputSchema,
  LabelExtractionSchema,
  TaggedEntityByLabelSchema,
  TrainingRecordSchema,
  type EntitySpan,
  type InferenceInput,
  type LabelExtraction,
  type TrainingRecord
} from "./types.js";

const MERGE_STEP_ID = "merge_entity_labels";
const EXTRACT_STEP_PREFIX = "extract:";

interface LabelStep {
  label: string;
  systemPrompt: string;
}

export interface RunNerLabelingParams {
  input: InferenceInput;
  model: string;
  llm: StructuredLlmClient;
  onEvent?: ExecuteOptions["onEvent"];
  execution?: {
    maxParallelSteps?: number;
    failFast?: boolean;
  };
}

export async function runNerLabeling(params: RunNerLabelingParams): Promise<TrainingRecord> {
  const input = InferenceInputSchema.parse(params.input);
  const promptHandlers = await loadPromptHandlers();
  const labelSteps: LabelStep[] = promptHandlers.map(({ handler_name, system_prompt }) => ({
    label: handler_name,
    systemPrompt: system_prompt
  }));

  const executor = new DagExecutor({
    maxParallelSteps: params.execution?.maxParallelSteps ?? 8,
    failFast: params.execution?.failFast ?? true
  });

  const state = await executor.executeAsync(
    buildPlan(labelSteps),
    createHandlers({
      input,
      model: params.model,
      llm: params.llm,
      labelSteps
    }),
    { onEvent: params.onEvent }
  );

  raiseIfFailed(state);
  return TrainingRecordSchema.parse(state.steps.get(MERGE_STEP_ID)?.output);
}

function buildPlan(labelSteps: LabelStep[]) {
  if (labelSteps.length === 0) {
    throw new Error("at least one label step is required before merge");
  }

  const builder = new PlanBuilder();

  for (const labelStep of labelSteps) {
    const stepId = toExtractStepId(labelStep.label);
    builder.addStep({ id: stepId, action: stepId });
  }

  builder.addStep({
    id: MERGE_STEP_ID,
    action: MERGE_STEP_ID,
    deps: labelSteps.map((labelStep) => toExtractStepId(labelStep.label))
  });

  return builder.build();
}

function createHandlers(params: {
  input: InferenceInput;
  model: string;
  llm: StructuredLlmClient;
  labelSteps: LabelStep[];
}): Record<string, StepHandler> {
  const handlers: Record<string, StepHandler> = {
    [MERGE_STEP_ID]: async (step, ctx) => {
      const entities = TaggedEntityByLabelSchema.parse(
        Object.fromEntries(
          params.labelSteps.map((labelStep) => {
            const extraction = parseLabelExtraction(
              ctx.requireResult(toExtractStepId(labelStep.label)).output,
              labelStep.label
            );

            return [
              labelStep.label,
              {
                label: extraction.label,
                confidence: extraction.confidence,
                spans: buildTaggedSpans(extraction.matches, params.input)
              }
            ];
          })
        )
      );

      return {
        stepId: step.id,
        status: StepStatus.COMPLETED,
        output: TrainingRecordSchema.parse({
          inputText: params.input,
          entities
        })
      };
    }
  };

  for (const labelStep of params.labelSteps) {
    const stepId = toExtractStepId(labelStep.label);

    handlers[stepId] = async (step) => {
      const extraction = parseLabelExtraction(
        await params.llm.inferStructured<LabelExtraction>({
          model: params.model,
          systemPrompt: labelStep.systemPrompt,
          userPrompt: params.input,
          schema: {
            name: `ner_label_extraction_${toSchemaToken(labelStep.label)}`,
            schema: buildLabelExtractionJsonSchema(labelStep.label)
          },
          outputSchema: LabelExtractionSchema
        }),
        labelStep.label
      );

      assertMatchesAreExact(extraction, params.input);

      return {
        stepId: step.id,
        status: StepStatus.COMPLETED,
        output: extraction
      };
    };
  }

  return handlers;
}

function parseLabelExtraction(value: unknown, expectedLabel: string): LabelExtraction {
  const extraction = LabelExtractionSchema.parse(value);
  assertExpectedLabel(extraction, expectedLabel);
  return extraction;
}

function assertExpectedLabel(extraction: LabelExtraction, expectedLabel: string): void {
  if (extraction.label !== expectedLabel) {
    throw new Error(`label mismatch: expected '${expectedLabel}', got '${extraction.label}'`);
  }
}

function buildTaggedSpans(matches: string[], input: InferenceInput): EntitySpan[] {
  const exactMatches = matches.filter((candidate) => candidate.toLowerCase() !== "none");
  if (exactMatches.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const spans: EntitySpan[] = [];

  for (const candidate of exactMatches) {
    const regex = new RegExp(escapeRegex(candidate), "g");

    for (const result of input.matchAll(regex)) {
      if (result.index === undefined) {
        continue;
      }

      const start = result.index;
      const end = start + result[0].length;
      const key = `${start}:${end}:${result[0]}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      spans.push({ text: result[0], start, end });
    }
  }

  return spans;
}

function assertMatchesAreExact(extraction: LabelExtraction, input: InferenceInput): void {
  for (const candidate of extraction.matches) {
    if (candidate.toLowerCase() === "none") {
      continue;
    }

    if (!input.includes(candidate)) {
      throw new Error(`extracted match '${candidate}' is not an exact substring of the input text`);
    }
  }
}

function toExtractStepId(label: string): string {
  return `${EXTRACT_STEP_PREFIX}${label}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toSchemaToken(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "label";
}

function buildLabelExtractionJsonSchema(label: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "matches", "confidence"],
    properties: {
      label: { type: "string", enum: [label] },
      matches: {
        type: "array",
        minItems: 1,
        items: { type: "string" }
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      }
    }
  };
}
