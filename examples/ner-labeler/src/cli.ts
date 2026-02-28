import { InferenceInputSchema, type InferenceInput } from "./types.js";

type ParsedArgs = {
  text?: string;
  contextTexts: string[];
  inputId?: string;
};

export function usageText(): string {
  return [
    "Usage:",
    "  npm run example:ner -- --text \"<text>\" [--context \"<context>\"]...",
    "Options:",
    "  --text            Required input text to label.",
    "  --context         Optional context text (repeatable).",
    "  --input-id        Optional input id (default: generated).",
    "  --help            Show this help text."
  ].join("\n");
}

export function parseInputArgs(argv: string[]): InferenceInput {
  const parsed = parseArgs(argv);

  const inputText = parsed.text?.trim();
  if (!inputText) {
    throw new UsageError(`--text is required\n\n${usageText()}`);
  }

  const input = {
    inputId: parsed.inputId?.trim() || `input-${Date.now()}`,
    inputText,
    contextTexts: parsed.contextTexts
  };

  return InferenceInputSchema.parse(input);
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    contextTexts: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      throw new UsageError(`unexpected argument '${token}'\n\n${usageText()}`);
    }

    const key = token.slice(2);
    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`missing value for '--${key}'\n\n${usageText()}`);
    }

    if (key === "text") {
      parsed.text = value;
    } else if (key === "context") {
      parsed.contextTexts.push(value);
    } else if (key === "input-id") {
      parsed.inputId = value;
    } else {
      throw new UsageError(`unknown option '--${key}'\n\n${usageText()}`);
    }

    index += 1;
  }

  return parsed;
}
