import { z } from "zod";

export const LabelNameSchema = z.string().min(1);

export const InferenceInputSchema = z.object({
  inputId: z.string(),
  inputText: z.string().min(1),
  contextTexts: z.array(z.string())
});

export type InferenceInput = z.infer<typeof InferenceInputSchema>;

export const LabelExtractionSchema = z
  .object({
    label: LabelNameSchema,
    matches: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1)
  })
  .superRefine((value, ctx) => {
    const hasNone = value.matches.some((entry) => entry.toLowerCase() === "none");
    if (hasNone && value.matches.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "matches must be either ['none'] or one or more exact strings"
      });
    }
  });

export type LabelExtraction = z.infer<typeof LabelExtractionSchema>;

export const LabelExtractionByLabelSchema = z
  .record(LabelNameSchema, LabelExtractionSchema)
  .superRefine((entities, ctx) => {
    for (const [label, extraction] of Object.entries(entities)) {
      if (extraction.label !== label) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entity key '${label}' does not match extraction label '${extraction.label}'`
        });
      }
    }
  });

export type LabelExtractionByLabel = z.infer<typeof LabelExtractionByLabelSchema>;

export const TrainingRecordSchema = z.object({
  inputId: z.string(),
  inputText: z.string(),
  contextTexts: z.array(z.string()),
  entities: LabelExtractionByLabelSchema
});

export type TrainingRecord = z.infer<typeof TrainingRecordSchema>;
