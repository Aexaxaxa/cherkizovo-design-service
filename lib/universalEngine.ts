import path from "node:path";
import sharp from "sharp";
import {
  buildLayoutTree,
  containerMaxContentWidth,
  findNearestResizableContainer,
  getEditableKind,
  hasSolidFill,
  isExplicitWidth,
  type FigmaNodeLite,
  type LayoutNode
} from "@/lib/figmaLayout";
import { buildRoundedRectPath } from "@/lib/roundedRectPath";
import { getObject } from "@/lib/s3";
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
    finalBlockW: number;
    textH: number;
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

type EditableTextDebug = UniversalRenderDebug["editables"][number];

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

function getRadii(node: LayoutNode): [number, number, number, number] {
  return node.radii ?? [0, 0, 0, 0];
}

function getPrimaryFill(node: LayoutNode): { r: number; g: number; b: number; a: number } | undefined {
  return node.fills[0];
}

function resolveFontPath(fontPostScriptName: string | undefined): string {
  const fileName = fontPostScriptName ? FONT_BY_POSTSCRIPT[fontPostScriptName] : undefined;
  if (!fileName) {
    if (fontPostScriptName) {
      console.warn(`Unknown fontPostScriptName: ${fontPostScriptName}. Falling back to GothamPro-Bold`);
    }
    return path.join(process.cwd(), "assets", "fonts", "gothampro", "gothampro_bold.ttf");
  }
  return path.join(process.cwd(), "assets", "fonts", "gothampro", fileName);
}

async function createSolidRectLayer(
  node: LayoutNode,
  frameX: number,
  frameY: number,
  forceBbox?: { x: number; y: number; width: number; height: number }
): Promise<Layer | null> {
  const bbox = forceBbox ?? toRelativeBbox(node, frameX, frameY);
  if (!bbox) return null;

  const fill = getPrimaryFill(node);
  if (!fill) return null;

  const width = ensureLayerGeometry(bbox.width, 1);
  const height = ensureLayerGeometry(bbox.height, 1);
  const effectiveAlpha = clamp(fill.a * node.opacity, 0, 1);
  const cssFill = rgbaToCss({ ...fill, a: effectiveAlpha });
  const radii = getRadii(node);
  const pathData = buildRoundedRectPath(width, height, radii);
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${pathData}" fill="${cssFill}"/></svg>`
  );

  return {
    nodeId: node.id,
    left: toInt(bbox.x),
    top: toInt(bbox.y),
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
  fieldsUsed: Set<string>
): Promise<Layer | null> {
  const objectKey = fields[node.name];
  if (!objectKey || !node.bbox) return null;

  fieldsUsed.add(node.name);

  const rel = toRelativeBbox(node, frameX, frameY);
  if (!rel) return null;

  const width = ensureLayerGeometry(rel.width, 1);
  const height = ensureLayerGeometry(rel.height, 1);
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

  return {
    nodeId: node.id,
    left: toInt(rel.x),
    top: toInt(rel.y),
    width,
    height,
    input
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

async function renderEditableText(
  node: LayoutNode,
  treeById: Map<string, LayoutNode>,
  fields: Record<string, string>,
  frameX: number,
  frameY: number,
  frameW: number,
  frameH: number,
  fieldsUsed: Set<string>,
  forcedContainer?: LayoutNode
): Promise<{ layer: Layer | null; debug?: EditableTextDebug }> {
  if (!node.bbox) return { layer: null };

  const rawText = fields[node.name] ?? "";
  if (Object.prototype.hasOwnProperty.call(fields, node.name)) {
    fieldsUsed.add(node.name);
  }

  const container = forcedContainer ?? findNearestResizableContainer(node, treeById);
  const target = container ?? node;
  const rel = toRelativeBbox(target, frameX, frameY);
  if (!rel) return { layer: null };

  const style = node.textStyle ?? {};
  const fontSize = style.fontSize && style.fontSize > 0 ? style.fontSize : 16;
  const lineHeightPx =
    typeof style.lineHeightPx === "number" && style.lineHeightPx > 0
      ? style.lineHeightPx
      : typeof style.lineHeightPercentFontSize === "number" && style.lineHeightPercentFontSize > 0
        ? fontSize * (style.lineHeightPercentFontSize / 100)
        : fontSize;

  const letterSpacing = typeof style.letterSpacing === "number" ? style.letterSpacing : 0;

  const paddingLeft = container ? container.paddingLeft ?? 0 : 0;
  const paddingRight = container ? container.paddingRight ?? 0 : 0;
  const paddingTop = container ? container.paddingTop ?? 0 : 0;
  const paddingBottom = container ? container.paddingBottom ?? 0 : 0;

  const origX = rel.x;
  const origY = rel.y;
  const origW = Math.max(1, rel.width);
  const origH = Math.max(1, rel.height);

  const explicitMaxContentWidth = container ? containerMaxContentWidth(container) : undefined;
  const frameLimit = Math.max(1, frameW - origX - paddingLeft - paddingRight);
  const containerWidth = container?.bbox?.width ?? origW;
  const isFixedWidth = Boolean(container && explicitMaxContentWidth !== undefined);
  let maxTextWidth = isFixedWidth
    ? Math.max(1, containerWidth - paddingLeft - paddingRight)
    : Math.max(1, Math.min(frameLimit, 1600));

  const fontPath = resolveFontPath(style.fontPostScriptName);
  const font = await loadFontCached(fontPath);
  const metrics = getFontMetricsPx(font, fontSize);

  let lines = wrapTextByWords(rawText, maxTextWidth, font, fontSize, letterSpacing);
  if (lines.length === 0) lines = [""];

  let maxLineWidthPx = lines.reduce((maxWidth, line) => {
    return Math.max(maxWidth, measureTextPx(line, font, fontSize, letterSpacing));
  }, 0);

  let textBoxWidth = Math.max(1, Math.min(maxTextWidth, maxLineWidthPx));
  let blockW = container
    ? isFixedWidth
      ? Math.max(1, containerWidth)
      : textBoxWidth + paddingLeft + paddingRight
    : origW;

  let textBlockHeightPx = (lines.length - 1) * lineHeightPx + (metrics.ascPx + metrics.descPx);
  let blockH = container ? paddingTop + textBlockHeightPx + paddingBottom : origH;

  const constraintH = (container?.constraints?.horizontal ?? node.constraints?.horizontal ?? "LEFT") as string;
  const constraintV = (container?.constraints?.vertical ?? node.constraints?.vertical ?? "TOP") as string;

  let newX = origX;
  let newY = origY;

  if (constraintH === "RIGHT") {
    newX = origX + origW - blockW;
  } else if (constraintH === "CENTER") {
    newX = origX + origW / 2 - blockW / 2;
  } else if (constraintH === "LEFT_RIGHT") {
    newX = origX;
    blockW = origW;
    textBoxWidth = Math.max(1, origW - paddingLeft - paddingRight);
    maxTextWidth = textBoxWidth;
    lines = wrapTextByWords(rawText, textBoxWidth, font, fontSize, letterSpacing);
    if (lines.length === 0) lines = [""];
    textBlockHeightPx = (lines.length - 1) * lineHeightPx + (metrics.ascPx + metrics.descPx);
    blockH = container ? paddingTop + textBlockHeightPx + paddingBottom : origH;
    maxLineWidthPx = lines.reduce((maxWidth, line) => {
      return Math.max(maxWidth, measureTextPx(line, font, fontSize, letterSpacing));
    }, 0);
  }

  if (constraintV === "BOTTOM") {
    newY = origY + origH - blockH;
  } else if (constraintV === "CENTER") {
    newY = origY + origH / 2 - blockH / 2;
  } else if (constraintV === "TOP_BOTTOM") {
    newY = origY;
    blockH = origH;
    const contentHeight = Math.max(1, blockH - paddingTop - paddingBottom);
    lines = clampLinesByHeight(lines, contentHeight, lineHeightPx, metrics.ascPx, metrics.descPx);
    textBlockHeightPx = (lines.length - 1) * lineHeightPx + (metrics.ascPx + metrics.descPx);
  }

  blockW = Math.max(1, blockW);
  blockH = Math.max(1, blockH);

  newX = clamp(newX, 0, Math.max(0, frameW - blockW));
  newY = clamp(newY, 0, Math.max(0, frameH - blockH));

  const innerTop = paddingTop;
  const innerBottom = blockH - paddingBottom;
  const innerHeight = Math.max(1, innerBottom - innerTop);
  const textTopY = innerTop + Math.max(0, (innerHeight - textBlockHeightPx) / 2);
  const baselineY = textTopY + metrics.ascPx;
  const textX = paddingLeft;

  const textColor = getPrimaryFill(node) ?? { r: 0, g: 0, b: 0, a: 1 };
  const textPaths = buildSvgPathsForLines(font, lines, textX, baselineY, fontSize, lineHeightPx);

  const width = ensureLayerGeometry(blockW, 1);
  const height = ensureLayerGeometry(blockH, 1);
  const containerFill = container ? getPrimaryFill(container) : undefined;
  const containerPath = buildRoundedRectPath(width, height, container ? getRadii(container) : [0, 0, 0, 0]);

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      (containerFill
        ? `<path d="${containerPath}" fill="${rgbaToCss({ ...containerFill, a: containerFill.a * (container?.opacity ?? 1) })}"/>`
        : "") +
      `<g fill="${rgbaToCss(textColor)}">${textPaths}</g>` +
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
      isExplicitWidth: container ? isExplicitWidth(container) : false,
      isFixedWidth,
      containerW: Math.max(1, Math.round(containerWidth)),
      paddingL: Math.max(0, Math.round(paddingLeft)),
      paddingR: Math.max(0, Math.round(paddingRight)),
      explicitMaxContentWidth:
        typeof explicitMaxContentWidth === "number" ? Math.max(1, Math.round(explicitMaxContentWidth)) : undefined,
      maxTextWidth: Math.max(1, Math.round(maxTextWidth)),
      linesCount: lines.length,
      finalBlockW: width,
      textH: Math.max(1, Math.round(textBlockHeightPx))
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
  frameX: number;
  frameY: number;
  frameW: number;
  frameH: number;
  fields: Record<string, string>;
  fieldsUsed: Set<string>;
  treeById: Map<string, LayoutNode>;
  containerTextMap: Map<string, LayoutNode>;
  handledTextNodeIds: Set<string>;
  editableDebug: EditableTextDebug[];
  textContainerDebug: UniversalRenderDebug["textContainers"];
  assetsCache: Map<string, Buffer>;
  assetsMap: Record<string, string>;
};

async function renderNodeTree(node: LayoutNode, context: RenderTreeContext): Promise<Layer[]> {
  if (!node.visible) return [];

  const layers: Layer[] = [];
  const editableKind = getEditableKind(node.name);

  if (editableKind === "image") {
    const photoLayer = await renderEditablePhoto(
      node,
      context.fields,
      context.frameX,
      context.frameY,
      context.fieldsUsed
    );
    if (photoLayer) layers.push(photoLayer);
    return layers;
  }

  if (editableKind === "text") {
    if (context.handledTextNodeIds.has(node.id)) {
      return layers;
    }
    const rendered = await renderEditableText(
      node,
      context.treeById,
      context.fields,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.fieldsUsed
    );
    if (rendered.layer) layers.push(rendered.layer);
    if (rendered.debug) context.editableDebug.push(rendered.debug);
    return layers;
  }

  const mappedTextNode = context.containerTextMap.get(node.id);
  const renderSelfAsDynamicContainer = Boolean(mappedTextNode);

  if (renderSelfAsDynamicContainer && mappedTextNode) {
    const rendered = await renderEditableText(
      mappedTextNode,
      context.treeById,
      context.fields,
      context.frameX,
      context.frameY,
      context.frameW,
      context.frameH,
      context.fieldsUsed,
      node
    );
    if (rendered.layer) layers.push(rendered.layer);
    if (rendered.debug) context.editableDebug.push(rendered.debug);
  } else if ((node.type === "FRAME" || node.type === "RECTANGLE") && hasSolidFill(node)) {
    const rectLayer = await createSolidRectLayer(node, context.frameX, context.frameY);
    if (rectLayer) layers.push(rectLayer);
  } else if ((context.assetsMap[node.id] || node.assetKey) && node.bbox) {
    const rel = toRelativeBbox(node, context.frameX, context.frameY);
    if (rel) {
      const width = ensureLayerGeometry(rel.width, 1);
      const height = ensureLayerGeometry(rel.height, 1);
      const assetKey = context.assetsMap[node.id] || node.assetKey;
      if (!assetKey) return layers;
      let buffer = await getSnapshotAssetBuffer(assetKey, context.assetsCache);
      buffer = await sharp(buffer).resize(width, height, { fit: "fill" }).png().toBuffer();
      buffer = await applyOpacityToPng(buffer, node.opacity);
      layers.push({
        nodeId: node.id,
        left: toInt(rel.x),
        top: toInt(rel.y),
        width,
        height,
        input: buffer
      });
    }
    return layers;
  } else if (ATOMIC_IMAGE_TYPES.has(node.type) && hasSolidFill(node)) {
    const fallbackLayer = await createSolidRectLayer(node, context.frameX, context.frameY);
    if (fallbackLayer) layers.push(fallbackLayer);
    return layers;
  } else if (node.children.length === 0 && node.bbox && hasSolidFill(node)) {
    const fallbackLayer = await createSolidRectLayer(node, context.frameX, context.frameY);
    if (fallbackLayer) layers.push(fallbackLayer);
  }

  for (const child of node.children) {
    if (mappedTextNode && child.id === mappedTextNode.id) {
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
  const frameW = ensureLayerGeometry(frame.bbox.width, 1);
  const frameH = ensureLayerGeometry(frame.bbox.height, 1);
  const allNodes = collectNodes(frame);
  const editableTextNodes = allNodes.filter((node) => node.visible && getEditableKind(node.name) === "text");
  const containerTextMap = new Map<string, LayoutNode>();
  const handledTextNodeIds = new Set<string>();
  for (const textNode of editableTextNodes) {
    const container = findNearestResizableContainer(textNode, tree.byId);
    if (container && !containerTextMap.has(container.id)) {
      containerTextMap.set(container.id, textNode);
      handledTextNodeIds.add(textNode.id);
    }
  }

  const editableDebug: EditableTextDebug[] = [];
  const textContainerDebug: UniversalRenderDebug["textContainers"] = [];
  const fieldsUsed = new Set<string>();
  const frameAssetsMap =
    input.frameNode && typeof input.frameNode === "object" && input.frameNode.assetsMap
      ? input.frameNode.assetsMap
      : {};
  const allLayers = await renderNodeTree(frame, {
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
    assetsMap: frameAssetsMap
  });

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
      textH: item.textH
    });
  }

  let minX = 0;
  let minY = 0;
  let maxX = frameW;
  let maxY = frameH;

  for (const layer of allLayers) {
    const x1 = ensureFinite("layer.left", layer.left);
    const y1 = ensureFinite("layer.top", layer.top);
    const x2 = x1 + ensureFinite("layer.width", layer.width);
    const y2 = y1 + ensureFinite("layer.height", layer.height);

    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  }

  const bigW = ensureLayerGeometry(maxX - minX, frameW);
  const bigH = ensureLayerGeometry(maxY - minY, frameH);
  const paddingLeft = minX < 0 ? Math.abs(minX) : 0;
  const paddingTop = minY < 0 ? Math.abs(minY) : 0;

  const composite = allLayers.map((layer) => ({
    input: layer.input,
    left: ensureLayerGeometry(layer.left + paddingLeft, 0),
    top: ensureLayerGeometry(layer.top + paddingTop, 0)
  }));

  const bigCanvas = await sharp({
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

  const png = await sharp(bigCanvas)
    .extract({
      left: ensureLayerGeometry(paddingLeft, 0),
      top: ensureLayerGeometry(paddingTop, 0),
      width: frameW,
      height: frameH
    })
    .png()
    .toBuffer();

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
      textContainers: textContainerDebug
    }
  };
}
