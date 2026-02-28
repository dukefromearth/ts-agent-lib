import { describe, expect, it } from "vitest";
import { renderNerOutput } from "../examples/ner-labeler/src/render";
import type { TrainingRecord } from "../examples/ner-labeler/src/types";

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function extractBackgroundRgb(value: string): string | null {
  const match = value.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
  if (!match) {
    return null;
  }

  return `${match[1]},${match[2]},${match[3]}`;
}

describe("renderNerOutput", () => {
  it("renders deterministic output for the same labeled record", () => {
    const record: TrainingRecord = {
      inputText: "Jordan Lee met Jordan @coach at Library",
      entities: {
        person_name: {
          label: "person_name",
          confidence: 0.9,
          spans: [
            { text: "Jordan", start: 0, end: 6 },
            { text: "Jordan", start: 15, end: 21 }
          ]
        },
        contact_handle: {
          label: "contact_handle",
          confidence: 0.86,
          spans: [{ text: "@coach", start: 22, end: 28 }]
        }
      }
    };

    const once = renderNerOutput(record);
    const twice = renderNerOutput(record);

    expect(once.coloredInputText).toBe(twice.coloredInputText);
    expect(once.key).toBe(twice.key);
    expect(stripAnsi(once.coloredInputText)).toBe(record.inputText);
  });

  it("uses a dedicated overlap color when spans overlap", () => {
    const record: TrainingRecord = {
      inputText: "abcde",
      entities: {
        alpha: {
          label: "alpha",
          confidence: 0.92,
          spans: [{ text: "abc", start: 0, end: 3 }]
        },
        beta: {
          label: "beta",
          confidence: 0.88,
          spans: [{ text: "cde", start: 2, end: 5 }]
        }
      }
    };

    const rendered = renderNerOutput(record);

    expect(stripAnsi(rendered.coloredInputText)).toBe("abcde");

    const keyLines = rendered.key.split("\n");
    expect(keyLines).toHaveLength(3);

    const labelColors = keyLines.slice(0, 2).map((line) => extractBackgroundRgb(line));
    const overlapColor = extractBackgroundRgb(keyLines[2] ?? "");

    expect(overlapColor).not.toBeNull();
    expect(labelColors).not.toContain(overlapColor);
    expect(stripAnsi(keyLines[2] ?? "")).toContain("overlap (2+ labels)");
  });
});
