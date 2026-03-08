import { measureTextPx } from "@/lib/textLayout";
import { normalizeHexColor, normalizeSegments, type TextSegment } from "@/lib/richTextSegments";

type WrapToken =
  | {
      kind: "newline";
    }
  | {
      kind: "space" | "word";
      text: string;
      color: string;
    };

export type RichLinePart = {
  text: string;
  color: string;
  widthPx: number;
};

export type RichWrappedLine = {
  text: string;
  widthPx: number;
  parts: RichLinePart[];
};

type WrapInput = {
  segments: TextSegment[];
  maxWidthPx: number;
  font: Parameters<typeof measureTextPx>[1];
  fontSizePx: number;
  letterSpacingPx: number;
  defaultColor?: string;
};

function splitLongWord(
  word: string,
  maxWidthPx: number,
  font: Parameters<typeof measureTextPx>[1],
  fontSizePx: number,
  letterSpacingPx: number
): string[] {
  const out: string[] = [];
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

    out.push(word.slice(cursor, lastFit));
    cursor = lastFit;
  }

  return out;
}

function tokenizeRichSegments(segments: TextSegment[], defaultColor: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  const normalized = normalizeSegments(segments, defaultColor);
  const re = /(\r\n|\n|\u2028|[^\S\r\n\u2028]+|[^\s\r\n\u2028]+)/g;

  for (const segment of normalized) {
    const color = normalizeHexColor(segment.color, defaultColor);
    const parts = segment.text.match(re) ?? [];
    for (const part of parts) {
      if (part === "\r\n" || part === "\n" || part === "\u2028") {
        tokens.push({ kind: "newline" });
        continue;
      }
      if (/^[^\S\r\n\u2028]+$/.test(part)) {
        tokens.push({
          kind: "space",
          text: " ",
          color
        });
        continue;
      }
      tokens.push({
        kind: "word",
        text: part,
        color
      });
    }
  }

  return tokens;
}

export function wrapRichTextSegmentsByWords(input: WrapInput): RichWrappedLine[] {
  const safeDefaultColor = normalizeHexColor(input.defaultColor ?? "#000000", "#000000");
  const safeWidth = Math.max(1, input.maxWidthPx);
  const tokens = tokenizeRichSegments(input.segments, safeDefaultColor);
  const lines: RichWrappedLine[] = [];
  let line: RichWrappedLine = {
    text: "",
    widthPx: 0,
    parts: []
  };

  const pushLine = () => {
    line.widthPx = measureTextPx(line.text, input.font, input.fontSizePx, input.letterSpacingPx);
    lines.push(line);
    line = {
      text: "",
      widthPx: 0,
      parts: []
    };
  };

  const appendPart = (text: string, color: string) => {
    if (!text) return;
    const safeColor = normalizeHexColor(color, safeDefaultColor);
    const prev = line.parts[line.parts.length - 1];
    if (prev && prev.color === safeColor) {
      prev.text += text;
      prev.widthPx = measureTextPx(prev.text, input.font, input.fontSizePx, input.letterSpacingPx);
    } else {
      line.parts.push({
        text,
        color: safeColor,
        widthPx: measureTextPx(text, input.font, input.fontSizePx, input.letterSpacingPx)
      });
    }
    line.text += text;
    line.widthPx = measureTextPx(line.text, input.font, input.fontSizePx, input.letterSpacingPx);
  };

  for (const token of tokens) {
    if (token.kind === "newline") {
      pushLine();
      continue;
    }

    if (token.kind === "space") {
      if (!line.text) continue;
      const candidate = `${line.text}${token.text}`;
      const candidateWidth = measureTextPx(candidate, input.font, input.fontSizePx, input.letterSpacingPx);
      if (candidateWidth <= safeWidth) {
        appendPart(token.text, token.color);
      } else {
        pushLine();
      }
      continue;
    }

    let word = token.text;
    while (word.length > 0) {
      const candidate = `${line.text}${word}`;
      const candidateWidth = measureTextPx(candidate, input.font, input.fontSizePx, input.letterSpacingPx);
      if (candidateWidth <= safeWidth) {
        appendPart(word, token.color);
        word = "";
        continue;
      }

      if (line.text) {
        pushLine();
        continue;
      }

      const chunks = splitLongWord(
        word,
        safeWidth,
        input.font,
        input.fontSizePx,
        input.letterSpacingPx
      );

      if (chunks.length === 0) {
        break;
      }

      const [head, ...tail] = chunks;
      appendPart(head, token.color);
      word = tail.join("");
      if (word.length > 0) {
        pushLine();
      }
    }
  }

  if (lines.length === 0 || line.text || line.parts.length === 0) {
    pushLine();
  }

  return lines.length > 0
    ? lines
    : [
        {
          text: "",
          widthPx: 0,
          parts: []
        }
      ];
}
