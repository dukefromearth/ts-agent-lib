import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlEventObserver, OverflowPolicy } from "../src/index";

describe("JsonlEventObserver", () => {
  it("writes execution events as NDJSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ts-agent-lib-jsonl-"));
    const outputPath = path.join(dir, "events.ndjson");

    try {
      const observer = new JsonlEventObserver(outputPath);
      await observer.onEvent({
        type: "execution_started",
        executionId: "exec-1",
        ts: new Date("2026-01-01T00:00:00.000Z"),
        startedAt: new Date("2026-01-01T00:00:00.000Z")
      });

      const raw = await readFile(outputPath, "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { type: string; executionId: string };
      expect(parsed.type).toBe("execution_started");
      expect(parsed.executionId).toBe("exec-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports custom serialization and observer options", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ts-agent-lib-jsonl-"));
    const outputPath = path.join(dir, "events.ndjson");

    try {
      const observer = new JsonlEventObserver(outputPath, {
        maxQueueSize: 10,
        overflowPolicy: OverflowPolicy.BLOCK,
        serialize: (event) => `event=${event.type}`
      });

      await observer.onEvent({
        type: "step_scheduled",
        executionId: "exec-2",
        ts: new Date("2026-01-01T00:00:00.000Z"),
        stepId: "a"
      });

      const raw = await readFile(outputPath, "utf8");
      expect(raw.trim()).toBe("event=step_scheduled");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
