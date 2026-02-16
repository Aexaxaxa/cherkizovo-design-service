import { readFile } from "node:fs/promises";
import { parse, type Font } from "opentype.js";

const fontCache = new Map<string, Promise<Font>>();

type TruncateOptions = {
  maxWidthPx?: number;
  font?: Font;
  fontSizePx?: number;
  letterSpacingPx?: number;
  ellipsis?: string;
};

export async function loadFontCached(ttfPath: string): Promise<Font> {
  const cached = fontCache.get(ttfPath);
  if (cached) return cached;

  const promise = readFile(ttfPath).then((buffer) => {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    return parse(arrayBuffer);
  });

  fontCache.set(ttfPath, promise);
  return promise;
}

export function measureTextPx(
  text: string,
  font: Font,
  fontSizePx: number,
  letterSpacingPx: number
): number {
  if (!text) return 0;
  const baseWidth = font.getAdvanceWidth(text, fontSizePx, { kerning: true });
  const spacing = Math.max(0, text.length - 1) * letterSpacingPx;
  return baseWidth + spacing;
}

function splitLongWord(
  word: string,
  maxWidthPx: number,
  font: Font,
  fontSizePx: number,
  letterSpacingPx: number
): string[] {
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < word.length) {
    let end = cursor + 1;
    let lastFit = cursor;
    while (end <= word.length) {
      const chunk = word.slice(cursor, end);
      const width = measureTextPx(chunk, font, fontSizePx, letterSpacingPx);
      if (width <= maxWidthPx) {
        lastFit = end;
        end += 1;
      } else {
        break;
      }
    }

    if (lastFit === cursor) {
      lastFit = cursor + 1;
    }

    parts.push(word.slice(cursor, lastFit));
    cursor = lastFit;
  }

  return parts;
}

export function wrapTextByWords(
  text: string,
  maxWidthPx: number,
  font: Font,
  fontSizePx: number,
  letterSpacingPx: number
): string[] {
  const paragraphs = text.split(/\r\n|\n|\u2028/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureTextPx(candidate, font, fontSizePx, letterSpacingPx) <= maxWidthPx) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = "";
      }

      if (measureTextPx(word, font, fontSizePx, letterSpacingPx) <= maxWidthPx) {
        current = word;
        continue;
      }

      const chunks = splitLongWord(word, maxWidthPx, font, fontSizePx, letterSpacingPx);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (i < chunks.length - 1) {
          lines.push(chunk);
        } else {
          current = chunk;
        }
      }
    }

    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

export function truncateLines(lines: string[], maxLines: number, options: TruncateOptions = {}): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const truncated = lines.slice(0, maxLines);
  const ellipsis = options.ellipsis ?? "…";
  let last = `${truncated[maxLines - 1]}${ellipsis}`;

  if (
    typeof options.maxWidthPx === "number" &&
    options.font &&
    typeof options.fontSizePx === "number" &&
    typeof options.letterSpacingPx === "number"
  ) {
    while (
      last.length > 0 &&
      measureTextPx(last, options.font, options.fontSizePx, options.letterSpacingPx) >
        options.maxWidthPx
    ) {
      const base = last.slice(0, -ellipsis.length - 1);
      last = `${base}${ellipsis}`;
      if (base.length === 0) break;
    }
  }

  truncated[maxLines - 1] = last;
  return truncated;
}
