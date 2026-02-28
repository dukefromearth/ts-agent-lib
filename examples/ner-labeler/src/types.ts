import { z } from "zod";

export const LabelNameSchema = z.string().min(1);

export const InferenceInputSchema = z.string().min(1);

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

export const EntitySpanSchema = z
  .object({
    text: z.string().min(1),
    start: z.number().int().min(0),
    end: z.number().int().min(1)
  })
  .superRefine((span, ctx) => {
    if (span.end <= span.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "end must be greater than start"
      });
    }
  });

export type EntitySpan = z.infer<typeof EntitySpanSchema>;

export const TaggedLabelEntitySchema = z.object({
  label: LabelNameSchema,
  confidence: z.number().min(0).max(1),
  spans: z.array(EntitySpanSchema)
});

export type TaggedLabelEntity = z.infer<typeof TaggedLabelEntitySchema>;

export const TaggedEntityByLabelSchema = z
  .record(LabelNameSchema, TaggedLabelEntitySchema)
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

export type TaggedEntityByLabel = z.infer<typeof TaggedEntityByLabelSchema>;

export const TrainingRecordSchema = z.object({
  inputText: z.string(),
  entities: TaggedEntityByLabelSchema
});

export type TrainingRecord = z.infer<typeof TrainingRecordSchema>;
