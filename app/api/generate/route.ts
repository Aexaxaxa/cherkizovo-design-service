import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getEnv } from "@/lib/env";
import { getFigmaNodePng } from "@/lib/figmaImages";
import { applyRoundedRectMask } from "@/lib/masks";
import { getObject, getSignedGetUrl, putObject } from "@/lib/s3";
import { streamToBuffer } from "@/lib/streamToBuffer";
import { getTemplateById, TPL_VK_POST_1_FIGMA, TPL_VK_POST_1_ID } from "@/lib/templates";
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
};

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
  const figmaEnabled = env.USE_FIGMA_RENDER === "1";
  const debugRender = env.DEBUG_RENDER === "1";
  let renderMode: "figma" | "test" = "test";
  let debugPayload: FigmaRenderDebug | undefined;

  try {
    const payload = (await request.json()) as GeneratePayload;
    const templateId = payload.templateId?.trim();
    const title = payload.title?.trim();
    const objectKey = payload.objectKey?.trim();

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
      renderMode = "figma";
      const figmaResult = await buildFigmaRenderPng(photoBuffer, title, template.figmaFileKey);
      resultPng = figmaResult.png;
      debugPayload = figmaResult.debug;
    } else {
      renderMode = "test";
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
      renderMode,
      ...(debugRender && debugPayload ? { debug: debugPayload } : {})
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Generate failed";
    return NextResponse.json({ error: message, renderMode: "figma" }, { status: 500 });
  }
}
