import { InferenceInputSchema, type InferenceInput } from "./types.js";

export function usageText(): string {
  return [
    "Usage:",
    "  npm run example:ner -- \"<text>\"",
    "Options:",
    "  <text>            Required input text to label.",
    "  --help            Show this help text."
  ].join("\n");
}

export function parseInputArgs(argv: string[]): InferenceInput {
  const inputText = parseArgs(argv);
  return InferenceInputSchema.parse(inputText);
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function parseArgs(argv: string[]): string {
  if (argv.length !== 1) {
    throw new UsageError(`exactly one text input is required\n\n${usageText()}`);
  }

  const inputText = argv[0]?.trim();
  if (!inputText || inputText.startsWith("--")) {
    throw new UsageError(`exactly one text input is required\n\n${usageText()}`);
  }

  return inputText;
}
