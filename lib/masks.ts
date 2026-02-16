import sharp from "sharp";
import { buildRoundedRectPath, type CornerRadii } from "@/lib/roundedRectPath";

export function createRoundedRectMaskSvg(width: number, height: number, radii: CornerRadii): Buffer {
  const path = buildRoundedRectPath(width, height, radii);
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="#ffffff"/></svg>`;
  return Buffer.from(svg);
}

export async function applyRoundedRectMask(
  input: Buffer,
  width: number,
  height: number,
  radii: CornerRadii
): Promise<Buffer> {
  const mask = createRoundedRectMaskSvg(width, height, radii);
  const resized = await sharp(input).resize(width, height, { fit: "cover" }).png().toBuffer();

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: resized, left: 0, top: 0 },
      { input: mask, left: 0, top: 0, blend: "dest-in" }
    ])
    .png()
    .toBuffer();
}
