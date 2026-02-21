type NodeLite = {
  name?: string;
  type?: string;
  visible?: boolean;
  children?: NodeLite[];
};

export type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toField(node: NodeLite): SchemaField | null {
  const name = normalizeName(node.name);
  if (!name) return null;

  if (node.type === "TEXT" && /^text/i.test(name)) {
    return { key: name, type: "text", label: name };
  }

  if ((node.type === "RECTANGLE" || node.type === "FRAME") && /^photo/i.test(name)) {
    return { key: name, type: "image", label: name };
  }

  return null;
}

export function extractSchemaFields(root: NodeLite): { fields: SchemaField[]; totalNodesVisited: number } {
  const fields: SchemaField[] = [];
  let totalNodesVisited = 0;

  function walk(node: NodeLite, parentVisible: boolean) {
    const nodeVisible = parentVisible && node.visible !== false;
    if (!nodeVisible) return;

    totalNodesVisited += 1;
    const field = toField(node);
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

  return { fields, totalNodesVisited };
}
