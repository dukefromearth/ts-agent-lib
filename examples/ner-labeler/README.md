# NER Labeler Scaffold (Adapter-First)

This example shows a production-style NER labeling workflow with:

- a DAG plan that creates one OpenAI LLM step per label prompt file
- strict structured output with JSON schema + zod validation
- a merge step that depends on every label step before returning output
- package-style SDK consumption (`import ... from "ts-agent-lib"`)

This is intentionally a different use case from the repository docs examples.

## Prompt-driven labels (no code edits)

Labels are driven entirely by files under `prompts/labels/`.

- Base prompt: `prompts/base_system.jinja`
- Label prompts: `prompts/labels/*.jinja`
- Label handle = filename (for example `person_name.jinja` -> `label=person_name`)
- Label instructions = file body

To add a label, add a new file like `prompts/labels/booking_occurred.jinja`.
To remove a label, delete its file.

The pipeline automatically:

1. reads all label prompt files
2. builds one DAG step per label
3. runs all label steps in parallel
4. runs a merge step that depends on all label steps

`expert_role` is derived automatically as `${label} entity extraction`.

## Why this structure

- `src/pipeline.ts`: one `runNerLabeling(...)` function with clear plan-building + lambda handlers
- `prompts/prompt_handlers.ts`: zod-typed prompt handler list (`{ handler_name, system_prompt }[]`)
- `OpenAiStructuredLlmClient` from `ts-agent-lib`: OpenAI structured-output adapter
- `JsonlEventObserver` from `ts-agent-lib`: event telemetry adapter
- `src/cli.ts`: input parsing and validation (`--text` required)
- `src/env.ts`: lightweight `.env` loader

## Run (no build step)

1. Install dependencies once:

```bash
npm install
```

2. Create local env file:

```bash
cp examples/ner-labeler/.env.example examples/ner-labeler/.env
```

3. Edit `examples/ner-labeler/.env` and set `OPENAI_API_KEY`.

4. Run with required input text:

```bash
npm run example:ner -- --text "Find entities in this text: Jordan Lee at City Library tomorrow 4:30 PM @coach_sam."
```

Optional context:

```bash
npm run example:ner -- \
  --text "Can we meet at City Library tomorrow at 4:30 PM?" \
  --context "Last week we met at North Hall." \
  --context "Email me at sam@example.org"
```

Or run directly from the workspace package:

```bash
npm run --workspace @ts-agent-lib/example-ner-labeler dev -- --text "..."
```

## Required input contract

- `--text` is required.
- `--context` can be supplied 0..N times.
- Optional: `--input-id`

## Output contract

For each label, the model returns:

- `matches`: exact substrings from input/context, or `["none"]`
- `confidence`: `0.0` to `1.0`

The final merged output is a typed `TrainingRecord` with `entities` keyed by label name.

## Output files

- event telemetry: `examples/ner-labeler/output/events.ndjson`

`events.ndjson` includes step completion payloads, including the final merged training record from `merge_entity_labels`.

## Notes for production

- Build downstream ingestion from observer output (`events.ndjson`) into S3/Kafka/Snowflake.
- Keep `response_format.json_schema.strict = true` and zod parsing to enforce runtime contracts.
