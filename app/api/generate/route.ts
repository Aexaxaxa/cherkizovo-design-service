import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getObject, getSignedGetUrl, putObject } from "@/lib/s3";
import { streamToBuffer } from "@/lib/streamToBuffer";
import { getTemplateById } from "@/lib/templates";

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

function wrapText(text: string, maxChars = 28, maxLines = 3): string[] {
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

async function buildRenderPng(inputPhoto: Buffer, title: string, templateId: string): Promise<Buffer> {
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

  const lines = wrapText(title);
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

export async function POST(request: Request) {
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

    const resultPng = await buildRenderPng(photoBuffer, title, template.id);
    const resultKey = `renders/${randomUUID()}.png`;

    await putObject({
      Key: resultKey,
      Body: resultPng,
      ContentType: "image/png"
    });

    const signedGetUrl = await getSignedGetUrl(resultKey);
    return NextResponse.json({ resultKey, signedGetUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generate failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
