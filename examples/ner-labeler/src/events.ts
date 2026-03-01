import type { ErrorInfo, ExecutionEventType } from "ts-agent-lib";
import type { InferenceInput } from "./types.js";

export interface NerStepTelemetry {
  stepId: string;
  action: string;
  label?: string;
  input?: unknown;
  output?: unknown;
  error?: ErrorInfo;
}

export type StepTelemetrySink = (telemetry: NerStepTelemetry) => void | Promise<void>;

export function upsertStepTelemetry(
  store: Map<string, NerStepTelemetry>,
  patch: NerStepTelemetry
): NerStepTelemetry {
  const previous = store.get(patch.stepId);

  const next: NerStepTelemetry = {
    ...previous,
    ...patch,
    input: patch.input ?? previous?.input,
    output: patch.output ?? previous?.output,
    error: patch.error ?? previous?.error
  };

  store.set(patch.stepId, next);
  return next;
}

export async function emitStepTelemetry(
  sink: StepTelemetrySink | undefined,
  telemetry: NerStepTelemetry
): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink(telemetry);
  } catch {
    // Telemetry sinks are best-effort and must not affect execution behavior.
  }
}

export async function runWithStepTelemetry<T>(params: {
  sink?: StepTelemetrySink;
  stepId: string;
  action: string;
  label?: string;
  input?: unknown;
  run: () => Promise<T>;
}): Promise<T> {
  await emitStepTelemetry(params.sink, {
    stepId: params.stepId,
    action: params.action,
    label: params.label,
    input: params.input
  });

  try {
    const output = await params.run();
    await emitStepTelemetry(params.sink, {
      stepId: params.stepId,
      action: params.action,
      label: params.label,
      output
    });
    return output;
  } catch (error) {
    await emitStepTelemetry(params.sink, {
      stepId: params.stepId,
      action: params.action,
      label: params.label,
      error: toErrorInfo(error)
    });
    throw error;
  }
}

export function createNerEventSerializer(params: {
  inputText: InferenceInput;
  telemetryByStepId: ReadonlyMap<string, NerStepTelemetry>;
}): (event: ExecutionEventType) => string {
  return (event) => {
    const record: Record<string, unknown> = {
      ...event,
      runInputText: params.inputText
    };

    if ("stepId" in event) {
      const stepTelemetry = params.telemetryByStepId.get(event.stepId);
      if (stepTelemetry) {
        record.stepTelemetry = stepTelemetry;
      }
    }

    if (event.type === "execution_completed" || event.type === "execution_cancelled") {
      record.stepTelemetryById = Object.fromEntries(
        Array.from(params.telemetryByStepId.entries()).sort(([a], [b]) => a.localeCompare(b))
      );
    }

    return JSON.stringify(record);
  };
}

function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      type: error.name,
      traceback: error.stack
    };
  }

  return {
    message: String(error),
    type: "Error"
  };
}
