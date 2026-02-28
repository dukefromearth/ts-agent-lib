import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { renderJinjaTemplate } from "../src/jinja.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultBaseSystemPromptPath = path.resolve(__dirname, "./base_system.jinja");
const defaultLabelsDir = path.resolve(__dirname, "./labels");

const HandlerNameSchema = z.string().min(1);

export const PromptHandlerSchema = z.object({
  handler_name: HandlerNameSchema,
  system_prompt: z.string().min(1)
});

export const PromptHandlerListSchema = z.array(PromptHandlerSchema).min(1);

export type PromptHandler = z.infer<typeof PromptHandlerSchema>;
export type PromptHandlerList = z.infer<typeof PromptHandlerListSchema>;

export async function loadPromptHandlers(options?: {
  baseSystemPromptPath?: string;
  labelsDir?: string;
}): Promise<PromptHandlerList> {
  const baseSystemPromptPath = options?.baseSystemPromptPath ?? defaultBaseSystemPromptPath;
  const labelsDir = options?.labelsDir ?? defaultLabelsDir;
  const baseTemplate = await readFile(baseSystemPromptPath, "utf8");

  const entries = await readdir(labelsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jinja"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`no label prompt files found in '${labelsDir}'`);
  }

  const labels = files.map((file) => HandlerNameSchema.parse(path.basename(file, ".jinja").trim()));
  const prompts: PromptHandler[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const filename = files[index];
    const label = labels[index];
    const labelInstructions = (await readFile(path.join(labelsDir, filename), "utf8")).trim();

    if (!labelInstructions) {
      throw new Error(`label prompt '${path.join(labelsDir, filename)}' is empty`);
    }

    prompts.push(
      PromptHandlerSchema.parse({
        handler_name: label,
        system_prompt: renderJinjaTemplate(baseTemplate, {
          label,
          expert_role: `${label} entity extraction`,
          label_instructions: labelInstructions,
          allowed_labels: labels
        })
      })
    );
  }

  return PromptHandlerListSchema.parse(prompts);
}
