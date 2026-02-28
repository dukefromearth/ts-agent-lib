import { Chalk } from "chalk";
import type { EntitySpan, TrainingRecord } from "./types.js";

const color = new Chalk({ level: 3 });

const OVERLAP_KEY = "__overlap__";
const OVERLAP_LABEL = "overlap (2+ labels)";
const OVERLAP_RGB = { r: 255, g: 140, b: 0 };

type SegmentKey = string | typeof OVERLAP_KEY | null;
type TextStyler = (value: string) => string;

interface SpanWithLabel extends EntitySpan {
  label: string;
}

interface TextSegment {
  text: string;
  key: SegmentKey;
}

export interface RenderedNerOutput {
  coloredInputText: string;
  key: string;
}

export function renderNerOutput(record: TrainingRecord): RenderedNerOutput {
  const labels = Object.keys(record.entities).sort();
  const styles = new Map<string, TextStyler>(
    labels.map((label) => [label, createStyleFromLabel(label)])
  );

  const overlapStyle = createStyleFromRgb(OVERLAP_RGB.r, OVERLAP_RGB.g, OVERLAP_RGB.b);
  styles.set(OVERLAP_KEY, overlapStyle);

  const spans = collectSpans(record);
  const segments = buildSegments(record.inputText, spans);

  const coloredInputText = segments
    .map((segment) => {
      const style = segment.key ? styles.get(segment.key) : undefined;
      return style ? style(segment.text) : segment.text;
    })
    .join("");

  const keyLines = labels.map((label) => {
    const style = styles.get(label);
    const spanCount = record.entities[label]?.spans.length ?? 0;
    const suffix = spanCount === 1 ? "span" : "spans";
    return `${style ? style("  ") : "  "} ${label} (${spanCount} ${suffix})`;
  });

  keyLines.push(`${overlapStyle("  ")} ${OVERLAP_LABEL}`);

  return {
    coloredInputText,
    key: keyLines.join("\n")
  };
}

function collectSpans(record: TrainingRecord): SpanWithLabel[] {
  const spans: SpanWithLabel[] = [];

  for (const [label, entity] of Object.entries(record.entities)) {
    for (const span of entity.spans) {
      spans.push({ ...span, label });
    }
  }

  return spans;
}

function buildSegments(text: string, spans: SpanWithLabel[]): TextSegment[] {
  const boundaries = collectBoundaries(text.length, spans);
  const starts = new Map<number, string[]>();
  const ends = new Map<number, string[]>();

  for (const span of spans) {
    const start = clamp(span.start, 0, text.length);
    const end = clamp(span.end, 0, text.length);

    if (end <= start) {
      continue;
    }

    appendToMap(starts, start, span.label);
    appendToMap(ends, end, span.label);
  }

  const segments: TextSegment[] = [];
  const activeCounts = new Map<string, number>();

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? text.length;

    decrementCounts(activeCounts, ends.get(start));
    incrementCounts(activeCounts, starts.get(start));

    if (end <= start) {
      continue;
    }

    const piece = text.slice(start, end);
    const labels = Array.from(activeCounts.entries())
      .filter(([, count]) => count > 0)
      .map(([label]) => label)
      .sort();

    segments.push({
      text: piece,
      key: toSegmentKey(labels)
    });
  }

  return segments;
}

function collectBoundaries(textLength: number, spans: SpanWithLabel[]): number[] {
  const boundaries = new Set<number>([0, textLength]);

  for (const span of spans) {
    boundaries.add(clamp(span.start, 0, textLength));
    boundaries.add(clamp(span.end, 0, textLength));
  }

  return Array.from(boundaries).sort((a, b) => a - b);
}

function incrementCounts(activeCounts: Map<string, number>, labels?: string[]): void {
  if (!labels) {
    return;
  }

  for (const label of labels) {
    activeCounts.set(label, (activeCounts.get(label) ?? 0) + 1);
  }
}

function decrementCounts(activeCounts: Map<string, number>, labels?: string[]): void {
  if (!labels) {
    return;
  }

  for (const label of labels) {
    const next = (activeCounts.get(label) ?? 0) - 1;
    if (next <= 0) {
      activeCounts.delete(label);
      continue;
    }

    activeCounts.set(label, next);
  }
}

function appendToMap(map: Map<number, string[]>, key: number, label: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(label);
    return;
  }

  map.set(key, [label]);
}

function toSegmentKey(labels: string[]): SegmentKey {
  if (labels.length === 0) {
    return null;
  }

  if (labels.length === 1) {
    return labels[0] ?? null;
  }

  return OVERLAP_KEY;
}

function createStyleFromLabel(label: string): TextStyler {
  const hash = hashLabel(label);
  const hue = hash % 360;
  const saturation = 68 + ((hash >>> 9) % 17);
  const lightness = 44 + ((hash >>> 16) % 14);

  const rgb = hslToRgb(hue, saturation, lightness);
  return createStyleFromRgb(rgb.r, rgb.g, rgb.b);
}

function createStyleFromRgb(r: number, g: number, b: number): TextStyler {
  const bg = color.bgRgb(r, g, b);
  return isLightColor(r, g, b) ? bg.black : bg.white;
}

function hashLabel(input: string): number {
  let hash = 2166136261;

  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hueSection = h / 60;
  const x = chroma * (1 - Math.abs((hueSection % 2) - 1));

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (hueSection >= 0 && hueSection < 1) {
    rPrime = chroma;
    gPrime = x;
  } else if (hueSection >= 1 && hueSection < 2) {
    rPrime = x;
    gPrime = chroma;
  } else if (hueSection >= 2 && hueSection < 3) {
    gPrime = chroma;
    bPrime = x;
  } else if (hueSection >= 3 && hueSection < 4) {
    gPrime = x;
    bPrime = chroma;
  } else if (hueSection >= 4 && hueSection < 5) {
    rPrime = x;
    bPrime = chroma;
  } else {
    rPrime = chroma;
    bPrime = x;
  }

  const m = lightness - chroma / 2;

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255)
  };
}

function isLightColor(r: number, g: number, b: number): boolean {
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
