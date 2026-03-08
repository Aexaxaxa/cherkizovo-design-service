export type TextSegment = {
  text: string;
  color: string;
};

const HEX_3_RE = /^#([0-9a-f]{3})$/i;
const HEX_6_RE = /^#([0-9a-f]{6})$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeHexColor(input: unknown, fallback = "#000000"): string {
  const fallbackSafe = typeof fallback === "string" ? fallback : "#000000";
  const source = typeof input === "string" ? input.trim() : "";
  if (!source) return normalizeHexColor(fallbackSafe, "#000000");

  const short = source.match(HEX_3_RE);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  const full = source.match(HEX_6_RE);
  if (full) {
    return `#${full[1]}`.toUpperCase();
  }

  if (source.toLowerCase().startsWith("rgb")) {
    const numbers = source
      .replace(/[^\d.,]/g, "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    if (numbers.length >= 3) {
      const r = clamp(Math.round(numbers[0]), 0, 255).toString(16).padStart(2, "0");
      const g = clamp(Math.round(numbers[1]), 0, 255).toString(16).padStart(2, "0");
      const b = clamp(Math.round(numbers[2]), 0, 255).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`.toUpperCase();
    }
  }

  if (fallbackSafe === "#000000" && source === fallbackSafe) return "#000000";
  return normalizeHexColor(fallbackSafe, "#000000");
}

export function normalizeSegments(input: unknown, fallbackColor = "#000000"): TextSegment[] {
  if (!Array.isArray(input)) return [];

  const out: TextSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const textRaw = "text" in raw ? raw.text : "";
    const colorRaw = "color" in raw ? raw.color : fallbackColor;
    const text = typeof textRaw === "string" ? textRaw : "";
    if (!text) continue;
    const color = normalizeHexColor(colorRaw, fallbackColor);
    const prev = out[out.length - 1];
    if (prev && prev.color === color) {
      prev.text += text;
    } else {
      out.push({ text, color });
    }
  }

  return out;
}

export function getPlainTextFromSegments(segments: TextSegment[]): string {
  if (!Array.isArray(segments) || segments.length === 0) return "";
  return segments.map((segment) => segment.text ?? "").join("");
}

function clampRange(start: number, end: number, total: number): { start: number; end: number } {
  const safeStart = clamp(Math.floor(Number.isFinite(start) ? start : 0), 0, total);
  const safeEnd = clamp(Math.floor(Number.isFinite(end) ? end : 0), 0, total);
  return safeStart <= safeEnd ? { start: safeStart, end: safeEnd } : { start: safeEnd, end: safeStart };
}

export function sliceSegmentsByRange(
  segments: TextSegment[],
  start: number,
  end: number,
  fallbackColor = "#000000"
): TextSegment[] {
  const normalized = normalizeSegments(segments, fallbackColor);
  const total = getPlainTextFromSegments(normalized).length;
  const range = clampRange(start, end, total);
  if (range.start >= range.end) return [];

  const out: TextSegment[] = [];
  let cursor = 0;
  for (const segment of normalized) {
    const segStart = cursor;
    const segEnd = cursor + segment.text.length;
    cursor = segEnd;
    if (segEnd <= range.start || segStart >= range.end) continue;
    const from = Math.max(range.start, segStart) - segStart;
    const to = Math.min(range.end, segEnd) - segStart;
    if (to <= from) continue;
    out.push({
      text: segment.text.slice(from, to),
      color: segment.color
    });
  }

  return normalizeSegments(out, fallbackColor);
}

export function getColorAtCharIndex(segments: TextSegment[], charIndex: number, fallbackColor = "#000000"): string {
  const normalized = normalizeSegments(segments, fallbackColor);
  if (normalized.length === 0) return normalizeHexColor(fallbackColor, "#000000");

  let cursor = 0;
  for (const segment of normalized) {
    const next = cursor + segment.text.length;
    if (charIndex >= cursor && charIndex < next) {
      return segment.color;
    }
    cursor = next;
  }

  return normalized[normalized.length - 1]?.color ?? normalizeHexColor(fallbackColor, "#000000");
}

export function getColorForInsertion(segments: TextSegment[], charIndex: number, fallbackColor = "#000000"): string {
  const normalized = normalizeSegments(segments, fallbackColor);
  const total = getPlainTextFromSegments(normalized).length;
  const safeIndex = clamp(Math.floor(Number.isFinite(charIndex) ? charIndex : 0), 0, total);

  if (safeIndex > 0) {
    return getColorAtCharIndex(normalized, safeIndex - 1, fallbackColor);
  }
  if (safeIndex < total) {
    return getColorAtCharIndex(normalized, safeIndex, fallbackColor);
  }
  return normalizeHexColor(fallbackColor, "#000000");
}

export function applyColorToRange(
  segments: TextSegment[],
  start: number,
  end: number,
  color: string,
  fallbackColor = "#000000"
): TextSegment[] {
  const normalized = normalizeSegments(segments, fallbackColor);
  const total = getPlainTextFromSegments(normalized).length;
  const range = clampRange(start, end, total);
  if (range.start >= range.end) return normalized;

  const before = sliceSegmentsByRange(normalized, 0, range.start, fallbackColor);
  const selected = sliceSegmentsByRange(normalized, range.start, range.end, fallbackColor).map((segment) => ({
    ...segment,
    color: normalizeHexColor(color, fallbackColor)
  }));
  const after = sliceSegmentsByRange(normalized, range.end, total, fallbackColor);
  return normalizeSegments([...before, ...selected, ...after], fallbackColor);
}

export function replaceTextRangeInSegments(
  segments: TextSegment[],
  start: number,
  end: number,
  insertedText: string,
  fallbackColor = "#000000"
): TextSegment[] {
  const normalized = normalizeSegments(segments, fallbackColor);
  const total = getPlainTextFromSegments(normalized).length;
  const range = clampRange(start, end, total);
  const safeInserted = typeof insertedText === "string" ? insertedText : "";

  const before = sliceSegmentsByRange(normalized, 0, range.start, fallbackColor);
  const after = sliceSegmentsByRange(normalized, range.end, total, fallbackColor);
  const inserted: TextSegment[] = [];
  if (safeInserted.length > 0) {
    inserted.push({
      text: safeInserted,
      color: getColorForInsertion(normalized, range.start, fallbackColor)
    });
  }

  return normalizeSegments([...before, ...inserted, ...after], fallbackColor);
}

export function reconcileSegmentsWithPlainText(
  previousSegments: TextSegment[],
  nextPlainText: string,
  fallbackColor = "#000000"
): TextSegment[] {
  const normalized = normalizeSegments(previousSegments, fallbackColor);
  const previousText = getPlainTextFromSegments(normalized);
  const nextText = typeof nextPlainText === "string" ? nextPlainText : "";
  if (previousText === nextText) {
    return normalized;
  }

  const maxPrefix = Math.min(previousText.length, nextText.length);
  let prefix = 0;
  while (prefix < maxPrefix && previousText[prefix] === nextText[prefix]) {
    prefix += 1;
  }

  const maxSuffix = Math.min(previousText.length - prefix, nextText.length - prefix);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldStart = prefix;
  const oldEnd = previousText.length - suffix;
  const newStart = prefix;
  const newEnd = nextText.length - suffix;
  const inserted = nextText.slice(newStart, newEnd);

  return replaceTextRangeInSegments(normalized, oldStart, oldEnd, inserted, fallbackColor);
}
