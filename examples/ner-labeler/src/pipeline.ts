import { DagExecutor, PlanBuilder, raiseIfFailed } from "ts-agent-lib";
import type { ExecuteOptions, StepHandler, StructuredLlmClient } from "ts-agent-lib";
import { loadPromptHandlers } from "../prompts/prompt_handlers.ts";
import { emitStepTelemetry, type StepTelemetrySink } from "./events.js";
import { InferenceInputSchema, TrainingRecordSchema, type InferenceInput, type TrainingRecord } from "./types.js";
import {
  buildInitialStepTelemetry,
  createExtractHandler,
  createMergeHandler,
  toExtractStepId,
  type LabelStep
} from "./builders.js";

const MERGE_STEP_ID = "merge_entity_labels";

export interface RunNerLabelingParams {
  input: InferenceInput;
  model: string;
  llm: StructuredLlmClient;
  onEvent?: ExecuteOptions["onEvent"];
  onStepTelemetry?: StepTelemetrySink;
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

  await seedInitialStepTelemetry({
    input,
    model: params.model,
    labelSteps,
    onStepTelemetry: params.onStepTelemetry
  });

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
      labelSteps,
      onStepTelemetry: params.onStepTelemetry
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
  onStepTelemetry?: StepTelemetrySink;
}): Record<string, StepHandler> {
  const handlers: Record<string, StepHandler> = {
    [MERGE_STEP_ID]: createMergeHandler(params)
  };

  for (const labelStep of params.labelSteps) {
    handlers[toExtractStepId(labelStep.label)] = createExtractHandler(params, labelStep);
  }

  return handlers;
}

async function seedInitialStepTelemetry(params: {
  input: InferenceInput;
  model: string;
  labelSteps: LabelStep[];
  onStepTelemetry?: StepTelemetrySink;
}): Promise<void> {
  for (const telemetry of buildInitialStepTelemetry({
    input: params.input,
    model: params.model,
    labelSteps: params.labelSteps,
    mergeStepId: MERGE_STEP_ID
  })) {
    await emitStepTelemetry(params.onStepTelemetry, {
      ...telemetry
    })
  }
}
