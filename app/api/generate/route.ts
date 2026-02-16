import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getEnv } from "@/lib/env";
import { getFigmaNodePng } from "@/lib/figmaImages";
import { applyRoundedRectMask } from "@/lib/masks";
import { getObject, getSignedGetUrl, putObject } from "@/lib/s3";
import { streamToBuffer } from "@/lib/streamToBuffer";
import {
  getTemplateById,
  TPL_VK_POST_1_FIGMA,
  TPL_VK_POST_1_ID
} from "@/lib/templates";
import { loadFontCached, truncateLines, wrapTextByWords } from "@/lib/textLayout";

export const runtime = "nodejs";

type GeneratePayload = {
  templateId?: string;
  title?: string;
  objectKey?: string;
};

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

async function toPngWithOpacity(
  input: Buffer,
  width: number,
  height: number,
  opacity: number
): Promise<Buffer> {
  const resized = await sharp(input).resize(width, height, { fit: "fill" }).png().toBuffer();
  const imageBase64 = resized.toString("base64");
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <image width="${width}" height="${height}" href="data:image/png;base64,${imageBase64}" opacity="${opacity}" />
    </svg>`
  );
  return sharp(svg).png().toBuffer();
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
  const width = 1080;
  const height = 1080;
  const photoWidth = 900;
  const photoHeight = 600;
  const photoLeft = (width - photoWidth) / 2;
  const photoTop = 120;
  const badgeWidth = 900;
  const badgeHeight = 180;
  const badgeLeft = (width - badgeWidth) / 2;
  const badgeTop = 760;
  const radius = 40;

  const resizedPhoto = await sharp(inputPhoto).resize(photoWidth, photoHeight, { fit: "cover" }).png().toBuffer();

  const photoMask = Buffer.from(
    `<svg width="${photoWidth}" height="${photoHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${photoWidth}" height="${photoHeight}" rx="${radius}" ry="${radius}" fill="#fff" />
    </svg>`
  );

  const roundedPhoto = await sharp({
    create: {
      width: photoWidth,
      height: photoHeight,
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
      width,
      height,
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

async function buildFigmaRenderPng(inputPhoto: Buffer, title: string, fileKey: string): Promise<Buffer> {
  const tpl = TPL_VK_POST_1_FIGMA;
  const frameW = tpl.frame.width;
  const frameH = tpl.frame.height;

  const logoBg = tpl.layout.logoBg;
  const minX = Math.min(0, logoBg.x);
  const minY = Math.min(0, logoBg.y);
  const maxX = Math.max(frameW, logoBg.x + logoBg.width);
  const maxY = Math.max(frameH, logoBg.y + logoBg.height);
  const offsetX = -minX;
  const offsetY = -minY;
  const bigW = maxX - minX;
  const bigH = maxY - minY;

  const logoBgBuffer = await getFigmaNodePng(fileKey, tpl.nodes.logoBgId, 1);
  const logoVectorBuffer = await getFigmaNodePng(fileKey, tpl.nodes.logoVectorId, 1);
  const logoBgLayer = await toPngWithOpacity(logoBgBuffer, logoBg.width, logoBg.height, logoBg.opacity);
  const logoLayer = await sharp(logoVectorBuffer)
    .resize(tpl.layout.logo.width, tpl.layout.logo.height, { fit: "fill" })
    .png()
    .toBuffer();

  const photoLayer = await applyRoundedRectMask(
    inputPhoto,
    tpl.layout.photo.width,
    tpl.layout.photo.height,
    tpl.layout.photo.radii
  );

  const fontPath = join(process.cwd(), "assets", "fonts", "gothampro", "gothampro_bold.ttf");
  const font = await loadFontCached(fontPath);
  const contentWidth =
    tpl.layout.textBlock.width - tpl.layout.textBlock.paddingLeft - tpl.layout.textBlock.paddingRight;
  const wrapped = wrapTextByWords(
    title,
    contentWidth,
    font,
    tpl.textStyle.fontSize,
    tpl.textStyle.letterSpacing
  );
  const lines = truncateLines(wrapped, 4, {
    maxWidthPx: contentWidth,
    font,
    fontSizePx: tpl.textStyle.fontSize,
    letterSpacingPx: tpl.textStyle.letterSpacing,
    ellipsis: "…"
  });

  const textHeight = lines.length * tpl.textStyle.lineHeightPx;
  const newBlockHeight = tpl.layout.textBlock.paddingTop + textHeight + tpl.layout.textBlock.paddingBottom;
  const newBlockY = tpl.layout.textBlock.blockBottom - newBlockHeight;

  const textX = tpl.layout.textBlock.x + tpl.layout.textBlock.paddingLeft;
  const textY = newBlockY + tpl.layout.textBlock.paddingTop;

  const textBlockBase = await sharp({
    create: {
      width: tpl.layout.textBlock.width,
      height: newBlockHeight,
      channels: 4,
      background: rgbaToSharpColor(tpl.layout.textBlock.fill)
    }
  })
    .png()
    .toBuffer();
  const textBlockLayer = await applyRoundedRectMask(
    textBlockBase,
    tpl.layout.textBlock.width,
    newBlockHeight,
    tpl.layout.textBlock.radii
  );

  const fontBase64 = (await readFile(fontPath)).toString("base64");
  const fillRgba = tpl.textStyle.color;
  const textXOnBig = textX + offsetX;
  const textYOnBig = textY + offsetY;
  const tspanMarkup = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : tpl.textStyle.lineHeightPx;
      return `<tspan x="${textXOnBig}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const textSvg = Buffer.from(
    `<svg width="${bigW}" height="${bigH}" viewBox="0 0 ${bigW} ${bigH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face {
            font-family: 'Gotham Pro';
            src: url(data:font/ttf;base64,${fontBase64}) format('truetype');
            font-weight: 700;
            font-style: normal;
          }
        </style>
      </defs>
      <text x="${textXOnBig}" y="${textYOnBig}" font-size="${tpl.textStyle.fontSize}" font-family="Gotham Pro" font-weight="${tpl.textStyle.fontWeight}" text-anchor="start" fill="rgba(${fillRgba.r * 255},${fillRgba.g * 255},${fillRgba.b * 255},${fillRgba.a})">
        ${tspanMarkup}
      </text>
    </svg>`
  );

  const composedBig = await sharp({
    create: {
      width: bigW,
      height: bigH,
      channels: 4,
      background: rgbaToSharpColor(tpl.frame.background)
    }
  })
    .composite([
      { input: logoBgLayer, left: logoBg.x + offsetX, top: logoBg.y + offsetY },
      {
        input: photoLayer,
        left: tpl.layout.photo.x + offsetX,
        top: tpl.layout.photo.y + offsetY
      },
      {
        input: textBlockLayer,
        left: tpl.layout.textBlock.x + offsetX,
        top: newBlockY + offsetY
      },
      { input: textSvg, left: 0, top: 0 },
      {
        input: logoLayer,
        left: tpl.layout.logo.x + offsetX,
        top: tpl.layout.logo.y + offsetY
      }
    ])
    .png()
    .toBuffer();

  return sharp(composedBig)
    .extract({
      left: offsetX,
      top: offsetY,
      width: frameW,
      height: frameH
    })
    .png()
    .toBuffer();
}

export async function POST(request: Request) {
  const figmaEnabled = getEnv().USE_FIGMA_RENDER === "1";
  let renderMode: "figma" | "test" = "test";

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
      resultPng = await buildFigmaRenderPng(photoBuffer, title, template.figmaFileKey);
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
    return NextResponse.json({ resultKey, signedGetUrl, renderMode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generate failed";
    return NextResponse.json({ error: message, renderMode }, { status: 500 });
  }
}
