import path from "node:path";
import sharp from "sharp";
import {
  buildLayoutTree,
  findNearestResizableContainer,
  getEditableKind,
  hasSolidFill,
  type FigmaNodeLite,
  type LayoutNode
} from "@/lib/figmaLayout";
import { buildRoundedRectPath } from "@/lib/roundedRectPath";
import { getObject } from "@/lib/s3";
import { toSafeFrameId } from "@/lib/snapshotStore";
import { streamToBuffer } from "@/lib/streamToBuffer";
import {
  buildSvgPathsForLines,
  getFontMetricsPx,
  loadFontCached,
  measureTextPx,
  wrapTextByWords
} from "@/lib/textLayout";

export type UniversalRenderDebug = {
  layoutSource: "snapshot_b2";
  frameW: number;
  frameH: number;
  fieldsUsed: string[];
  opsCount: number;
  bigCanvas: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    bigW: number;
    bigH: number;
    paddingLeft: number;
    paddingTop: number;
  };
  editables: Array<{
    name: string;
    origW: number;
    origBBox: { x: number; y: number; width: number; height: number };
    newBBox: { x: number; y: number; width: number; height: number };
    constraintH: string;
    constraintV: string;
    isExplicitWidth: boolean;
    isFixedWidth: boolean;
    containerW: number;
    paddingL: number;
    paddingR: number;
    explicitMaxContentWidth?: number;
    maxTextWidth: number;
    linesCount: number;
    linesA: number;
    linesB: number;
    finalBlockW: number;
    textH: number;
    initialInnerW: number;
    finalInnerW: number;
    innerH: number;
    contentTop: number;
    ascent: number;
    layoutMode?: string;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
  }>;
  textContainers: Array<{
    containerName: string;
    isFixedWidth: boolean;
    containerW: number;
    paddingL: number;
    paddingR: number;
    maxTextWidth: number;
    finalPillW: number;
    lines: number;
    textH: number;
    initialInnerW?: number;
    finalInnerW?: number;
    linesA?: number;
    linesB?: number;
    innerH?: number;
    contentTop?: number;
    ascent?: number;
    layoutMode?: string;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
  }>;
  badBoxes?: Array<{
    label: string;
    box: { left: number; top: number; width: number; height: number } | null;
  }>;
  skippedPhoto?: boolean;
  skippedPhotoReason?: string[];
  photoLayers?: Array<{
    name: string;
    targetW: number;
    targetH: number;
    actualW: number;
    actualH: number;
    left: number;
    top: number;
  }>;
};

export type UniversalRenderResult = {
  png: Buffer;
  debug?: UniversalRenderDebug;
};

type Layer = {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  input: Buffer;
};
type CompositeItem = {
  input: Buffer;
  left: number;
  top: number;
  width?: number;
  height?: number;
  blend?: sharp.Blend;
};

type EditableTextDebug = UniversalRenderDebug["editables"][number];
type SafeBox = { left: number; top: number; width: number; height: number };
type MeasuredTextBlock = {
  node: LayoutNode;
  lines: string[];
  lineWidthsPx: number[];
  maxLineWidthPx: number;
  textBlockHeightPx: number;
  lineHeightPx: number;
  letterSpacing: number;
  fontSize: number;
  font: Awaited<ReturnType<typeof loadFontCached>>;
  metrics: ReturnType<typeof getFontMetricsPx>;
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT";
  color: { r: number; g: number; b: number; a: number };
};
type LayoutBox = { x: number; y: number; width: number; height: number };

const ATOMIC_IMAGE_TYPES = new Set([
  "VECTOR",
  "INSTANCE",
  "GROUP",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "POLYGON",
  "REGULAR_POLYGON",
  "COMPONENT",
  "COMPONENT_SET",
  "TEXT"
]);

const FONT_BY_POSTSCRIPT: Record<string, string> = {
  "gothampro": "gothampro.ttf",
  "gothampro-regular": "gothampro.ttf",
  "gothampro-medium": "gothampro_medium.ttf",
  "gothampro-bold": "gothampro_bold.ttf",
  "gothampro-black": "gothampro_black.ttf",
  "gothampro-italic": "gothampro_italic.ttf",
  "gothampro-mediumitalic": "gothampro_mediumitalic.ttf",
  "gothampro-bolditalic": "gothampro_bolditalic.ttf",
  "gothampro-blackitalic": "gothampro_blackitalic.ttf",
  "GothamPro-Bold": "gothampro_bold.ttf",
  "GothamPro-Regular": "gothampro.ttf",
  "GothamPro-Medium": "gothampro_medium.ttf"
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toInt(value: number): number {
  return Math.round(value);
}

function ensureFinite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} is not finite`);
  }
  return value;
}

function ensureLayerGeometry(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(fallback, Math.round(value));
}

function sanitizeBox(
  box: { left: number; top: number; width: number; height: number } | null,
  frameW: number,
  frameH: number,
  label: string,
  badBoxes?: Array<{ label: string; box: SafeBox | null }>
): SafeBox | null {
  if (!box) {
    badBoxes?.push({ label, box: null });
    if (process.env.DEBUG_RENDER === "1") {
      console.warn(`[universalEngine] Invalid box(${label}): null`);
    }
    return null;
  }
  const { left, top, width, height } = box;
  const valuesFinite = [left, top, width, height].every((v) => Number.isFinite(v));
  const widthOk = width >= 1 && width <= Math.min(frameW * 4, 12000);
  const heightOk = height >= 1 && height <= Math.min(frameH * 4, 12000);
  const posOk = left >= -frameW * 2 && top >= -frameH * 2;
  const areaOk = width * height <= 200_000_000;
  if (!valuesFinite || !widthOk || !heightOk || !posOk || !areaOk) {
    const bad = { left, top, width, height };
    badBoxes?.push({ label, box: bad });
    if (process.env.DEBUG_RENDER === "1") {
      console.warn(`[universalEngine] Invalid box(${label})`, { box: bad, frameW, frameH });
    }
    return null;
  }
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  };
}

async function normalizeCompositeItem(
  baseW: number,
  baseH: number,
  item: CompositeItem,
  label: string,
  badBoxes: Array<{ label: string; box: SafeBox | null }>
): Promise<CompositeItem | null> {
  const meta = await sharp(item.input).metadata();
  const ow = meta.width ?? 0;
  const oh = meta.height ?? 0;
  if (ow <= 0 || oh <= 0) {
    badBoxes.push({ label: `${label}:empty-overlay`, box: null });
    return null;
  }

  let left = Math.round(item.left);
  let top = Math.round(item.top);
  let w = Math.round(item.width ?? ow);
  let h = Math.round(item.height ?? oh);
  const safe = sanitizeBox({ left, top, width: w, height: h }, baseW, baseH, `${label}:intended`, badBoxes);
  if (!safe) return null;
  left = safe.left;
  top = safe.top;
  w = safe.width;
  h = safe.height;

  let overlay = item.input;
  if (ow !== w || oh !== h) {
    overlay = await sharp(overlay).resize(w, h, { fit: "fill" }).png().toBuffer();
  }

  const interLeft = Math.max(left, 0);
  const interTop = Math.max(top, 0);
  const interRight = Math.min(left + w, baseW);
  const interBottom = Math.min(top + h, baseH);
  const interW = interRight - interLeft;
  const interH = interBottom - interTop;
  if (interW <= 0 || interH <= 0) {
    return null;
  }

  if (interW !== w || interH !== h) {
    const cropX = interLeft - left;
    const cropY = interTop - top;
    overlay = await sharp(overlay)
      .extract({
        left: Math.max(0, Math.round(cropX)),
        top: Math.max(0, Math.round(cropY)),
        width: Math.max(1, Math.round(interW)),
        height: Math.max(1, Math.round(interH))
      })
      .png()
      .toBuffer();
    left = interLeft;
    top = interTop;
    w = interW;
    h = interH;
  }

  const meta2 = await sharp(overlay).metadata();
  if ((meta2.width ?? 0) > baseW || (meta2.height ?? 0) > baseH) {
    badBoxes.push({
      label: `${label}:overlay-too-large`,
      box: { left, top, width: meta2.width ?? 0, height: meta2.height ?? 0 }
    });
    return null;
  }

  return {
    ...item,
    input: overlay,
    left,
    top,
    width: w,
    height: h
  };
}

function rgbaToCss(fill: { r: number; g: number; b: number; a: number }): string {
  const r = Math.round(clamp(fill.r, 0, 1) * 255);
  const g = Math.round(clamp(fill.g, 0, 1) * 255);
  const b = Math.round(clamp(fill.b, 0, 1) * 255);
  const a = clamp(fill.a, 0, 1);
  return `rgba(${r},${g},${b},${a})`;
}

function toRelativeBbox(node: LayoutNode, frameX: number, frameY: number) {
  if (!node.bbox) return null;
  return {
    x: node.bbox.x - frameX,
    y: node.bbox.y - frameY,
    width: node.bbox.width,
    height: node.bbox.height
  };
}

function offsetRelativeBbox(
  bbox: { x: number; y: number; width: number; height: number } | null,
  offsetX: number,
  offsetY: number
) {
  if (!bbox) return null;
  return {
    x: bbox.x + offsetX,
    y: bbox.y + offsetY,
    width: bbox.width,
    height: bbox.height
  };
}

function isFixedContainer(node: LayoutNode | undefined): boolean {
  if (!node) return false;
  if (node.layoutSizingHorizontal === "FIXED" || node.counterAxisSizingMode === "FIXED") return true;
  if (node.layoutSizingVertical === "FIXED" || node.primaryAxisSizingMode === "FIXED") return true;
  return false;
}

function getRadii(node: LayoutNode): [number, number, number, number] {
  return node.radii ?? [0, 0, 0, 0];
}

function getPrimaryFill(node: LayoutNode): { r: number; g: number; b: number; a: number } | undefined {
  return node.fills[0];
}

function resolveFontPath(style: LayoutNode["textStyle"] | undefined): string {
  const postScript = style?.fontPostScriptName?.trim();
  const lowerPostScript = postScript?.toLowerCase();
  const fromPostScript =
    (postScript ? FONT_BY_POSTSCRIPT[postScript] : undefined) ||
    (lowerPostScript ? FONT_BY_POSTSCRIPT[lowerPostScript] : undefined);
  if (fromPostScript) {
    return path.join(process.cwd(), "assets", "fonts", "gothampro", fromPostScript);
  }

  const family = style?.fontFamily?.toLowerCase() ?? "";
  const weight = style?.fontWeight ?? 400;
  const isItalic = lowerPostScript?.includes("italic") ?? false;
  if (family.includes("gotham")) {
    if (weight >= 800) {
      return path.join(process.cwd(), "assets", "fonts", "gothampro", isItalic ? "gothampro_blackitalic.ttf" : "gothampro_black.ttf");
    }
    if (weight >= 700) {
      return path.join(process.cwd(), "assets", "fonts", "gothampro", isItalic ? "gothampro_bolditalic.ttf" : "gothampro_bold.ttf");
    }
    if (weight >= 500) {
      return path.join(process.cwd(), "assets", "fonts", "gothampro", isItalic ? "gothampro_mediumitalic.ttf" : "gothampro_medium.ttf");
    }
    return path.join(process.cwd(), "assets", "fonts", "gothampro", isItalic ? "gothampro_italic.ttf" : "gothampro.ttf");
  }

  if (postScript) {
    console.warn(`Unknown fontPostScriptName: ${postScript}. Falling back to GothamPro-Bold`);
  }
  return path.join(process.cwd(), "assets", "fonts", "gothampro", "gothampro_bold.ttf");
}

async function createSolidRectLayer(
  node: LayoutNode,
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  badBoxes: Array<{ label: string; box: SafeBox | null }>,
  offsetX = 0,
  offsetY = 0,
  forceBbox?: { x: number; y: number; width: number; height: number }
): Promise<Layer | null> {
  const baseBbox = forceBbox ?? toRelativeBbox(node, frameX, frameY);
  const raw = offsetRelativeBbox(baseBbox, offsetX, offsetY);
  const bbox = sanitizeBox(
    raw ? { left: raw.x, top: raw.y, width: raw.width, height: raw.height } : null,
    frameW,
    frameH,
    `solid:${node.name}:${node.id}`,
    badBoxes
  );
  if (!bbox) return null;

  const fill = getPrimaryFill(node);
  if (!fill) return null;

  const width = bbox.width;
  const height = bbox.height;
  const effectiveAlpha = clamp(fill.a * node.opacity, 0, 1);
  const cssFill = rgbaToCss({ ...fill, a: effectiveAlpha });
  const radii = getRadii(node);
  const pathData = buildRoundedRectPath(width, height, radii);
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${pathData}" fill="${cssFill}"/></svg>`
  );

  return {
    nodeId: node.id,
    left: bbox.left,
    top: bbox.top,
    width,
    height,
    input: await sharp(svg).png().toBuffer()
  };
}

async function getUploadBuffer(objectKey: string): Promise<Buffer> {
  const source = await getObject(objectKey);
  if (!source.Body) {
    throw new Error(`Source object body is empty for key ${objectKey}`);
  }
  return streamToBuffer(source.Body);
}

async function getSnapshotAssetBuffer(assetKey: string, cache: Map<string, Buffer>): Promise<Buffer> {
  const cached = cache.get(assetKey);
  if (cached) return cached;
  const source = await getObject(assetKey);
  if (!source.Body) {
    throw new Error(`Snapshot asset body is empty for key ${assetKey}`);
  }
  const buffer = await streamToBuffer(source.Body);
  cache.set(assetKey, buffer);
  return buffer;
}

function isObjectNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("$metadata" in error && typeof error.$metadata === "object" && error.$metadata) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (metadata.httpStatusCode === 404) return true;
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name === "NoSuchKey" || error.name === "NotFound";
  }
  return false;
}

async function applyOpacityToPng(input: Buffer, opacity: number): Promise<Buffer> {
  const normalized = clamp(opacity, 0, 1);
  if (normalized >= 0.999) return input;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += info.channels) {
    data[i] = Math.round(data[i] * normalized);
  }
  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels
    }
  })
    .png()
    .toBuffer();
}

async function renderEditablePhoto(
  node: LayoutNode,
  fields: Record<string, string>,
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  fieldsUsed: Set<string>,
  badBoxes: Array<{ label: string; box: SafeBox | null }>,
  markPhotoSkipped: (reason: string) => void,
  computedBox?: LayoutBox,
  offsetX = 0,
  offsetY = 0
): Promise<{ layer: Layer | null; photoDebug?: NonNullable<UniversalRenderDebug["photoLayers"]>[number] }> {
  const objectKey = fields[node.name];
  if (!objectKey || !node.bbox) return { layer: null };

  fieldsUsed.add(node.name);

  const rawRel = computedBox
    ? { x: computedBox.x, y: computedBox.y, width: computedBox.width, height: computedBox.height }
    : offsetRelativeBbox(toRelativeBbox(node, frameX, frameY), offsetX, offsetY);
  const rel = sanitizeBox(
    rawRel ? { left: rawRel.x, top: rawRel.y, width: rawRel.width, height: rawRel.height } : null,
    frameW,
    frameH,
    `photo:${node.name}:${node.id}`,
    badBoxes
  );
  if (!rel) {
    markPhotoSkipped(`invalid-photo-box:${node.id}`);
    return { layer: null };
  }

  const width = rel.width;
  const height = rel.height;
  const source = await getUploadBuffer(objectKey);
  const radii = getRadii(node);
  const pathData = buildRoundedRectPath(width, height, radii);

  const maskSvg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${pathData}" fill="#fff"/></svg>`
  );

  const image = await sharp(source).resize(width, height, { fit: "cover" }).ensureAlpha().png().toBuffer();
  const input = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: image, left: 0, top: 0 },
      { input: maskSvg, left: 0, top: 0, blend: "dest-in" }
    ])
    .png()
    .toBuffer();

  const finalLayer: Layer = {
    nodeId: node.id,
    left: rel.left,
    top: rel.top,
    width,
    height,
    input
  };
  const finalMeta = await sharp(input).metadata();
  if (process.env.DEBUG_RENDER === "1") {
    console.warn("[universalEngine] photo-layer", {
      name: node.name,
      targetW: width,
      targetH: height,
      actualW: finalMeta.width ?? 0,
      actualH: finalMeta.height ?? 0,
      left: rel.left,
      top: rel.top
    });
  }
  return {
    layer: finalLayer,
    photoDebug: {
      name: node.name,
      targetW: width,
      targetH: height,
      actualW: finalMeta.width ?? 0,
      actualH: finalMeta.height ?? 0,
      left: finalLayer.left,
      top: finalLayer.top
    }
  };
}

function clampLinesByHeight(
  lines: string[],
  maxHeight: number,
  lineHeightPx: number,
  ascPx: number,
  descPx: number
): string[] {
  if (lines.length === 0) return [""];
  const lineBox = ascPx + descPx;
  if (lineHeightPx <= 0 || lineBox <= 0 || maxHeight <= 0) return [""];

  let maxLines = 0;
  while (maxLines < lines.length) {
    const h = (maxLines === 0 ? 0 : maxLines * lineHeightPx - lineHeightPx) + lineBox;
    if (h <= maxHeight) {
      maxLines += 1;
    } else {
      break;
    }
  }

  return lines.slice(0, Math.max(1, maxLines));
}

function getEditableTextValue(node: LayoutNode, fields: Record<string, string>, fieldsUsed: Set<string>): string {
  let base: string;
  if (Object.prototype.hasOwnProperty.call(fields, node.name)) {
    fieldsUsed.add(node.name);
    base = fields[node.name] ?? "";
  } else {
    base = node.characters ?? "";
  }

  if (node.name.toLowerCase() === "text_quote") {
    let t = base.trim();
    const hadTrailingDot = t.endsWith(".");
    if (t.endsWith(".")) {
      t = t.slice(0, -1).trimEnd();
    }
    const hasStrongEnding = t.endsWith("!") || t.endsWith("?");
    const suffix = hadTrailingDot && !hasStrongEnding ? "." : "";
    return `\u2014\u00A0\u00AB${t}\u00BB${suffix}`;
  }
  return base;
}

async function measureTextBlock(
  node: LayoutNode,
  rawText: string,
  maxTextWidth: number
): Promise<MeasuredTextBlock> {
  const style = node.textStyle ?? {};
  const fontSize = style.fontSize && style.fontSize > 0 ? style.fontSize : 16;
  const lineHeightPx =
    typeof style.lineHeightPx === "number" && style.lineHeightPx > 0
      ? style.lineHeightPx
      : typeof style.lineHeightPercentFontSize === "number" && style.lineHeightPercentFontSize > 0
        ? fontSize * (style.lineHeightPercentFontSize / 100)
        : typeof style.lineHeightPercent === "number" && style.lineHeightPercent > 0
          ? fontSize * (style.lineHeightPercent / 100)
        : fontSize;
  const letterSpacing = typeof style.letterSpacing === "number" ? style.letterSpacing : 0;
  const fontPath = resolveFontPath(style);
  const font = await loadFontCached(fontPath);
  const metrics = getFontMetricsPx(font, fontSize);
  const lines = wrapTextByWords(rawText, maxTextWidth, font, fontSize, letterSpacing);
  const safeLines = lines.length > 0 ? lines : [""];
  const lineWidthsPx = safeLines.map((line) => measureTextPx(line, font, fontSize, letterSpacing));
  const maxLineWidthPx = lineWidthsPx.reduce((maxWidth, lineWidth) => Math.max(maxWidth, lineWidth), 0);
  const textAlignHorizontal =
    style.textAlignHorizontal === "CENTER" || style.textAlignHorizontal === "RIGHT" ? style.textAlignHorizontal : "LEFT";
  const textBlockHeightPx = (safeLines.length - 1) * lineHeightPx + (metrics.ascPx + metrics.descPx);
  return {
    node,
    lines: safeLines,
    lineWidthsPx,
    maxLineWidthPx,
    textBlockHeightPx,
    lineHeightPx,
    letterSpacing,
    fontSize,
    font,
    metrics,
    textAlignHorizontal,
    color: getPrimaryFill(node) ?? { r: 0, g: 0, b: 0, a: 1 }
  };
}

function getAlignedLineStartX(
  align: "LEFT" | "CENTER" | "RIGHT",
  innerLeft: number,
  innerWidth: number,
  lineWidth: number
): number {
  if (align === "CENTER") {
    return innerLeft + (innerWidth - lineWidth) / 2;
  }
  if (align === "RIGHT") {
    return innerLeft + (innerWidth - lineWidth);
  }
  return innerLeft;
}

function buildAlignedTextPaths(
  item: MeasuredTextBlock,
  innerLeft: number,
  innerWidth: number,
  firstBaselineY: number
): string {
  let out = "";
  for (let lineIndex = 0; lineIndex < item.lines.length; lineIndex += 1) {
    const line = item.lines[lineIndex];
    if (!line) continue;
    const baselineY = firstBaselineY + lineIndex * item.lineHeightPx;
    const lineWidth = item.lineWidthsPx[lineIndex] ?? 0;
    const lineStartX = getAlignedLineStartX(item.textAlignHorizontal, innerLeft, innerWidth, lineWidth);
    out += buildSvgPathsForLines(item.font, [line], lineStartX, baselineY, item.fontSize, item.lineHeightPx);
  }
  return out;
}

function normalizeAxisAlign(value: string | undefined): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
  if (value === "CENTER") return "CENTER";
  if (value === "MAX") return "MAX";
  if (value === "SPACE_BETWEEN") return "SPACE_BETWEEN";
  return "MIN";
}

function alignOffset(
  align: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN",
  innerSize: number,
  contentSize: number
): number {
  if (align === "CENTER") return Math.max(0, (innerSize - contentSize) / 2);
  if (align === "MAX") return Math.max(0, innerSize - contentSize);
  return 0;
}

function getManualAssetType(name: string): "sticker" | "marks" | null {
  const normalized = name.trim().toLowerCase();
  if (normalized === "sticker") return "sticker";
  if (normalized === "marks") return "marks";
  return null;
}

async function renderEditableText(
  nodes: LayoutNode[],
  treeById: Map<string, LayoutNode>,
  fields: Record<string, string>,
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  fieldsUsed: Set<string>,
  badBoxes: Array<{ label: string; box: SafeBox | null }>,
  forcedContainer?: LayoutNode,
  computedContainerBox?: LayoutBox,
  computedBoxes?: Map<string, LayoutBox>
): Promise<{ layer: Layer | null; debug?: EditableTextDebug }> {
  if (nodes.length === 0) return { layer: null };
  const node = nodes[0];
  if (!node.bbox) return { layer: null };

  const container = forcedContainer ?? findNearestResizableContainer(node, treeById);
  const target = container ?? node;
  const rawRel = computedContainerBox
    ? { x: computedContainerBox.x, y: computedContainerBox.y, width: computedContainerBox.width, height: computedContainerBox.height }
    : toRelativeBbox(target, frameX, frameY);
  const safeRel = sanitizeBox(
    rawRel ? { left: rawRel.x, top: rawRel.y, width: rawRel.width, height: rawRel.height } : null,
    frameW,
    frameH,
    `text-container:${target.name}:${target.id}`,
    badBoxes
  );
  if (!safeRel) return { layer: null };
  const rel = { x: safeRel.left, y: safeRel.top, width: safeRel.width, height: safeRel.height };

  const paddingLeft = container ? container.paddingLeft ?? 0 : 0;
  const paddingRight = container ? container.paddingRight ?? 0 : 0;
  const paddingTop = container ? container.paddingTop ?? 0 : 0;
  const paddingBottom = container ? container.paddingBottom ?? 0 : 0;

  const origX = rel.x;
  const origY = rel.y;
  const origW = Math.max(1, rel.width);
  const origH = Math.max(1, rel.height);

  const constraintH = (container?.constraints?.horizontal ?? node.constraints?.horizontal ?? "LEFT") as string;
  const constraintV = (container?.constraints?.vertical ?? node.constraints?.vertical ?? "TOP") as string;

  const rawTexts = nodes.map((textNode) => getEditableTextValue(textNode, fields, fieldsUsed));
  const nodeWrapWidths = nodes.map((textNode) => {
    const childBox = computedBoxes?.get(textNode.id);
    return childBox ? Math.max(1, childBox.width) : undefined;
  });
  const marginSafe = 150;
  const eps = 2;
  const isFixed = isFixedContainer(container);
  let anchor: "left" | "right" | "center" | "free" = "free";
  if (container) {
    const constraintHorizontal = container.constraints?.horizontal ?? node.constraints?.horizontal;
    if (constraintHorizontal === "CENTER") {
      anchor = "center";
    } else if (constraintHorizontal === "LEFT") {
      anchor = "left";
    } else if (constraintHorizontal === "RIGHT") {
      anchor = "right";
    } else if (Math.abs(rel.x - 0) <= eps) {
      anchor = "left";
    } else if (Math.abs(rel.x + rel.width - frameW) <= eps) {
      anchor = "right";
    } else if (Math.abs(rel.x + rel.width / 2 - frameW / 2) <= 4) {
      anchor = "center";
    } else {
      anchor = "free";
    }
  }

  const maxWForAnchor = container
    ? anchor === "center"
      ? Math.max(1, frameW - marginSafe * 2)
      : Math.max(1, frameW - marginSafe)
    : Math.max(1, origW);
  let maxTextWidth = container
    ? Math.max(1, (isFixed ? origW : maxWForAnchor) - paddingLeft - paddingRight)
    : Math.max(1, origW);
  const isAutoLayoutContainer = Boolean(container && container.layoutMode && container.layoutMode !== "NONE");
  const itemSpacing = container ? (Number.isFinite(container.itemSpacing) ? (container.itemSpacing as number) : 50) : 0;
  const resolveWrapWidthForNode = (nodeIndex: number, innerW: number): number => {
    const childW = nodeWrapWidths[nodeIndex];
    if (
      isAutoLayoutContainer &&
      container?.layoutMode === "HORIZONTAL" &&
      typeof childW === "number" &&
      Number.isFinite(childW)
    ) {
      return Math.max(1, Math.min(innerW, childW));
    }
    return Math.max(1, innerW);
  };

  const initialInnerW = maxTextWidth;
  const measuredA = await Promise.all(
    nodes.map((textNode, index) => {
      const wrapW = resolveWrapWidthForNode(index, initialInnerW);
      return measureTextBlock(textNode, rawTexts[index], wrapW);
    })
  );
  const measuredTextW_A = measuredA.reduce((maxWidth, item) => Math.max(maxWidth, item.maxLineWidthPx), 0);
  const tentativePillW = container
    ? isFixed
      ? origW
      : clamp(measuredTextW_A + paddingLeft + paddingRight, 1, maxWForAnchor)
    : origW;
  const finalPillW = Math.max(1, tentativePillW);
  const finalInnerW = container ? Math.max(1, finalPillW - paddingLeft - paddingRight) : Math.max(1, origW);

  const measuredB = await Promise.all(
    nodes.map((textNode, index) => {
      const wrapW = resolveWrapWidthForNode(index, finalInnerW);
      return measureTextBlock(textNode, rawTexts[index], wrapW);
    })
  );
  const measuredTextW_B = measuredB.reduce((maxWidth, item) => Math.max(maxWidth, item.maxLineWidthPx), 0);
  let blockW = container
    ? isFixed
      ? origW
      : clamp(measuredTextW_B + paddingLeft + paddingRight, 1, maxWForAnchor)
    : origW;
  maxTextWidth = finalInnerW;
  const measured = measuredB;

  const textBlockHeightPx = isAutoLayoutContainer
    ? measured.reduce((sum, item) => sum + item.textBlockHeightPx, 0) + Math.max(0, measured.length - 1) * itemSpacing
    : measured.length > 0
      ? measured[0].textBlockHeightPx
      : 0;
  let blockH = container ? (isFixed ? origH : paddingTop + textBlockHeightPx + paddingBottom) : origH;

  let newX = origX;
  let newY = origY;

  if (container && !isFixed) {
    if (anchor === "left") {
      newX = 0;
    } else if (anchor === "right") {
      newX = frameW - blockW;
      if (newX < marginSafe) {
        newX = marginSafe;
      }
    } else if (anchor === "center") {
      newX = Math.round(frameW / 2 - blockW / 2);
    } else {
      newX = origX;
    }
  } else if (container && isFixed) {
    newX = origX;
  } else if (constraintH === "RIGHT") {
    newX = origX + origW - blockW;
  } else if (constraintH === "CENTER") {
    newX = origX + origW / 2 - blockW / 2;
  }

  if (container && isFixed) {
    newY = origY;
  } else if (constraintV === "BOTTOM") {
    newY = origY + origH - blockH;
  } else if (constraintV === "CENTER") {
    newY = origY + origH / 2 - blockH / 2;
  } else if (constraintV === "TOP_BOTTOM") {
    newY = origY;
    blockH = origH;
    const contentHeight = Math.max(1, blockH - paddingTop - paddingBottom);
    if (measured.length > 0) {
      const first = measured[0];
      first.lines = clampLinesByHeight(
        first.lines,
        contentHeight,
        first.lineHeightPx,
        first.metrics.ascPx,
        first.metrics.descPx
      );
      first.textBlockHeightPx =
        (first.lines.length - 1) * first.lineHeightPx + (first.metrics.ascPx + first.metrics.descPx);
    }
  }

  blockW = Math.max(1, blockW);
  blockH = Math.max(1, blockH);

  newX = clamp(newX, 0, Math.max(0, frameW - blockW));
  newY = clamp(newY, 0, Math.max(0, frameH - blockH));

  const innerTop = paddingTop;
  const innerBottom = blockH - paddingBottom;
  const innerHeight = Math.max(1, innerBottom - innerTop);
  const innerLeft = paddingLeft;
  const innerWidth = Math.max(1, blockW - paddingLeft - paddingRight);
  const contentHeight = measured.length > 0
    ? isAutoLayoutContainer && container?.layoutMode === "HORIZONTAL"
      ? measured.reduce((max, item) => Math.max(max, item.textBlockHeightPx), 0)
      : measured.reduce((sum, item) => sum + item.textBlockHeightPx, 0) + Math.max(0, measured.length - 1) * (isAutoLayoutContainer ? itemSpacing : 0)
    : 0;
  const contentWidth = measured.length > 0
    ? isAutoLayoutContainer && container?.layoutMode === "HORIZONTAL"
      ? measured.reduce((sum, item) => sum + item.maxLineWidthPx, 0) + Math.max(0, measured.length - 1) * itemSpacing
      : measured.reduce((max, item) => Math.max(max, item.maxLineWidthPx), 0)
    : 0;
  const primaryAlign = normalizeAxisAlign(container?.primaryAxisAlignItems);
  const counterAlign = normalizeAxisAlign(container?.counterAxisAlignItems);
  const isHorizontalLayout = container?.layoutMode === "HORIZONTAL";
  const contentTop = isHorizontalLayout
    ? innerTop + alignOffset(counterAlign, innerHeight, contentHeight)
    : innerTop + alignOffset(primaryAlign, innerHeight, contentHeight);
  const contentLeft = isHorizontalLayout
    ? innerLeft + alignOffset(primaryAlign, innerWidth, contentWidth)
    : innerLeft + alignOffset(counterAlign, innerWidth, contentWidth);
  const linesA = measuredA.reduce((sum, item) => sum + item.lines.length, 0);
  const linesB = measured.reduce((sum, item) => sum + item.lines.length, 0);
  const ascent = measured.length > 0 ? measured[0].metrics.ascPx : 0;

  if (process.env.DEBUG_RENDER === "1" && container) {
    console.warn("[universalEngine] pill-content-center", {
      pillName: container.name || node.name,
      layoutMode: container.layoutMode,
      primaryAxisAlignItems: container.primaryAxisAlignItems,
      counterAxisAlignItems: container.counterAxisAlignItems,
      initialInnerW,
      finalPillW: blockW,
      finalInnerW: innerWidth,
      linesA,
      linesB,
      pillH: blockH,
      paddingTop,
      paddingBottom,
      innerH: innerHeight,
      contentHeight,
      computedContentTop: contentTop,
      ascent
    });
    if (linesA !== linesB) {
      console.warn("[universalEngine] wrap-changed-after-final-width", {
        pillName: container.name || node.name,
        linesA,
        linesB
      });
    }
  }

  let textPaths = "";
  if (isAutoLayoutContainer && measured.length > 0) {
    let cursorY = contentTop;
    let cursorX = contentLeft;
    for (const item of measured) {
      const itemInnerWidth = isHorizontalLayout
        ? Math.max(1, Math.min(innerWidth, item.maxLineWidthPx))
        : Math.max(1, Math.min(innerWidth, item.maxLineWidthPx));
      const itemH = Math.max(1, item.textBlockHeightPx);
      const itemLeft = isHorizontalLayout
        ? cursorX
        : innerLeft + alignOffset(counterAlign, innerWidth, itemInnerWidth);
      const itemTop = isHorizontalLayout
        ? innerTop + alignOffset(counterAlign, innerHeight, itemH)
        : cursorY;
      const baselineY = itemTop + item.metrics.ascPx;
      const paths = buildAlignedTextPaths(item, itemLeft, itemInnerWidth, baselineY);
      textPaths += `<g fill="${rgbaToCss(item.color)}">${paths}</g>`;
      if (isHorizontalLayout) {
        cursorX += itemInnerWidth + itemSpacing;
      } else {
        cursorY += itemH + itemSpacing;
      }
    }
  } else if (measured.length > 0) {
    const item = measured[0];
    const textTopY = contentTop;
    const baselineY = textTopY + item.metrics.ascPx;
    const itemInnerWidth = Math.max(1, Math.min(innerWidth, item.maxLineWidthPx));
    const itemLeft = innerLeft + alignOffset(counterAlign, innerWidth, itemInnerWidth);
    const paths = buildAlignedTextPaths(item, itemLeft, itemInnerWidth, baselineY);
    textPaths = `<g fill="${rgbaToCss(item.color)}">${paths}</g>`;
  }

  const width = ensureLayerGeometry(blockW, 1);
  const height = ensureLayerGeometry(blockH, 1);
  const containerFill = container ? getPrimaryFill(container) : undefined;
  const containerPath = buildRoundedRectPath(width, height, container ? getRadii(container) : [0, 0, 0, 0]);

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      (containerFill
        ? `<path d="${containerPath}" fill="${rgbaToCss({ ...containerFill, a: containerFill.a * (container?.opacity ?? 1) })}"/>`
        : "") +
      textPaths +
      `</svg>`
  );

  const layer: Layer = {
    nodeId: node.id,
    left: toInt(newX),
    top: toInt(newY),
    width,
    height,
    input: await sharp(svg).png().toBuffer()
  };

  const safeLayerBox = sanitizeBox(
    { left: layer.left, top: layer.top, width: layer.width, height: layer.height },
    frameW,
    frameH,
    `text-layer:${node.name}:${node.id}`,
    badBoxes
  );
  if (!safeLayerBox) {
    return { layer: null };
  }
  layer.left = safeLayerBox.left;
  layer.top = safeLayerBox.top;
  layer.width = safeLayerBox.width;
  layer.height = safeLayerBox.height;

  return {
    layer,
    debug: {
      name: node.name,
      origBBox: {
        x: toInt(origX),
        y: toInt(origY),
        width: toInt(origW),
        height: toInt(origH)
      },
      newBBox: {
        x: layer.left,
        y: layer.top,
        width,
        height
      },
      constraintH,
      constraintV,
      origW: Math.max(1, Math.round(origW)),
      isExplicitWidth: false,
      isFixedWidth: isFixed,
      containerW: Math.max(1, Math.round(container?.bbox?.width ?? origW)),
      paddingL: Math.max(0, Math.round(paddingLeft)),
      paddingR: Math.max(0, Math.round(paddingRight)),
      maxTextWidth: Math.max(1, Math.round(maxTextWidth)),
      linesCount: linesB,
      linesA,
      linesB,
      finalBlockW: width,
      textH: Math.max(1, Math.round(textBlockHeightPx)),
      initialInnerW: Math.max(1, Math.round(initialInnerW)),
      finalInnerW: Math.max(1, Math.round(innerWidth)),
      innerH: Math.max(1, Math.round(innerHeight)),
      contentTop: Math.max(0, Math.round(contentTop)),
      ascent: Math.max(0, Math.round(ascent)),
      layoutMode: container?.layoutMode,
      primaryAxisAlignItems: container?.primaryAxisAlignItems,
      counterAxisAlignItems: container?.counterAxisAlignItems
    }
  };
}

function collectNodes(root: LayoutNode): LayoutNode[] {
  const out: LayoutNode[] = [];

  function walk(node: LayoutNode) {
    out.push(node);
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return out;
}

type RenderTreeContext = {
  templateId: string;
  frameX: number;
  frameY: number;
  frameW: number;
  frameH: number;
  fields: Record<string, string>;
  fieldsUsed: Set<string>;
  treeById: Map<string, LayoutNode>;
  containerTextMap: Map<string, LayoutNode[]>;
  handledTextNodeIds: Set<string>;
  editableDebug: EditableTextDebug[];
  textContainerDebug: UniversalRenderDebug["textContainers"];
  assetsCache: Map<string, Buffer>;
  assetsMap: Record<string, string>;
  badBoxes: Array<{ label: string; box: SafeBox | null }>;
  skippedPhoto: boolean;
  skippedPhotoReason: string[];
  photoLayers: NonNullable<UniversalRenderDebug["photoLayers"]>;
  computedBoxes: Map<string, LayoutBox>;
};

function computeIntrinsicSize(
  node: LayoutNode,
  cache: Map<string, { width: number; height: number }>
): { width: number; height: number } {
  const cached = cache.get(node.id);
  if (cached) return cached;

  const fallback = {
    width: Math.max(1, node.bbox?.width ?? 1),
    height: Math.max(1, node.bbox?.height ?? 1)
  };

  if (!node.layoutMode || node.layoutMode === "NONE" || node.children.length === 0) {
    cache.set(node.id, fallback);
    return fallback;
  }

  const paddingLeft = node.paddingLeft ?? 0;
  const paddingRight = node.paddingRight ?? 0;
  const paddingTop = node.paddingTop ?? 0;
  const paddingBottom = node.paddingBottom ?? 0;
  const spacing = Number.isFinite(node.itemSpacing) ? (node.itemSpacing as number) : 50;
  const childSizes = node.children.map((child) => computeIntrinsicSize(child, cache));

  let contentW = 0;
  let contentH = 0;
  if (node.layoutMode === "HORIZONTAL") {
    contentW = childSizes.reduce((sum, size) => sum + size.width, 0) + Math.max(0, childSizes.length - 1) * spacing;
    contentH = childSizes.reduce((max, size) => Math.max(max, size.height), 0);
  } else {
    contentW = childSizes.reduce((max, size) => Math.max(max, size.width), 0);
    contentH = childSizes.reduce((sum, size) => sum + size.height, 0) + Math.max(0, childSizes.length - 1) * spacing;
  }

  const intrinsic = {
    width: Math.max(1, paddingLeft + contentW + paddingRight),
    height: Math.max(1, paddingTop + contentH + paddingBottom)
  };
  const result = isFixedContainer(node) ? fallback : intrinsic;
  cache.set(node.id, result);
  return result;
}

function getRawRelativeBox(node: LayoutNode, frameX: number, frameY: number): LayoutBox | null {
  const rel = toRelativeBbox(node, frameX, frameY);
  if (!rel) return null;
  return { x: rel.x, y: rel.y, width: Math.max(1, rel.width), height: Math.max(1, rel.height) };
}

function getSizingMode(node: LayoutNode, axis: "horizontal" | "vertical"): "FIXED" | "HUG" | "FILL" {
  if (axis === "horizontal") {
    if (node.layoutSizingHorizontal === "FILL") return "FILL";
    if (node.layoutSizingHorizontal === "HUG") return "HUG";
    if (node.layoutSizingHorizontal === "FIXED") return "FIXED";
    if (node.counterAxisSizingMode === "FIXED") return "FIXED";
    if (node.constraints?.horizontal === "LEFT_RIGHT") return "FILL";
    return "HUG";
  }
  if (node.layoutSizingVertical === "FILL") return "FILL";
  if (node.layoutSizingVertical === "HUG") return "HUG";
  if (node.layoutSizingVertical === "FIXED") return "FIXED";
  if (node.primaryAxisSizingMode === "FIXED") return "FIXED";
  if (node.constraints?.vertical === "TOP_BOTTOM") return "FILL";
  return "HUG";
}

function buildComputedLayoutBoxes(root: LayoutNode, frameX: number, frameY: number): Map<string, LayoutBox> {
  const boxes = new Map<string, LayoutBox>();
  const intrinsicCache = new Map<string, { width: number; height: number }>();

  function assign(node: LayoutNode, forcedBox?: LayoutBox) {
    const rawBox = getRawRelativeBox(node, frameX, frameY);
    const nodeBox = forcedBox ?? rawBox;
    if (!nodeBox) return;
    boxes.set(node.id, nodeBox);

    if (!node.layoutMode || node.layoutMode === "NONE" || node.children.length === 0) {
      for (const child of node.children) {
        assign(child);
      }
      return;
    }

    const padL = node.paddingLeft ?? 0;
    const padR = node.paddingRight ?? 0;
    const padT = node.paddingTop ?? 0;
    const padB = node.paddingBottom ?? 0;
    const gap = Number.isFinite(node.itemSpacing) ? (node.itemSpacing as number) : 50;
    const innerX = nodeBox.x + padL;
    const innerY = nodeBox.y + padT;
    const innerW = Math.max(1, nodeBox.width - padL - padR);
    const innerH = Math.max(1, nodeBox.height - padT - padB);
    const mainAxis: "horizontal" | "vertical" = node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical";
    const crossAxis: "horizontal" | "vertical" = mainAxis === "horizontal" ? "vertical" : "horizontal";

    const childSpecs = node.children
      .filter((child) => child.visible !== false)
      .map((child) => {
        const raw = getRawRelativeBox(child, frameX, frameY);
        const intrinsic = computeIntrinsicSize(child, intrinsicCache);
        const rawW = raw?.width ?? intrinsic.width;
        const rawH = raw?.height ?? intrinsic.height;
        return { child, rawW, rawH, intrinsic };
      });

    let fixedMainTotal = 0;
    let fillCount = 0;
    for (const spec of childSpecs) {
      const mainMode = getSizingMode(spec.child, mainAxis);
      if (mainMode === "FILL") {
        fillCount += 1;
        continue;
      }
      const mainSize =
        mainAxis === "horizontal"
          ? mainMode === "HUG"
            ? spec.intrinsic.width
            : spec.rawW
          : mainMode === "HUG"
            ? spec.intrinsic.height
            : spec.rawH;
      fixedMainTotal += Math.max(1, mainSize);
    }
    const totalSpacing = Math.max(0, childSpecs.length - 1) * gap;
    const innerMain = mainAxis === "horizontal" ? innerW : innerH;
    const leftoverMain = Math.max(0, innerMain - fixedMainTotal - totalSpacing);
    const fillMainSize = fillCount > 0 ? Math.max(1, Math.floor(leftoverMain / fillCount)) : 0;

    let cursor = 0;
    for (const spec of childSpecs) {
      const mainMode = getSizingMode(spec.child, mainAxis);
      const crossMode = getSizingMode(spec.child, crossAxis);
      const childMain =
        mainMode === "FILL"
          ? fillMainSize
          : mainAxis === "horizontal"
            ? mainMode === "HUG"
              ? spec.intrinsic.width
              : spec.rawW
            : mainMode === "HUG"
              ? spec.intrinsic.height
              : spec.rawH;
      const innerCross = crossAxis === "horizontal" ? innerW : innerH;
      const childCross =
        crossMode === "FILL"
          ? innerCross
          : crossAxis === "horizontal"
            ? crossMode === "HUG"
              ? spec.intrinsic.width
              : spec.rawW
            : crossMode === "HUG"
              ? spec.intrinsic.height
              : spec.rawH;

      const box: LayoutBox =
        mainAxis === "horizontal"
          ? {
              x: innerX + cursor,
              y: innerY,
              width: Math.max(1, childMain),
              height: Math.max(1, childCross)
            }
          : {
              x: innerX,
              y: innerY + cursor,
              width: Math.max(1, childCross),
              height: Math.max(1, childMain)
            };

      assign(spec.child, box);
      cursor += Math.max(1, childMain) + gap;
    }
  }

  assign(root);
  return boxes;
}

async function renderNodeTree(
  node: LayoutNode,
  context: RenderTreeContext
): Promise<Layer[]> {
  if (!node.visible) return [];

  const layers: Layer[] = [];
  const editableKind = getEditableKind(node.name);
  const nodeComputedRel = context.computedBoxes.get(node.id) ?? getRawRelativeBox(node, context.frameX, context.frameY);

  if (editableKind === "image") {
    const photoRendered = await renderEditablePhoto(
      node,
      context.fields,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.fieldsUsed,
      context.badBoxes,
      (reason) => {
        context.skippedPhoto = true;
        context.skippedPhotoReason.push(reason);
      },
      nodeComputedRel ?? undefined
    );
    if (photoRendered.layer) layers.push(photoRendered.layer);
    if (photoRendered.photoDebug) context.photoLayers.push(photoRendered.photoDebug);
    return layers;
  }

  if (editableKind === "text") {
    if (context.handledTextNodeIds.has(node.id)) {
      return layers;
    }
    const rendered = await renderEditableText(
      [node],
      context.treeById,
      context.fields,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.fieldsUsed,
      context.badBoxes,
      undefined,
      nodeComputedRel ?? undefined,
      context.computedBoxes
    );
    if (rendered.layer) layers.push(rendered.layer);
    if (rendered.debug) context.editableDebug.push(rendered.debug);
    return layers;
  }

  const mappedTextNodes = context.containerTextMap.get(node.id);
  const renderSelfAsDynamicContainer = Boolean(mappedTextNodes && mappedTextNodes.length > 0);
  let dynamicRendered: { layer: Layer | null; debug?: EditableTextDebug } | null = null;

  if (renderSelfAsDynamicContainer && mappedTextNodes) {
    dynamicRendered = await renderEditableText(
      mappedTextNodes,
      context.treeById,
      context.fields,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.fieldsUsed,
      context.badBoxes,
      node,
      nodeComputedRel ?? undefined,
      context.computedBoxes
    );
    if (dynamicRendered.layer) layers.push(dynamicRendered.layer);
    if (dynamicRendered.debug) context.editableDebug.push(dynamicRendered.debug);
  } else if (node.bbox && getManualAssetType(node.name) && !context.assetsMap[node.id]) {
    const manualType = getManualAssetType(node.name);
    const relRaw = nodeComputedRel;
    const rel = sanitizeBox(
      relRaw ? { left: relRaw.x, top: relRaw.y, width: relRaw.width, height: relRaw.height } : null,
      context.frameW,
      context.frameH,
      `manual-asset:${node.name}:${node.id}`,
      context.badBoxes
    );
    if (rel && manualType) {
      const width = rel.width;
      const height = rel.height;
      const safeFrameId = toSafeFrameId(context.templateId);
      const genericKey = `assets/manual-assets/${safeFrameId}.png`;
      const candidates =
        manualType === "sticker"
          ? [`assets/manual-assets/${safeFrameId}__sticker.png`, genericKey]
          : [`assets/manual-assets/${safeFrameId}__marks.png`, genericKey];
      let manualBuffer: Buffer | null = null;
      for (const candidateKey of candidates) {
        try {
          manualBuffer = await getSnapshotAssetBuffer(candidateKey, context.assetsCache);
          if (manualBuffer) break;
        } catch (error) {
          if (isObjectNotFoundError(error)) {
            continue;
          }
          throw error;
        }
      }
      if (manualBuffer) {
        let buffer = await sharp(manualBuffer).resize(width, height, { fit: "fill" }).png().toBuffer();
        buffer = await applyOpacityToPng(buffer, node.opacity);
        layers.push({
          nodeId: node.id,
          left: rel.left,
          top: rel.top,
          width,
          height,
          input: buffer
        });
      }
    }
    return layers;
  } else if ((node.type === "FRAME" || node.type === "RECTANGLE") && hasSolidFill(node)) {
    const rectLayer = await createSolidRectLayer(
      node,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.badBoxes,
      0,
      0,
      nodeComputedRel ?? undefined
    );
    if (rectLayer) layers.push(rectLayer);
  } else if ((context.assetsMap[node.id] || node.assetKey) && node.bbox) {
    const rel = sanitizeBox(
      nodeComputedRel
        ? { left: nodeComputedRel.x, top: nodeComputedRel.y, width: nodeComputedRel.width, height: nodeComputedRel.height }
        : null,
      context.frameW,
      context.frameH,
      `asset:${node.name}:${node.id}`,
      context.badBoxes
    );
    if (rel) {
      const width = rel.width;
      const height = rel.height;
      const assetKey = context.assetsMap[node.id] || node.assetKey;
      if (!assetKey) return layers;
      let buffer: Buffer;
      try {
        buffer = await getSnapshotAssetBuffer(assetKey, context.assetsCache);
      } catch (error) {
        if (isObjectNotFoundError(error)) {
          return layers;
        }
        throw error;
      }
      buffer = await sharp(buffer).resize(width, height, { fit: "fill" }).png().toBuffer();
      buffer = await applyOpacityToPng(buffer, node.opacity);
      layers.push({
        nodeId: node.id,
        left: rel.left,
        top: rel.top,
        width,
        height,
        input: buffer
      });
    }
    return layers;
  } else if (ATOMIC_IMAGE_TYPES.has(node.type) && hasSolidFill(node)) {
    const fallbackLayer = await createSolidRectLayer(
      node,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.badBoxes,
      0,
      0,
      nodeComputedRel ?? undefined
    );
    if (fallbackLayer) layers.push(fallbackLayer);
    return layers;
  } else if (node.children.length === 0 && node.bbox && hasSolidFill(node)) {
    const fallbackLayer = await createSolidRectLayer(
      node,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.badBoxes,
      0,
      0,
      nodeComputedRel ?? undefined
    );
    if (fallbackLayer) layers.push(fallbackLayer);
  }

  for (const child of node.children) {
    if (mappedTextNodes?.some((textNode) => textNode.id === child.id)) {
      continue;
    }
    const childLayers = await renderNodeTree(child, context);
    layers.push(...childLayers);
  }

  return layers;
}

export async function renderUniversalTemplate(input: {
  templateId: string;
  fields: Record<string, string>;
  frameNode: FigmaNodeLite;
  refresh?: boolean;
  includeDebug?: boolean;
}): Promise<UniversalRenderResult> {
  const tree = buildLayoutTree(input.frameNode as FigmaNodeLite);
  const frame = tree.root;

  if (!frame.bbox) {
    throw new Error("Frame bounding box is missing");
  }

  const frameX = ensureFinite("frameX", frame.bbox.x);
  const frameY = ensureFinite("frameY", frame.bbox.y);
  const frameWidthRaw = frame.bbox.width;
  const frameHeightRaw = frame.bbox.height;
  const frameW =
    Number.isFinite(frameWidthRaw) && frameWidthRaw > 0
      ? ensureLayerGeometry(frameWidthRaw, 1)
      : (console.warn(`[universalEngine] Missing frame width in snapshot for ${input.templateId}, fallback=2000`), 2000);
  const frameH =
    Number.isFinite(frameHeightRaw) && frameHeightRaw > 0
      ? ensureLayerGeometry(frameHeightRaw, 1)
      : (console.warn(`[universalEngine] Missing frame height in snapshot for ${input.templateId}, fallback=2000`), 2000);
  const allNodes = collectNodes(frame);
  const nodeOrder = new Map<string, number>();
  allNodes.forEach((node, index) => {
    nodeOrder.set(node.id, index);
  });
  const editableTextNodes = allNodes.filter((node) => node.visible && getEditableKind(node.name) === "text");
  const containerTextMap = new Map<string, LayoutNode[]>();
  const handledTextNodeIds = new Set<string>();
  for (const textNode of editableTextNodes) {
    const container = findNearestResizableContainer(textNode, tree.byId);
    if (container) {
      const list = containerTextMap.get(container.id) ?? [];
      list.push(textNode);
      containerTextMap.set(container.id, list);
      handledTextNodeIds.add(textNode.id);
    }
  }
  for (const [containerId, list] of containerTextMap.entries()) {
    list.sort((a, b) => (nodeOrder.get(a.id) ?? 0) - (nodeOrder.get(b.id) ?? 0));
    containerTextMap.set(containerId, list);
  }

  const editableDebug: EditableTextDebug[] = [];
  const textContainerDebug: UniversalRenderDebug["textContainers"] = [];
  const fieldsUsed = new Set<string>();
  const badBoxes: Array<{ label: string; box: SafeBox | null }> = [];
  const frameAssetsMap =
    input.frameNode && typeof input.frameNode === "object" && input.frameNode.assetsMap
      ? input.frameNode.assetsMap
      : {};
  const computedBoxes = buildComputedLayoutBoxes(frame, frameX, frameY);
  const renderContext: RenderTreeContext = {
    templateId: input.templateId,
    frameX,
    frameY,
    frameW,
    frameH,
    fields: input.fields,
    fieldsUsed,
    treeById: tree.byId,
    containerTextMap,
    handledTextNodeIds,
    editableDebug,
    textContainerDebug,
    assetsCache: new Map<string, Buffer>(),
    assetsMap: frameAssetsMap,
    badBoxes,
    skippedPhoto: false,
    skippedPhotoReason: [],
    photoLayers: [],
    computedBoxes
  };
  const allLayers = await renderNodeTree(frame, renderContext);

  for (const item of editableDebug) {
    textContainerDebug.push({
      containerName: item.name,
      isFixedWidth: item.isFixedWidth,
      containerW: item.containerW,
      paddingL: item.paddingL,
      paddingR: item.paddingR,
      maxTextWidth: item.maxTextWidth,
      finalPillW: item.finalBlockW,
      lines: item.linesCount,
      textH: item.textH,
      initialInnerW: item.initialInnerW,
      finalInnerW: item.finalInnerW,
      linesA: item.linesA,
      linesB: item.linesB,
      innerH: item.innerH,
      contentTop: item.contentTop,
      ascent: item.ascent,
      layoutMode: item.layoutMode,
      primaryAxisAlignItems: item.primaryAxisAlignItems,
      counterAxisAlignItems: item.counterAxisAlignItems
    });
  }

  const minX = 0;
  const minY = 0;
  const maxX = frameW;
  const maxY = frameH;
  const bigW = frameW;
  const bigH = frameH;
  const paddingLeft = 0;
  const paddingTop = 0;

  const composite: Array<{ input: Buffer; left: number; top: number; blend?: sharp.Blend }> = [];
  for (const layer of allLayers) {
    const normalized = await normalizeCompositeItem(
      frameW,
      frameH,
      {
        input: layer.input,
        left: layer.left,
        top: layer.top,
        width: layer.width,
        height: layer.height
      },
      `composite:${layer.nodeId}`,
      badBoxes
    );
    if (!normalized) continue;
    composite.push({
      input: normalized.input,
      left: normalized.left,
      top: normalized.top,
      blend: normalized.blend
    });
  }

  const frameCanvas = await sharp({
    create: {
      width: bigW,
      height: bigH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composite)
    .png()
    .toBuffer();
  const extractBox = sanitizeBox(
    { left: 0, top: 0, width: frameW, height: frameH },
    frameW,
    frameH,
    "extract:frame",
    badBoxes
  );
  if (!extractBox) {
    throw new Error("Computed frame extract box invalid");
  }
  const png = await sharp(frameCanvas).png().toBuffer();

  if (!input.includeDebug) {
    return { png };
  }

  return {
    png,
    debug: {
      layoutSource: "snapshot_b2",
      frameW,
      frameH,
      fieldsUsed: [...fieldsUsed],
      opsCount: allLayers.length,
      bigCanvas: {
        minX,
        minY,
        maxX,
        maxY,
        bigW,
        bigH,
        paddingLeft,
        paddingTop
      },
      editables: editableDebug,
      textContainers: textContainerDebug,
      badBoxes: badBoxes.length > 0 ? badBoxes : undefined,
      skippedPhoto: renderContext.skippedPhoto ? true : undefined,
      skippedPhotoReason: renderContext.skippedPhotoReason.length > 0 ? renderContext.skippedPhotoReason : undefined,
      photoLayers: renderContext.photoLayers.length > 0 ? renderContext.photoLayers : undefined
    }
  };
}
