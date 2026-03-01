import { StepStatus } from "ts-agent-lib";
import type { StepContext, StepHandler, StructuredLlmClient } from "ts-agent-lib";
import { runWithStepTelemetry, type NerStepTelemetry, type StepTelemetrySink } from "./events.js";
import {
    LabelExtractionSchema,
    TaggedEntityByLabelSchema,
    TrainingRecordSchema,
    type EntitySpan,
    type InferenceInput,
    type LabelExtraction,
    type TrainingRecord,

} from "./types.js";


const EXTRACT_STEP_PREFIX = "extract:";

export interface LabelStep {
    label: string;
    systemPrompt: string;
}

export function buildInitialStepTelemetry(params: {
    input: InferenceInput;
    model: string;
    labelSteps: LabelStep[];
    mergeStepId: string;
}): NerStepTelemetry[] {
    const extractTelemetry = params.labelSteps.map((labelStep) => {
        const stepId = toExtractStepId(labelStep.label);
        return {
            stepId,
            action: stepId,
            label: labelStep.label,
            input: buildExtractStepTelemetryInput({
                input: params.input,
                model: params.model,
                labelStep
            })
        } satisfies NerStepTelemetry;
    });

    return [
        ...extractTelemetry,
        {
            stepId: params.mergeStepId,
            action: params.mergeStepId,
            input: buildMergeStepTelemetryInput({
                input: params.input,
                labelSteps: params.labelSteps
            })
        }
    ];
}


export function createMergeHandler(params: {
    input: InferenceInput;
    labelSteps: LabelStep[];
    onStepTelemetry?: StepTelemetrySink;
}): StepHandler {
    return async (step, ctx) => {
        const dependenciesByLabel = Object.fromEntries(
            params.labelSteps.map((labelStep) => [
                labelStep.label,
                ctx.requireResult(toExtractStepId(labelStep.label)).output
            ])
        );

        const output = await runWithStepTelemetry({
            sink: params.onStepTelemetry,
            stepId: step.id,
            action: step.action,
            input: buildMergeStepTelemetryInput({
                input: params.input,
                labelSteps: params.labelSteps,
                dependenciesByLabel
            }),
            run: async () => buildTrainingRecord(ctx, params.input, params.labelSteps)
        });

        return {
            stepId: step.id,
            status: StepStatus.COMPLETED,
            output
        };
    };
}

export function createExtractHandler(
    params: {
        input: InferenceInput;
        model: string;
        llm: StructuredLlmClient;
        onStepTelemetry?: StepTelemetrySink;
    },
    labelStep: LabelStep
): StepHandler {
    const telemetryInput = buildExtractStepTelemetryInput({
        input: params.input,
        model: params.model,
        labelStep
    });
    const schemaName = telemetryInput.schema.name;
    const schema = telemetryInput.schema.schema;

    return async (step) => {
        const output = await runWithStepTelemetry({
            sink: params.onStepTelemetry,
            stepId: step.id,
            action: step.action,
            label: labelStep.label,
            input: telemetryInput,
            run: async () => {
                const extraction = parseLabelExtraction(
                    await params.llm.inferStructured<LabelExtraction>({
                        model: params.model,
                        systemPrompt: labelStep.systemPrompt,
                        userPrompt: params.input,
                        schema: { name: schemaName, schema },
                        outputSchema: LabelExtractionSchema
                    }),
                    labelStep.label
                );

                assertMatchesAreExact(extraction, params.input);
                return extraction;
            }
        });

        return {
            stepId: step.id,
            status: StepStatus.COMPLETED,
            output
        };
    };
}

export function buildMergeStepTelemetryInput(params: {
    input: InferenceInput;
    labelSteps: LabelStep[];
    dependenciesByLabel?: Record<string, unknown>;
}): {
    inputText: InferenceInput;
    dependencyStepIds: string[];
    dependenciesByLabel: Record<string, unknown>;
} {
    return {
        inputText: params.input,
        dependencyStepIds: params.labelSteps.map((labelStep) => toExtractStepId(labelStep.label)),
        dependenciesByLabel: params.dependenciesByLabel ?? {}
    };
}

export function buildExtractStepTelemetryInput(params: {
    input: InferenceInput;
    model: string;
    labelStep: LabelStep;
}): {
    model: string;
    systemPrompt: string;
    userPrompt: InferenceInput;
    schema: {
        name: string;
        schema: Record<string, unknown>;
    };
} {
    const schemaName = `ner_label_extraction_${toSchemaToken(params.labelStep.label)}`;
    const schema = buildLabelExtractionJsonSchema(params.labelStep.label);

    return {
        model: params.model,
        systemPrompt: params.labelStep.systemPrompt,
        userPrompt: params.input,
        schema: { name: schemaName, schema }
    };
}

function buildTrainingRecord(
    ctx: StepContext,
    input: InferenceInput,
    labelSteps: LabelStep[]
): TrainingRecord {
    const entities = TaggedEntityByLabelSchema.parse(
        Object.fromEntries(
            labelSteps.map((labelStep) => {
                const extraction = parseLabelExtraction(
                    ctx.requireResult(toExtractStepId(labelStep.label)).output,
                    labelStep.label
                );

                return [
                    labelStep.label,
                    {
                        label: extraction.label,
                        confidence: extraction.confidence,
                        spans: buildTaggedSpans(extraction.matches, input)
                    }
                ];
            })
        )
    );

    return TrainingRecordSchema.parse({
        inputText: input,
        entities
    });
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

export function toExtractStepId(label: string): string {
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
