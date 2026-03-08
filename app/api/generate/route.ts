import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getEnv, isUniversalEngineEnabled } from "@/lib/env";
import { getFigmaNodePng } from "@/lib/figmaImages";
import { applyRoundedRectMask } from "@/lib/masks";
import { resolvePhotobankDownloadHref } from "@/lib/photobank";
import { getObject, getSignedGetUrl, putObject } from "@/lib/s3";
import { getFrameSnapshotKey, getSchemaSnapshotKey, readSnapshotJson, tryReadSnapshotJson } from "@/lib/snapshotStore";
import { streamToBuffer } from "@/lib/streamToBuffer";
import { getTemplateById, TPL_VK_POST_1_FIGMA, TPL_VK_POST_1_ID } from "@/lib/templates";
import { renderUniversalTemplate, validateTextLineLimits, type TextSizeAdjustMap } from "@/lib/universalEngine";
import { getPlainTextFromSegments, normalizeSegments, type TextSegment } from "@/lib/richTextSegments";
import {
  buildSvgPathsForLines,
  getFontMetricsPx,
  loadFontCached,
  measureTextPx,
  wrapTextByWords
} from "@/lib/textLayout";

export const runtime = "nodejs";

type GeneratePayload = {
  templateId?: string;
  title?: string;
  objectKey?: string;
  fields?: Record<string, string>;
  textSizeAdjust?: Record<string, unknown>;
  richText?: Record<string, unknown>;
};

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

type SchemaPayload = {
  templateId: string;
  templateName: string;
  photoFields?: Array<{
    name: string;
    nodeId: string;
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    cornerRadii?: [number, number, number, number];
  }>;
  fields: SchemaField[];
};

type PhotobankRef = {
  source: "photobank";
  path: string;
  name?: string;
  previewUrl?: string;
};

type CropPixels = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CropNorm = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type PhotoEdit = {
  cropNorm?: CropNorm;
  cropPixels?: CropPixels;
  zoom?: number;
};

type MultipartGenerateInput = {
  templateId: string;
  textFields: Record<string, string>;
  textSizeAdjust: TextSizeAdjustMap;
  richText: Record<string, TextSegment[]>;
  photoRefs: Record<string, PhotobankRef>;
  photoEdits: Record<string, PhotoEdit>;
  files: Record<string, File>;
};

type PreparedPhoto = {
  buffer: Buffer;
  mimeType: string;
};

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function parseTextSizeAdjust(raw: Record<string, unknown> | undefined): TextSizeAdjustMap {
  const out: TextSizeAdjustMap = {};
  if (!raw) return out;

  for (const [field, value] of Object.entries(raw)) {
    if (value === -1 || value === 0 || value === 1) {
      out[field] = value;
      continue;
    }
    if (typeof value === "string") {
      const numeric = Number(value);
      if (numeric === -1 || numeric === 0 || numeric === 1) {
        out[field] = numeric;
      }
    }
  }

  return out;
}

function parseRichText(raw: unknown): Record<string, TextSegment[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const out: Record<string, TextSegment[]> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const normalized = normalizeSegments(value, "#000000");
    if (getPlainTextFromSegments(normalized).length === 0) continue;
    out[field] = normalized;
  }
  return out;
}

function extFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function normalizeMimeType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const typeOnly = raw.split(";")[0]?.trim().toLowerCase();
  if (!typeOnly) return null;
  return SUPPORTED_MIME.has(typeOnly) ? typeOnly : null;
}

function inferMimeByPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

async function uploadBufferToB2(buffer: Buffer, mimeType: string): Promise<string> {
  const objectKey = `uploads/${randomUUID()}.${extFromMime(mimeType)}`;
  await putObject({
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType
  });
  return objectKey;
}

function jsonError(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function parseMultipartGenerateInput(request: Request): Promise<MultipartGenerateInput> {
  const formData = await request.formData();
  const templateId = String(formData.get("templateId") ?? "").trim();
  if (!templateId) {
    throw new Error("templateId is required");
  }

  let textFields: Record<string, string> = {};
  const rawFields = formData.get("fields");
  if (typeof rawFields === "string" && rawFields.trim()) {
    const parsed = JSON.parse(rawFields) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      textFields = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string")
      ) as Record<string, string>;
    }
  }

  let textSizeAdjust: TextSizeAdjustMap = {};
  const rawAdjust = formData.get("textSizeAdjust");
  if (typeof rawAdjust === "string" && rawAdjust.trim()) {
    const parsed = JSON.parse(rawAdjust) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      textSizeAdjust = parseTextSizeAdjust(parsed as Record<string, unknown>);
    }
  }

  let richText: Record<string, TextSegment[]> = {};
  const rawRichText = formData.get("richText");
  if (typeof rawRichText === "string" && rawRichText.trim()) {
    const parsed = JSON.parse(rawRichText) as unknown;
    richText = parseRichText(parsed);
  }

  let photoRefs: Record<string, PhotobankRef> = {};
  const rawPhotoRefs = formData.get("photoRefs");
  if (typeof rawPhotoRefs === "string" && rawPhotoRefs.trim()) {
    const parsed = JSON.parse(rawPhotoRefs) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      photoRefs = {};
      for (const [field, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object") continue;
        const source = "source" in value ? value.source : undefined;
        const path = "path" in value ? value.path : undefined;
        if (source === "photobank" && typeof path === "string" && path.trim()) {
          photoRefs[field] = {
            source: "photobank",
            path: path.trim(),
            name: "name" in value && typeof value.name === "string" ? value.name : undefined,
            previewUrl: "previewUrl" in value && typeof value.previewUrl === "string" ? value.previewUrl : undefined
          };
        }
      }
    }
  }

  let photoEdits: Record<string, PhotoEdit> = {};
  const rawPhotoEdits = formData.get("photoEdits");
  if (typeof rawPhotoEdits === "string" && rawPhotoEdits.trim()) {
    const parsed = JSON.parse(rawPhotoEdits) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      photoEdits = {};
      for (const [field, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object") continue;

        const edit: PhotoEdit = {
          zoom: "zoom" in value && typeof value.zoom === "number" ? value.zoom : undefined
        };

        if ("cropNorm" in value && value.cropNorm && typeof value.cropNorm === "object") {
          const cropNormRaw = value.cropNorm as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
          const x = Number(cropNormRaw.x);
          const y = Number(cropNormRaw.y);
          const w = Number(cropNormRaw.w);
          const h = Number(cropNormRaw.h);
          if ([x, y, w, h].every((n) => Number.isFinite(n))) {
            edit.cropNorm = {
              x: clamp01(x),
              y: clamp01(y),
              w: clamp01(w),
              h: clamp01(h)
            };
          }
        }

        if ("cropPixels" in value && value.cropPixels && typeof value.cropPixels === "object") {
          const cropRaw = value.cropPixels as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
          const x = Number(cropRaw.x);
          const y = Number(cropRaw.y);
          const width = Number(cropRaw.width);
          const height = Number(cropRaw.height);
          if ([x, y, width, height].every((n) => Number.isFinite(n))) {
            edit.cropPixels = {
              x: Math.round(x),
              y: Math.round(y),
              width: Math.round(width),
              height: Math.round(height)
            };
          }
        }

        if (edit.cropNorm || edit.cropPixels) {
          photoEdits[field] = edit;
        }
      }
    }
  }

  const files: Record<string, File> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      files[key] = value;
    }
  }

  return {
    templateId,
    textFields,
    textSizeAdjust,
    richText,
    photoRefs,
    photoEdits,
    files
  };
}

async function localFileToPreparedPhoto(file: File): Promise<PreparedPhoto> {
  const mimeType = normalizeMimeType(file.type);
  if (!mimeType) {
    throw new Error("E_UPLOAD_TYPE");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("E_UPLOAD_TOO_LARGE");
  }
  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    mimeType
  };
}

async function photobankRefToPreparedPhoto(path: string): Promise<PreparedPhoto> {
  let response: Response;
  try {
    const href = await resolvePhotobankDownloadHref(path);
    response = await fetch(href, { cache: "no-store" });
  } catch {
    throw new Error("E_PHOTOBANK_DOWNLOAD");
  }
  if (!response.ok) {
    throw new Error("E_PHOTOBANK_DOWNLOAD");
  }

  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
      throw new Error("E_UPLOAD_TOO_LARGE");
    }
  }

  const mimeByHeader = normalizeMimeType(response.headers.get("content-type"));
  const mimeType = mimeByHeader ?? inferMimeByPath(path);
  if (!mimeType) {
    throw new Error("E_UPLOAD_TYPE");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_FILE_BYTES) {
    throw new Error("E_UPLOAD_TOO_LARGE");
  }

  return {
    buffer: body,
    mimeType
  };
}

async function encodeByMime(image: sharp.Sharp, mimeType: string): Promise<Buffer> {
  if (mimeType === "image/jpeg") {
    return image.jpeg().toBuffer();
  }
  if (mimeType === "image/webp") {
    return image.webp().toBuffer();
  }
  return image.png().toBuffer();
}

async function applyPhotoEdit(input: PreparedPhoto, edit: PhotoEdit, target?: { width: number; height: number }): Promise<PreparedPhoto> {
  const metadata = await sharp(input.buffer).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("E_CROP_OUT_OF_BOUNDS");
  }

  let crop: CropPixels | null = null;
  if (edit.cropNorm) {
    const norm = edit.cropNorm;
    const left = Math.round(norm.x * sourceWidth);
    const top = Math.round(norm.y * sourceHeight);
    const width = Math.round(norm.w * sourceWidth);
    const height = Math.round(norm.h * sourceHeight);
    crop = { x: left, y: top, width, height };
  } else if (edit.cropPixels) {
    crop = edit.cropPixels;
  }
  if (!crop) {
    return input;
  }

  const left = Math.max(0, Math.min(sourceWidth - 1, Math.round(crop.x)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.round(crop.y)));
  const maxWidth = sourceWidth - left;
  const maxHeight = sourceHeight - top;
  const width = Math.max(1, Math.min(maxWidth, Math.round(crop.width)));
  const height = Math.max(1, Math.min(maxHeight, Math.round(crop.height)));
  if (width <= 0 || height <= 0) {
    throw new Error("E_CROP_OUT_OF_BOUNDS");
  }

  let image = sharp(input.buffer).extract({
    left,
    top,
    width,
    height
  });

  if (target && target.width > 0 && target.height > 0) {
    image = image.resize(target.width, target.height, { fit: "cover" });
  }

  return {
    buffer: await encodeByMime(image, input.mimeType),
    mimeType: input.mimeType
  };
}

type FigmaRenderDebug = {
  blockX: number;
  blockY: number;
  blockWidth: number;
  blockHeight: number;
  textX: number;
  textTopY: number;
  baselineY: number;
  ascPx: number;
  descPx: number;
  lineBoxHeightPx: number;
  textBlockHeightPx: number;
  innerHeight: number;
  lineHeightPercentFontSizeNormalized: number;
  computedLineHeightPx: number;
  sourceLineHeightPx?: number;
  sourceFontSize?: number;
  linesCount: number;
  maxLineWidthPx: number;
  textRender: "paths";
  logoBgMeta: Awaited<ReturnType<sharp.Sharp["metadata"]>>;
};

type FigmaRenderResult = {
  png: Buffer;
  debug: FigmaRenderDebug;
};

function toPosInt(name: string, v: unknown, min = 1, max = 100_000) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not finite: ${String(v)}`);
  const i = Math.round(n);
  if (i < min) throw new Error(`${name} too small: ${i}`);
  if (i > max) throw new Error(`${name} too large: ${i}`);
  return i;
}

function toNonNegInt(name: string, v: unknown, max = 100_000) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not finite: ${String(v)}`);
  const i = Math.round(n);
  if (i < 0) throw new Error(`${name} must be >= 0: ${i}`);
  if (i > max) throw new Error(`${name} too large: ${i}`);
  return i;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rgbaToSharpColor(color: { r: number; g: number; b: number; a: number }) {
  return {
    r: Math.round(color.r * 255),
    g: Math.round(color.g * 255),
    b: Math.round(color.b * 255),
    alpha: color.a
  };
}

function wrapTextLegacy(text: string, maxChars = 28, maxLines = 3): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === 0) {
    return [""];
  }
  return lines;
}

async function buildLegacyRenderPng(inputPhoto: Buffer, title: string, templateId: string): Promise<Buffer> {
  const width = toPosInt("legacy.width", 1080);
  const height = toPosInt("legacy.height", 1080);
  const photoWidth = toPosInt("legacy.photoWidth", 900);
  const photoHeight = toPosInt("legacy.photoHeight", 600);
  const photoLeft = (width - photoWidth) / 2;
  const photoTop = 120;
  const badgeWidth = toPosInt("legacy.badgeWidth", 900);
  const badgeHeight = toPosInt("legacy.badgeHeight", 180);
  const badgeLeft = (width - badgeWidth) / 2;
  const badgeTop = 760;
  const radius = 40;

  const resizedPhoto = await sharp(inputPhoto)
    .resize(toPosInt("legacy.resize.photoWidth", photoWidth), toPosInt("legacy.resize.photoHeight", photoHeight), {
      fit: "cover"
    })
    .png()
    .toBuffer();
  const photoMask = Buffer.from(
    `<svg width="${photoWidth}" height="${photoHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${photoWidth}" height="${photoHeight}" rx="${radius}" ry="${radius}" fill="#fff" />
    </svg>`
  );
  const roundedPhoto = await sharp({
    create: {
      width: toPosInt("legacy.create.roundedPhoto.width", photoWidth),
      height: toPosInt("legacy.create.roundedPhoto.height", photoHeight),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: resizedPhoto, left: 0, top: 0 },
      { input: photoMask, blend: "dest-in", left: 0, top: 0 }
    ])
    .png()
    .toBuffer();

  const badgeSvg = Buffer.from(
    `<svg width="${badgeWidth}" height="${badgeHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${badgeWidth}" height="${badgeHeight}" rx="${radius}" ry="${radius}" fill="#D7262D" />
    </svg>`
  );

  const lines = wrapTextLegacy(title);
  const lineHeight = 52;
  const firstLineY = 72;
  const textLines = lines
    .map((line, index) => {
      const y = firstLineY + index * lineHeight;
      return `<text x="40" y="${y}" fill="#fff" font-size="46" font-family="Arial, sans-serif" font-weight="700">${escapeXml(line)}</text>`;
    })
    .join("");

  const overlaySvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="24" y="44" fill="#777" font-size="20" font-family="Arial, sans-serif">Template: ${escapeXml(templateId)}</text>
      <g transform="translate(${badgeLeft},${badgeTop})">
        ${textLines}
      </g>
    </svg>`
  );

  return sharp({
    create: {
      width: toPosInt("legacy.create.canvas.width", width),
      height: toPosInt("legacy.create.canvas.height", height),
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([
      { input: roundedPhoto, left: photoLeft, top: photoTop },
      { input: badgeSvg, left: badgeLeft, top: badgeTop },
      { input: overlaySvg, left: 0, top: 0 }
    ])
    .png()
    .toBuffer();
}

async function buildFigmaRenderPng(inputPhoto: Buffer, title: string, fileKey: string): Promise<FigmaRenderResult> {
  const tpl = TPL_VK_POST_1_FIGMA;
  const frameW = toPosInt("figma.frameW", 2000);
  const frameH = toPosInt("figma.frameH", 2000);
  const blockBottom = frameH - 130;
  const paddingLeft = 150;
  const paddingRight = 150;
  const paddingTop = 80;
  const paddingBottom = 80;
  const maxTextWidth = 1600;
  const fontSize = tpl.textStyle.fontSize;
  const lineHeightPercentFontSizeNormalized =
    typeof tpl.textStyle.lineHeightPercentFontSizeNormalized === "number"
      ? tpl.textStyle.lineHeightPercentFontSizeNormalized
      : typeof tpl.textStyle.lineHeightPercentFontSize === "number"
        ? tpl.textStyle.lineHeightPercentFontSize
        : typeof tpl.textStyle.lineHeightPx === "number" && fontSize > 0
          ? (tpl.textStyle.lineHeightPx / fontSize) * 100
          : 100;
  const lineHeightPx = fontSize * (lineHeightPercentFontSizeNormalized / 100);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error(`fontSize must be > 0, got: ${String(fontSize)}`);
  }
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
    throw new Error(`lineHeightPx must be > 0, got: ${String(lineHeightPx)}`);
  }
  const normalizedLineHeightPercentRounded = Number(lineHeightPercentFontSizeNormalized.toFixed(3));
  const computedLineHeightPx = Number(lineHeightPx.toFixed(3));
  const letterSpacing = 0;

  const logoBg = tpl.layout.logoBg;
  const minX = Math.min(0, logoBg.x);
  const minY = Math.min(0, logoBg.y);
  const maxX = Math.max(frameW, logoBg.x + logoBg.width);
  const maxY = Math.max(frameH, logoBg.y + logoBg.height);
  const offsetX = -minX;
  const offsetY = -minY;
  const bigW = toPosInt("figma.bigW", maxX - minX);
  const bigH = toPosInt("figma.bigH", maxY - minY);

  let logoBgBuffer = await getFigmaNodePng(fileKey, tpl.nodes.logoBgId, 1);
  logoBgBuffer = await sharp(logoBgBuffer).ensureAlpha().toBuffer();
  const logoBgMeta = await sharp(logoBgBuffer).metadata();
  const logoVectorBuffer = await getFigmaNodePng(fileKey, tpl.nodes.logoVectorId, 1);

  const logoBgLayer = await sharp(logoBgBuffer)
    .resize(
      toPosInt("figma.resize.logoBg.width", logoBg.width),
      toPosInt("figma.resize.logoBg.height", logoBg.height),
      { fit: "fill" }
    )
    .png()
    .toBuffer();
  const logoLayer = await sharp(logoVectorBuffer)
    .resize(
      toPosInt("figma.resize.logo.width", tpl.layout.logo.width),
      toPosInt("figma.resize.logo.height", tpl.layout.logo.height),
      { fit: "fill" }
    )
    .png()
    .toBuffer();

  const photoLayer = await applyRoundedRectMask(
    inputPhoto,
    toPosInt("figma.photo.width", tpl.layout.photo.width),
    toPosInt("figma.photo.height", tpl.layout.photo.height),
    tpl.layout.photo.radii
  );

  const fontPath = path.join(process.cwd(), "assets", "fonts", "gothampro", "gothampro_bold.ttf");
  if (!existsSync(fontPath)) {
    throw new Error(`Font file not found: ${fontPath}`);
  }
  const font = await loadFontCached(fontPath);
  const metrics = getFontMetricsPx(font, fontSize);
  const lines = wrapTextByWords(title, maxTextWidth, font, fontSize, letterSpacing);
  const normalizedLines = lines.length > 0 ? lines : [""];
  const linesCount = normalizedLines.length;
  if (linesCount < 1) {
    throw new Error("linesCount must be >= 1");
  }
  const maxLineWidthPx = normalizedLines.reduce((maxWidth, line) => {
    const width = measureTextPx(line, font, fontSize, letterSpacing);
    return Math.max(maxWidth, width);
  }, 0);

  let textBoxWidth = Math.min(maxTextWidth, maxLineWidthPx);
  if (textBoxWidth + paddingLeft + paddingRight > frameW) {
    textBoxWidth = frameW - paddingLeft - paddingRight;
  }
  const blockWidth = toPosInt("figma.blockWidth", textBoxWidth + paddingLeft + paddingRight);
  const textBlockHeightPx = (linesCount - 1) * lineHeightPx + metrics.lineBoxHeightPx;
  const blockHeight = toPosInt("figma.blockHeight", paddingTop + textBlockHeightPx + paddingBottom);
  const blockX = 0;
  const blockY = Math.round(blockBottom - blockHeight);
  const textX = blockX + paddingLeft;
  const innerTop = blockY + paddingTop;
  const innerBottom = blockY + blockHeight - paddingBottom;
  const innerHeight = innerBottom - innerTop;
  const textTopY = innerTop + Math.max(0, (innerHeight - textBlockHeightPx) / 2);
  const textYNudgeRaw = process.env.TEXT_Y_NUDGE_PX;
  const textYNudgePx = textYNudgeRaw !== undefined ? Number(textYNudgeRaw) : 0;
  const safeTextYNudgePx = Number.isFinite(textYNudgePx) ? textYNudgePx : 0;
  const baselineY = textTopY + metrics.ascPx + safeTextYNudgePx;

  const textBlockBase = await sharp({
    create: {
      width: toPosInt("figma.create.textBlock.width", blockWidth),
      height: toPosInt("figma.create.textBlock.height", blockHeight),
      channels: 4,
      background: rgbaToSharpColor(tpl.layout.textBlock.fill)
    }
  })
    .png()
    .toBuffer();
  const textBlockLayer = await applyRoundedRectMask(
    textBlockBase,
    blockWidth,
    blockHeight,
    tpl.layout.textBlock.radii
  );

  const textXOnBig = textX + offsetX;
  const baselineYOnBig = baselineY + offsetY;
  const textPaths = buildSvgPathsForLines(
    font,
    normalizedLines,
    textXOnBig,
    baselineYOnBig,
    fontSize,
    lineHeightPx
  );

  const textSvg = Buffer.from(
    `<svg width="${bigW}" height="${bigH}" viewBox="0 0 ${bigW} ${bigH}" xmlns="http://www.w3.org/2000/svg">
      <g fill="rgba(0,0,0,1)">${textPaths}</g>
    </svg>`
  );

  const composedBig = await sharp({
    create: {
      width: toPosInt("figma.create.bigCanvas.width", bigW),
      height: toPosInt("figma.create.bigCanvas.height", bigH),
      channels: 4,
      background: rgbaToSharpColor(tpl.frame.background)
    }
  })
    .composite([
      { input: logoBgLayer, left: logoBg.x + offsetX, top: logoBg.y + offsetY },
      { input: photoLayer, left: tpl.layout.photo.x + offsetX, top: tpl.layout.photo.y + offsetY },
      { input: textBlockLayer, left: blockX + offsetX, top: blockY + offsetY },
      { input: textSvg, left: 0, top: 0 },
      { input: logoLayer, left: tpl.layout.logo.x + offsetX, top: tpl.layout.logo.y + offsetY }
    ])
    .png()
    .toBuffer();

  const png = await sharp(composedBig)
    .extract({
      left: toNonNegInt("figma.extract.left", offsetX),
      top: toNonNegInt("figma.extract.top", offsetY),
      width: toPosInt("figma.extract.width", frameW),
      height: toPosInt("figma.extract.height", frameH)
    })
    .png()
    .toBuffer();

  return {
    png,
    debug: {
      blockX,
      blockY,
      blockWidth,
      blockHeight,
      textX,
      textTopY,
      baselineY,
      ascPx: Number(metrics.ascPx.toFixed(3)),
      descPx: Number(metrics.descPx.toFixed(3)),
      lineBoxHeightPx: Number(metrics.lineBoxHeightPx.toFixed(3)),
      textBlockHeightPx: Number(textBlockHeightPx.toFixed(3)),
      innerHeight,
      lineHeightPercentFontSizeNormalized: normalizedLineHeightPercentRounded,
      computedLineHeightPx,
      sourceLineHeightPx: tpl.textStyle.lineHeightPx,
      sourceFontSize: tpl.textStyle.fontSize,
      linesCount,
      maxLineWidthPx,
      textRender: "paths",
      logoBgMeta
    }
  };
}

export async function POST(request: Request) {
  const env = getEnv();
  const universalEnabled =
    process.env.USE_UNIVERSAL_ENGINE === "1" ||
    process.env.USE_UNIVERSAL_ENGINE === undefined ||
    isUniversalEngineEnabled();
  const figmaEnabled = env.USE_FIGMA_RENDER === "1";
  const debugRender = env.DEBUG_RENDER === "1";
  let debugPayload: FigmaRenderDebug | undefined;

  try {
    const validateOnly = new URL(request.url).searchParams.get("validate") === "1";
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    let payload: GeneratePayload | null = null;
    let multipartInput: MultipartGenerateInput | null = null;

    if (!validateOnly && contentType.includes("multipart/form-data")) {
      multipartInput = await parseMultipartGenerateInput(request);
    } else {
      payload = (await request.json()) as GeneratePayload;
    }

    const templateId = multipartInput?.templateId ?? payload?.templateId?.trim();
    const requestFields: Record<string, string> = multipartInput?.textFields
      ? { ...multipartInput.textFields }
      : {};

    if (payload?.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)) {
      for (const [key, value] of Object.entries(payload.fields)) {
        if (typeof value === "string") {
          requestFields[key] = value;
        }
      }
    }

    const textSizeAdjust = multipartInput?.textSizeAdjust
      ? multipartInput.textSizeAdjust
      : parseTextSizeAdjust(
          payload?.textSizeAdjust && typeof payload.textSizeAdjust === "object" && !Array.isArray(payload.textSizeAdjust)
            ? payload.textSizeAdjust
            : undefined
        );
    const richText = multipartInput?.richText
      ? multipartInput.richText
      : parseRichText(
          payload?.richText && typeof payload.richText === "object" && !Array.isArray(payload.richText)
            ? payload.richText
            : undefined
        );

    if (universalEnabled) {
      if (!templateId) {
        return NextResponse.json({ error: "templateId is required" }, { status: 400 });
      }

      const fileKey = env.FIGMA_FILE_KEY?.trim();
      if (!fileKey) {
        return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
      }

      const frameSnapshotKey = getFrameSnapshotKey(fileKey, templateId);
      const frameNode = await tryReadSnapshotJson<unknown>(frameSnapshotKey);
      if (!frameNode || typeof frameNode !== "object") {
        return NextResponse.json({ error: "No snapshot. Run POST /api/admin/sync" }, { status: 503 });
      }

      const textTooLong = await validateTextLineLimits({
        templateId,
        fields: requestFields,
        textSizeAdjust,
        frameNode: frameNode as Parameters<typeof renderUniversalTemplate>[0]["frameNode"]
      });
      if (textTooLong) {
        return NextResponse.json(
          {
            error: "Text too long",
            code: textTooLong.code,
            field: textTooLong.field,
            maxLines: textTooLong.maxLines,
            actualLines: textTooLong.actualLines
          },
          { status: 400 }
        );
      }

      if (validateOnly) {
        return NextResponse.json({ ok: true });
      }

      if (multipartInput) {
        const schemaKey = getSchemaSnapshotKey(fileKey, templateId);
        const schemaPayload = await readSnapshotJson<SchemaPayload>(schemaKey);
        const imageFields = schemaPayload.fields.filter((field) => field.type === "image");

        for (const field of imageFields) {
          try {
            const localFile = multipartInput.files[field.key];
            const photobankRef = multipartInput.photoRefs[field.key];
            let objectKey: string | null = null;
            const photoGeometry = schemaPayload.photoFields?.find(
              (item) => item.name.toLowerCase() === field.key.toLowerCase()
            );
            const target =
              photoGeometry && photoGeometry.box.width > 0 && photoGeometry.box.height > 0
                ? {
                    width: photoGeometry.box.width,
                    height: photoGeometry.box.height
                  }
                : undefined;
            const edit = multipartInput.photoEdits[field.key];

            if (localFile) {
              let photo = await localFileToPreparedPhoto(localFile);
              if (edit) {
                photo = await applyPhotoEdit(photo, edit, target);
              }
              objectKey = await uploadBufferToB2(photo.buffer, photo.mimeType);
            } else if (photobankRef?.source === "photobank") {
              let photo = await photobankRefToPreparedPhoto(photobankRef.path);
              if (edit) {
                photo = await applyPhotoEdit(photo, edit, target);
              }
              objectKey = await uploadBufferToB2(photo.buffer, photo.mimeType);
            } else if (requestFields[field.key]) {
              objectKey = requestFields[field.key];
            }

            if (!objectKey) {
              return NextResponse.json(
                {
                  code: `E_PHOTO_REQUIRED_${field.key}`,
                  field: field.key,
                  error: `Photo is required for field ${field.key}`
                },
                { status: 400 }
              );
            }

            requestFields[field.key] = objectKey;
          } catch (error) {
            const code = error instanceof Error ? error.message : "E_GENERATE_FAILED";
            if (code === "E_UPLOAD_TOO_LARGE") {
              return jsonError("E_UPLOAD_TOO_LARGE", "File is too large. Max 30MB", 400);
            }
            if (code === "E_UPLOAD_TYPE") {
              return jsonError("E_UPLOAD_TYPE", "Unsupported image format. Allowed: JPEG, PNG, WEBP", 400);
            }
            if (code === "E_PHOTOBANK_DOWNLOAD") {
              return jsonError("E_PHOTOBANK_DOWNLOAD", "Failed to download file from photobank", 500);
            }
            if (code === "E_CROP_OUT_OF_BOUNDS") {
              return jsonError("E_CROP_OUT_OF_BOUNDS", "Crop is outside image bounds", 400);
            }
            return jsonError("E_GENERATE_FAILED", "Failed to prepare images", 500);
          }
        }
      }

      const rendered = await renderUniversalTemplate({
        templateId,
        fields: requestFields,
        textSizeAdjust,
        richText,
        frameNode: frameNode as Parameters<typeof renderUniversalTemplate>[0]["frameNode"],
        includeDebug: debugRender
      });

      const resultKey = `renders/${randomUUID()}.png`;
      await putObject({
        Key: resultKey,
        Body: rendered.png,
        ContentType: "image/png"
      });

      const signedGetUrl = await getSignedGetUrl(resultKey);
      return NextResponse.json({
        resultKey,
        signedGetUrl,
        renderMode: "universal",
        ...(debugRender
          ? {
              debug: {
                mode: "universal",
                templateId,
                fieldsKeys: Object.keys(requestFields),
                render: rendered.debug
              }
            }
          : {})
      });
    }

    const title = payload?.title?.trim() ?? "";
    const objectKey = payload?.objectKey?.trim() ?? "";

    if (!templateId || !title || !objectKey) {
      return NextResponse.json(
        { error: "templateId, title and objectKey are required" },
        { status: 400 }
      );
    }

    const template = getTemplateById(templateId);
    if (!template) {
      return NextResponse.json({ error: "Unknown templateId" }, { status: 400 });
    }

    const photoObject = await getObject(objectKey);
    if (!photoObject.Body) {
      return NextResponse.json({ error: "Source object body is empty" }, { status: 400 });
    }
    const photoBuffer = await streamToBuffer(photoObject.Body);

    let resultPng: Buffer;
    if (figmaEnabled && template.id === TPL_VK_POST_1_ID) {
      const figmaResult = await buildFigmaRenderPng(photoBuffer, title, template.figmaFileKey);
      resultPng = figmaResult.png;
      debugPayload = figmaResult.debug;
    } else {
      resultPng = await buildLegacyRenderPng(photoBuffer, title, template.id);
    }

    const resultKey = `renders/${randomUUID()}.png`;

    await putObject({
      Key: resultKey,
      Body: resultPng,
      ContentType: "image/png"
    });

    const signedGetUrl = await getSignedGetUrl(resultKey);
    return NextResponse.json({
      resultKey,
      signedGetUrl,
      renderMode: "legacy",
      ...(debugRender && debugPayload ? { debug: debugPayload } : {})
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Generate failed";
    return NextResponse.json({ error: message, renderMode: universalEnabled ? "universal" : "legacy" }, { status: 500 });
  }
}
