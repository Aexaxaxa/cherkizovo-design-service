import { NextResponse } from "next/server";
import { FigmaApiError, figmaFetch } from "@/lib/figma";
import { getTemplateById } from "@/lib/templates";

export const runtime = "nodejs";

const CACHE_TTL_MS = 60_000;
const MAX_NODES = 500;

type FigmaColor = {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
};

type FigmaPaint = {
  type?: string;
  visible?: boolean;
  color?: FigmaColor;
  opacity?: number;
};

type FigmaTextStyle = {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlignHorizontal?: string;
  lineHeightUnit?: string;
  lineHeightPercentFontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
};

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  characters?: string;
  style?: FigmaTextStyle;
  layoutMode?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  backgroundColor?: FigmaColor;
  children?: FigmaNode[];
};

type FigmaNodesResponse = {
  nodes?: Record<
    string,
    {
      document?: FigmaNode;
    }
  >;
};

type SimplifiedNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  fills?: Array<{
    rgba: {
      r: number;
      g: number;
      b: number;
      a: number;
    };
  }>;
  strokes?: Array<{
    rgba: {
      r: number;
      g: number;
      b: number;
      a: number;
    };
  }>;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  characters?: string;
  style?: {
    fontFamily?: string;
    fontPostScriptName?: string;
    fontSize?: number;
    fontWeight?: number;
    textAlignHorizontal?: string;
    lineHeightUnit?: string;
    lineHeightPercentFontSize?: number;
    lineHeightPercentFontSizeNormalized?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
  };
  layoutMode?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
};

type SimplifiedFrameResponse = {
  frame: {
    id?: string;
    name?: string;
    type?: string;
    width?: number;
    height?: number;
    backgroundColor?: {
      r: number;
      g: number;
      b: number;
      a: number;
    };
  };
  nodes: SimplifiedNode[];
  nodesTruncated: boolean;
};

const frameCache = new Map<string, { expiresAt: number; value: SimplifiedFrameResponse }>();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeColor(color: FigmaColor | undefined, opacity?: number) {
  if (!color) return undefined;
  const r = color.r;
  const g = color.g;
  const b = color.b;
  const a = opacity ?? color.a ?? 1;
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b) || !isFiniteNumber(a)) {
    return undefined;
  }
  return { r, g, b, a };
}

function extractSolidPaints(paints: FigmaPaint[] | undefined) {
  if (!Array.isArray(paints)) {
    return undefined;
  }
  const result = paints
    .filter((paint) => paint?.type === "SOLID" && paint.visible !== false)
    .map((paint) => {
      const rgba = normalizeColor(paint.color, paint.opacity);
      return rgba ? { rgba } : null;
    })
    .filter((paint): paint is { rgba: { r: number; g: number; b: number; a: number } } => paint !== null);
  return result.length > 0 ? result : undefined;
}

function normalizeLineHeightPercent(style?: FigmaTextStyle): number {
  const lhPercent =
    typeof style?.lineHeightPercentFontSize === "number"
      ? style.lineHeightPercentFontSize
      : typeof style?.lineHeightPx === "number" &&
          typeof style?.fontSize === "number" &&
          style.fontSize > 0
        ? (style.lineHeightPx / style.fontSize) * 100
        : 100;
  return Number(lhPercent.toFixed(3));
}

function simplifyNode(node: FigmaNode): SimplifiedNode {
  const simplified: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    opacity: node.opacity
  };

  const bounds = node.absoluteBoundingBox;
  if (
    bounds &&
    isFiniteNumber(bounds.x) &&
    isFiniteNumber(bounds.y) &&
    isFiniteNumber(bounds.width) &&
    isFiniteNumber(bounds.height)
  ) {
    simplified.absoluteBoundingBox = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }

  const fills = extractSolidPaints(node.fills);
  if (fills) {
    simplified.fills = fills;
  }
  const strokes = extractSolidPaints(node.strokes);
  if (strokes) {
    simplified.strokes = strokes;
  }

  if (typeof node.cornerRadius === "number") {
    simplified.cornerRadius = node.cornerRadius;
  }
  if (Array.isArray(node.rectangleCornerRadii)) {
    simplified.rectangleCornerRadii = node.rectangleCornerRadii;
  }

  if (node.type === "TEXT") {
    simplified.characters = node.characters ?? "";
    simplified.style = {
      fontFamily: node.style?.fontFamily,
      fontPostScriptName: node.style?.fontPostScriptName,
      fontSize: node.style?.fontSize,
      fontWeight: node.style?.fontWeight,
      textAlignHorizontal: node.style?.textAlignHorizontal,
      lineHeightUnit: node.style?.lineHeightUnit,
      lineHeightPercentFontSize: node.style?.lineHeightPercentFontSize,
      lineHeightPercentFontSizeNormalized: normalizeLineHeightPercent(node.style),
      lineHeightPx: node.style?.lineHeightPx,
      letterSpacing: node.style?.letterSpacing
    };
  }

  if (typeof node.layoutMode === "string") {
    simplified.layoutMode = node.layoutMode;
  }
  if (typeof node.paddingLeft === "number") simplified.paddingLeft = node.paddingLeft;
  if (typeof node.paddingRight === "number") simplified.paddingRight = node.paddingRight;
  if (typeof node.paddingTop === "number") simplified.paddingTop = node.paddingTop;
  if (typeof node.paddingBottom === "number") simplified.paddingBottom = node.paddingBottom;
  if (typeof node.itemSpacing === "number") simplified.itemSpacing = node.itemSpacing;

  return simplified;
}

function flattenChildren(root: FigmaNode, maxNodes: number) {
  const output: SimplifiedNode[] = [];
  const stack: FigmaNode[] = Array.isArray(root.children) ? [...root.children].reverse() : [];

  while (stack.length > 0 && output.length < maxNodes) {
    const node = stack.pop();
    if (!node) continue;
    output.push(simplifyNode(node));
    if (Array.isArray(node.children) && node.children.length > 0) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }

  return {
    nodes: output,
    truncated: stack.length > 0
  };
}

function createFramePayload(frameNode: FigmaNode): SimplifiedFrameResponse {
  const bounds = frameNode.absoluteBoundingBox;
  const backgroundColor = normalizeColor(frameNode.backgroundColor);

  const frame = {
    id: frameNode.id,
    name: frameNode.name,
    type: frameNode.type,
    width: bounds?.width,
    height: bounds?.height,
    ...(backgroundColor ? { backgroundColor } : {})
  };

  const flattened = flattenChildren(frameNode, MAX_NODES);

  return {
    frame,
    nodes: flattened.nodes,
    nodesTruncated: flattened.truncated
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get("templateId")?.trim();
    const refresh = searchParams.get("refresh") === "1";

    if (!templateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }

    const template = getTemplateById(templateId);
    if (!template) {
      return NextResponse.json({ error: "Unknown templateId" }, { status: 400 });
    }

    const cacheKey = `${template.figmaFileKey}:${template.frameNodeId}`;
    if (!refresh) {
      const cached = frameCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return NextResponse.json(cached.value);
      }
    }

    const fileKey = encodeURIComponent(template.figmaFileKey);
    const frameId = encodeURIComponent(template.frameNodeId);
    const figmaResponse = await figmaFetch<FigmaNodesResponse>(
      `/v1/files/${fileKey}/nodes?ids=${frameId}`
    );
    const frameNode = figmaResponse.nodes?.[template.frameNodeId]?.document;

    if (!frameNode) {
      return NextResponse.json({ error: "Frame node not found in Figma response" }, { status: 404 });
    }

    const payload = createFramePayload(frameNode);
    frameCache.set(cacheKey, {
      value: payload,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof FigmaApiError) {
      if (error.status === 429) {
        return NextResponse.json(
          {
            error: error.message,
            retryAfter: error.retryAfter ?? null
          },
          { status: 429 }
        );
      }
      if (error.status === 401 || error.status === 403) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return NextResponse.json({ error: error.message }, { status });
    }

    const message = error instanceof Error ? error.message : "Failed to load Figma frame";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
