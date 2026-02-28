import { DagExecutor, PlanBuilder, StepStatus, raiseIfFailed } from "ts-agent-lib";
import type { ExecuteOptions, StepHandler, StructuredLlmClient } from "ts-agent-lib";
import { loadPromptHandlers } from "../prompts/prompt_handlers.ts";
import {
  InferenceInputSchema,
  LabelExtractionByLabelSchema,
  LabelExtractionSchema,
  TrainingRecordSchema,
  type InferenceInput,
  type LabelExtraction,
  type LabelExtractionByLabel,
  type TrainingRecord
} from "./types.js";

const MERGE_STEP_ID = "merge_entity_labels";
const MERGE_ACTION = "merge_entity_labels";

interface LabelStepDefinition {
  label: string;
  systemPrompt: string;
  stepId: string;
  action: string;
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

  const labelSteps = promptHandlers.map((prompt) => ({
    label: prompt.handler_name,
    systemPrompt: prompt.system_prompt,
    stepId: `extract:${prompt.handler_name}`,
    action: `extract:${prompt.handler_name}`
  }));

  const plan = buildPlan(labelSteps);
  const handlers = createHandlers({
    input,
    model: params.model,
    llm: params.llm,
    labelSteps
  });

  const executor = new DagExecutor({
    maxParallelSteps: params.execution?.maxParallelSteps ?? 8,
    failFast: params.execution?.failFast ?? true
  });

  const state = await executor.executeAsync(plan, handlers, { onEvent: params.onEvent });
  raiseIfFailed(state);

  return parseTrainingRecordOutput(state.steps.get(MERGE_STEP_ID)?.output);
}

function buildPlan(labelSteps: LabelStepDefinition[]) {
  const builder = new PlanBuilder();

  for (const labelStep of labelSteps) {
    builder.addStep({
      id: labelStep.stepId,
      action: labelStep.action
    });
  }

  builder.addStep({
    id: MERGE_STEP_ID,
    action: MERGE_ACTION,
    deps: labelSteps.map((step) => step.stepId)
  });

  return builder.build();
}

function createHandlers(params: {
  input: InferenceInput;
  model: string;
  llm: StructuredLlmClient;
  labelSteps: LabelStepDefinition[];
}): Record<string, StepHandler> {
  const handlers: Record<string, StepHandler> = {
    [MERGE_ACTION]: async (step, ctx) => {
      const entities: LabelExtractionByLabel = {};

      for (const labelStep of params.labelSteps) {
        entities[labelStep.label] = readLabel(ctx.requireResult(labelStep.stepId).output, labelStep.label);
      }

      return {
        stepId: step.id,
        status: StepStatus.COMPLETED,
        output: TrainingRecordSchema.parse({
          inputId: params.input.inputId,
          inputText: params.input.inputText,
          contextTexts: params.input.contextTexts,
          entities: LabelExtractionByLabelSchema.parse(entities)
        })
      };
    }
  };

  for (const labelStep of params.labelSteps) {
    handlers[labelStep.action] = async (step) => {
      const extraction = LabelExtractionSchema.parse(
        await params.llm.inferStructured<LabelExtraction>({
          model: params.model,
          systemPrompt: labelStep.systemPrompt,
          userPrompt: buildUserPrompt(params.input, labelStep.label),
          schema: {
            name: `ner_label_extraction_${toSchemaToken(labelStep.label)}`,
            schema: buildLabelExtractionJsonSchema(labelStep.label)
          },
          outputSchema: LabelExtractionSchema
        })
      );

      if (extraction.label !== labelStep.label) {
        throw new Error(`label mismatch: expected '${labelStep.label}', got '${extraction.label}'`);
      }

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

function buildUserPrompt(input: InferenceInput, label: string): string {
  const payload = {
    label,
    inputText: input.inputText,
    contextTexts: input.contextTexts
  };

  return [
    "Extract entities for exactly one label and return JSON only.",
    "The JSON must match the response schema.",
    JSON.stringify(payload, null, 2)
  ].join("\n\n");
}

function readLabel(value: unknown, expectedLabel: string): LabelExtraction {
  const extraction = LabelExtractionSchema.parse(value);
  if (extraction.label !== expectedLabel) {
    throw new Error(`label mismatch: expected '${expectedLabel}', got '${extraction.label}'`);
  }
  return extraction;
}

function assertMatchesAreExact(extraction: LabelExtraction, input: InferenceInput): void {
  const corpus = [input.inputText, ...input.contextTexts].join("\n");

  for (const candidate of extraction.matches) {
    if (candidate.toLowerCase() === "none") {
      continue;
    }
    if (!corpus.includes(candidate)) {
      throw new Error(`extracted match '${candidate}' is not an exact substring of provided context`);
    }
  }
}

function parseTrainingRecordOutput(value: unknown): TrainingRecord {
  return TrainingRecordSchema.parse(value);
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
