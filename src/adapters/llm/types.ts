import type { z } from "zod";

export interface JsonSchemaSpec {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface StructuredLlmRequest<T> {
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schema: JsonSchemaSpec;
  readonly outputSchema: z.ZodType<T>;
}

export interface StructuredLlmClient {
  inferStructured<T>(request: StructuredLlmRequest<T>): Promise<T>;
}
