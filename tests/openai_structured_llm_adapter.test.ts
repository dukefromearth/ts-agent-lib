import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAiStructuredLlmClient } from "../src/index";

describe("OpenAiStructuredLlmClient", () => {
  it("forwards json schema and parses structured output", async () => {
    let seenParams: Record<string, unknown> | undefined;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            seenParams = params;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      label: "person_name",
                      matches: ["Jordan Lee"],
                      confidence: 0.91
                    })
                  }
                }
              ]
            };
          }
        }
      }
    };

    const adapter = new OpenAiStructuredLlmClient({
      client: fakeClient as unknown as any,
    });

    const output = await adapter.inferStructured({
      model: "gpt-4.1-mini",
      systemPrompt: "sys",
      userPrompt: "usr",
      schema: {
        name: "entity_extraction",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["label", "matches", "confidence"],
          properties: {
            label: { type: "string" },
            matches: { type: "array", items: { type: "string" } },
            confidence: { type: "number" }
          }
        }
      },
      outputSchema: z.object({
        label: z.string(),
        matches: z.array(z.string()),
        confidence: z.number()
      })
    });

    expect(output).toEqual({
      label: "person_name",
      matches: ["Jordan Lee"],
      confidence: 0.91
    });

    expect(seenParams).toMatchObject({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "entity_extraction",
          strict: true
        }
      }
    });
  });

  it("throws when response content is missing", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: null } }]
          })
        }
      }
    };

    const adapter = new OpenAiStructuredLlmClient({ client: fakeClient as unknown as any });

    await expect(
      adapter.inferStructured({
        model: "gpt-4.1-mini",
        systemPrompt: "sys",
        userPrompt: "usr",
        schema: { name: "x", schema: { type: "object" } },
        outputSchema: z.object({})
      })
    ).rejects.toThrow("OpenAI response did not include JSON content");
  });

  it("throws when response content is not valid JSON", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "{not-json}" } }]
          })
        }
      }
    };

    const adapter = new OpenAiStructuredLlmClient({ client: fakeClient as unknown as any });

    await expect(
      adapter.inferStructured({
        model: "gpt-4.1-mini",
        systemPrompt: "sys",
        userPrompt: "usr",
        schema: { name: "x", schema: { type: "object" } },
        outputSchema: z.object({})
      })
    ).rejects.toThrow("OpenAI response content was not valid JSON");
  });
});
