import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlEventObserver, OpenAiStructuredLlmClient } from "ts-agent-lib";
import { UsageError, parseInputArgs, usageText } from "./cli.js";
import { loadEnvFile } from "./env.js";
import { runNerLabeling } from "./pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputDir = path.resolve(__dirname, "../output");
const eventsPath = path.resolve(outputDir, "events.ndjson");
const envPath = path.resolve(__dirname, "../.env");

async function main(): Promise<void> {
  await loadEnvFile(envPath);

  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usageText());
    return;
  }

  const input = parseInputArgs(args);
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  await mkdir(outputDir, { recursive: true });

  const llm = new OpenAiStructuredLlmClient();

  const observer = new JsonlEventObserver(eventsPath);
  await observer.start();

  try {
    const record = await runNerLabeling({
      input,
      model,
      llm,
      onEvent: (event) => observer.onEvent(event),
      execution: {
        maxParallelSteps: 6,
        failFast: true
      }
    });

    console.log("Model:", model);
    console.log(JSON.stringify(record, null, 2));
    console.log(`Execution events written to: ${eventsPath}`);
  } finally {
    await observer.stop();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message || usageText());
    process.exitCode = 1;
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
