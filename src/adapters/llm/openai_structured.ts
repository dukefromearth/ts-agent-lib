import OpenAI from "openai";
import { z } from "zod";
import type { StructuredLlmClient, StructuredLlmRequest } from "./types";

const OpenAiChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable()
        })
      })
    )
    .min(1)
});

type OpenAiChatCompletion = z.infer<typeof OpenAiChatCompletionSchema>;

export interface OpenAiStructuredLlmClientOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  temperature?: number;
  client?: OpenAI;
}

export class OpenAiStructuredLlmClient implements StructuredLlmClient {
  private readonly client: OpenAI;
  private readonly temperature?: number;

  constructor(options: OpenAiStructuredLlmClientOptions = {}) {
    if (options.temperature != null) {
      this.temperature = options.temperature;
    }
    if (options.client) {
      this.client = options.client;
      return;
    }

    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
      project: options.project
    });
  }

  async inferStructured<T>(request: StructuredLlmRequest<T>): Promise<T> {
    const completion = await this.client.chat.completions.create({
      model: request.model,
      temperature: this.temperature,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schema.name,
          strict: true,
          schema: request.schema.schema
        }
      }
    });

    const payload = OpenAiChatCompletionSchema.parse(completion as OpenAiChatCompletion);
    const content = payload.choices[0]?.message.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI response did not include JSON content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI response content was not valid JSON: ${detail}`);
    }

    return request.outputSchema.parse(parsed);
  }
}
