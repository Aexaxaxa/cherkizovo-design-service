export type FigmaColor = {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
};

export type FigmaPaint = {
  type?: string;
  visible?: boolean;
  color?: FigmaColor;
  opacity?: number;
};

export type FigmaConstraint = {
  horizontal?: "LEFT" | "RIGHT" | "CENTER" | "LEFT_RIGHT" | string;
  vertical?: "TOP" | "BOTTOM" | "CENTER" | "TOP_BOTTOM" | string;
};

export type FigmaNodeLite = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  assetKey?: string;
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  fills?: FigmaPaint[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  constraints?: FigmaConstraint;
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL" | string;
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL" | string;
  primaryAxisSizingMode?: "FIXED" | "AUTO" | string;
  counterAxisSizingMode?: "FIXED" | "AUTO" | string;
  assetsMap?: Record<string, string>;
  characters?: string;
  style?: {
    fontPostScriptName?: string;
    fontSize?: number;
    fontWeight?: number;
    letterSpacing?: number;
    lineHeightPx?: number;
    lineHeightUnit?: string;
    lineHeightPercentFontSize?: number;
  };
  children?: FigmaNodeLite[];
};

export type LayoutNode = {
  id: string;
  parentId?: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  assetKey?: string;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  fills: Array<{
    r: number;
    g: number;
    b: number;
    a: number;
  }>;
  radii?: [number, number, number, number];
  layoutMode?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  constraints?: {
    horizontal?: string;
    vertical?: string;
  };
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  characters?: string;
  textStyle?: {
    fontPostScriptName?: string;
    fontSize?: number;
    fontWeight?: number;
    letterSpacing?: number;
    lineHeightPx?: number;
    lineHeightUnit?: string;
    lineHeightPercentFontSize?: number;
  };
  children: LayoutNode[];
};

export type RenderOp = {
  kind: "image" | "photo" | "text" | "rect";
  nodeId: string;
};

export type LayoutTree = {
  root: LayoutNode;
  byId: Map<string, LayoutNode>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeFills(paints: FigmaPaint[] | undefined) {
  if (!Array.isArray(paints)) return [];
  return paints
    .filter((paint) => paint?.type === "SOLID" && paint.visible !== false)
    .map((paint) => {
      const c = paint.color;
      if (!c || !isFiniteNumber(c.r) || !isFiniteNumber(c.g) || !isFiniteNumber(c.b)) {
        return null;
      }
      const alpha = isFiniteNumber(paint.opacity) ? paint.opacity : isFiniteNumber(c.a) ? c.a : 1;
      return {
        r: c.r,
        g: c.g,
        b: c.b,
        a: alpha
      };
    })
    .filter((fill): fill is { r: number; g: number; b: number; a: number } => fill !== null);
}

function normalizeRadii(node: FigmaNodeLite): [number, number, number, number] | undefined {
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length >= 4) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    if ([tl, tr, br, bl].every(isFiniteNumber)) {
      return [tl, tr, br, bl];
    }
  }

  if (isFiniteNumber(node.cornerRadius)) {
    return [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  }

  return undefined;
}

function normalizeBbox(node: FigmaNodeLite) {
  const bbox = node.absoluteBoundingBox;
  if (!bbox) return undefined;
  if (
    !isFiniteNumber(bbox.x) ||
    !isFiniteNumber(bbox.y) ||
    !isFiniteNumber(bbox.width) ||
    !isFiniteNumber(bbox.height)
  ) {
    return undefined;
  }
  return {
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height
  };
}

function toLayoutNode(input: FigmaNodeLite, parentId: string | undefined, byId: Map<string, LayoutNode>): LayoutNode {
  const id = input.id ?? `${parentId ?? "root"}::${Math.random().toString(36).slice(2)}`;
  const node: LayoutNode = {
    id,
    parentId,
    name: input.name ?? "",
    type: input.type ?? "UNKNOWN",
    visible: input.visible !== false,
    opacity: isFiniteNumber(input.opacity) ? input.opacity : 1,
    assetKey: typeof input.assetKey === "string" ? input.assetKey : undefined,
    bbox: normalizeBbox(input),
    fills: normalizeFills(input.fills),
    radii: normalizeRadii(input),
    layoutMode: input.layoutMode,
    paddingLeft: input.paddingLeft,
    paddingRight: input.paddingRight,
    paddingTop: input.paddingTop,
    paddingBottom: input.paddingBottom,
    itemSpacing: input.itemSpacing,
    constraints: {
      horizontal: input.constraints?.horizontal,
      vertical: input.constraints?.vertical
    },
    layoutSizingHorizontal: input.layoutSizingHorizontal,
    layoutSizingVertical: input.layoutSizingVertical,
    primaryAxisSizingMode: input.primaryAxisSizingMode,
    counterAxisSizingMode: input.counterAxisSizingMode,
    characters: input.characters,
    textStyle: input.style
      ? {
          fontPostScriptName: input.style.fontPostScriptName,
          fontSize: input.style.fontSize,
          fontWeight: input.style.fontWeight,
          letterSpacing: input.style.letterSpacing,
          lineHeightPx: input.style.lineHeightPx,
          lineHeightUnit: input.style.lineHeightUnit,
          lineHeightPercentFontSize: input.style.lineHeightPercentFontSize
        }
      : undefined,
    children: []
  };

  byId.set(id, node);

  if (Array.isArray(input.children)) {
    node.children = input.children.map((child) => toLayoutNode(child, id, byId));
  }

  return node;
}

export function buildLayoutTree(root: FigmaNodeLite): LayoutTree {
  const byId = new Map<string, LayoutNode>();
  const layoutRoot = toLayoutNode(root, undefined, byId);
  return { root: layoutRoot, byId };
}

export function isEditableTextName(name: string): boolean {
  return /^text/i.test(name.trim());
}

export function isEditablePhotoName(name: string): boolean {
  return /^photo/i.test(name.trim());
}

export function getEditableKind(name: string): "text" | "image" | null {
  if (isEditableTextName(name)) return "text";
  if (isEditablePhotoName(name)) return "image";
  return null;
}

export function isExplicitWidth(node: LayoutNode): boolean {
  if (node.layoutSizingHorizontal === "FIXED") {
    return true;
  }

  if (node.counterAxisSizingMode === "FIXED") {
    return true;
  }

  if (node.constraints?.horizontal === "LEFT_RIGHT") {
    return true;
  }

  if (
    node.bbox &&
    node.layoutMode &&
    node.layoutMode !== "NONE" &&
    node.layoutSizingHorizontal !== "HUG" &&
    node.counterAxisSizingMode !== "AUTO"
  ) {
    return true;
  }

  return false;
}

export function containerMaxContentWidth(node: LayoutNode): number | undefined {
  if (!node.bbox) return undefined;
  if (!isExplicitWidth(node)) return undefined;
  const paddingLeft = node.paddingLeft ?? 0;
  const paddingRight = node.paddingRight ?? 0;
  return Math.max(1, node.bbox.width - paddingLeft - paddingRight);
}

export function hasSolidFill(node: LayoutNode): boolean {
  return node.fills.length > 0;
}

export function hasRadii(node: LayoutNode): boolean {
  return Array.isArray(node.radii) && node.radii.some((value) => Number.isFinite(value) && value > 0);
}

export function hasAnyPadding(node: LayoutNode): boolean {
  return (
    (node.paddingLeft ?? 0) > 0 ||
    (node.paddingRight ?? 0) > 0 ||
    (node.paddingTop ?? 0) > 0 ||
    (node.paddingBottom ?? 0) > 0
  );
}

export function findNearestResizableContainer(node: LayoutNode, byId: Map<string, LayoutNode>): LayoutNode | undefined {
  let cursor = node.parentId ? byId.get(node.parentId) : undefined;

  while (cursor) {
    if (
      cursor.type === "FRAME" &&
      cursor.layoutMode &&
      cursor.layoutMode !== "NONE" &&
      hasAnyPadding(cursor) &&
      (hasSolidFill(cursor) || hasRadii(cursor))
    ) {
      return cursor;
    }

    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  return undefined;
}

export function flattenLayoutNodes(root: LayoutNode): LayoutNode[] {
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
