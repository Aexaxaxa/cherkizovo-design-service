type NodeLite = {
  name?: string;
  type?: string;
  visible?: boolean;
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  children?: NodeLite[];
};

export type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
  photoBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type SchemaFrame = {
  width: number;
  height: number;
};

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toField(
  node: NodeLite,
  frameBox?: { x: number; y: number; width: number; height: number }
): SchemaField | null {
  const name = normalizeName(node.name);
  if (!name) return null;

  if (node.type === "TEXT" && /^text/i.test(name)) {
    return { key: name, type: "text", label: name };
  }

  if ((node.type === "RECTANGLE" || node.type === "FRAME") && /^photo/i.test(name)) {
    let photoBounds: SchemaField["photoBounds"] | undefined;
    const box = node.absoluteBoundingBox;
    if (
      frameBox &&
      box &&
      typeof box.x === "number" &&
      typeof box.y === "number" &&
      typeof box.width === "number" &&
      typeof box.height === "number" &&
      box.width > 0 &&
      box.height > 0
    ) {
      photoBounds = {
        x: Math.max(0, Math.round(box.x - frameBox.x)),
        y: Math.max(0, Math.round(box.y - frameBox.y)),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height))
      };
    }
    return { key: name, type: "image", label: name, photoBounds };
  }

  return null;
}

export function extractSchemaFields(root: NodeLite): {
  fields: SchemaField[];
  totalNodesVisited: number;
  frame: SchemaFrame | null;
} {
  const fields: SchemaField[] = [];
  let totalNodesVisited = 0;
  const rootBox = root.absoluteBoundingBox;
  const frameBox =
    rootBox &&
    typeof rootBox.x === "number" &&
    typeof rootBox.y === "number" &&
    typeof rootBox.width === "number" &&
    typeof rootBox.height === "number" &&
    rootBox.width > 0 &&
    rootBox.height > 0
      ? { x: rootBox.x, y: rootBox.y, width: rootBox.width, height: rootBox.height }
      : undefined;

  function walk(node: NodeLite, parentVisible: boolean) {
    const nodeVisible = parentVisible && node.visible !== false;
    if (!nodeVisible) return;

    totalNodesVisited += 1;
    const field = toField(node, frameBox);
    if (field) {
      fields.push(field);
    }

    for (const child of node.children ?? []) {
      walk(child, nodeVisible);
    }
  }

  walk(root, true);

  const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  fields.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "text" ? -1 : 1;
    }
    return collator.compare(a.key, b.key);
  });

  return {
    fields,
    totalNodesVisited,
    frame: frameBox
      ? {
          width: Math.round(frameBox.width),
          height: Math.round(frameBox.height)
        }
      : null
  };
}
