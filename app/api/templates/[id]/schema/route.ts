import { NextResponse } from "next/server";

export const runtime = "nodejs";

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
};

type FigmaNodesResponse = {
  nodes?: Record<string, { document?: FigmaNode }>;
};

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isVisible(node: FigmaNode | undefined, parentVisible: boolean): boolean {
  if (!node) return false;
  if (!parentVisible) return false;
  return node.visible !== false;
}

function toField(node: FigmaNode): SchemaField | null {
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

function naturalSortFields(fields: SchemaField[]): SchemaField[] {
  const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  return [...fields].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "text" ? -1 : 1;
    }
    return collator.compare(a.key, b.key);
  });
}

function collectFields(root: FigmaNode): { fields: SchemaField[]; totalNodesVisited: number } {
  const fields: SchemaField[] = [];
  let totalNodesVisited = 0;

  function walk(node: FigmaNode, parentVisible: boolean) {
    const nodeVisible = isVisible(node, parentVisible);
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

  for (const child of root.children ?? []) {
    walk(child, true);
  }

  return {
    fields: naturalSortFields(fields),
    totalNodesVisited
  };
}

async function fetchFrameNode(fileKey: string, token: string, frameId: string): Promise<FigmaNode> {
  const response = await fetch(
    `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(frameId)}`,
    {
      method: "GET",
      headers: {
        "X-Figma-Token": token
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 500);
    return Promise.reject({
      kind: "figma_http",
      status: response.status,
      statusText: response.statusText,
      body
    });
  }

  const payload = (await response.json()) as FigmaNodesResponse;
  const frame = payload.nodes?.[frameId]?.document;
  if (!frame) {
    throw new Error(`Frame node not found: ${frameId}`);
  }

  return frame;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const frameId = decodeURIComponent(id);
    const debug = new URL(request.url).searchParams.get("debug") === "1";

    if (!frameId) {
      return NextResponse.json({ error: "Template id is required" }, { status: 400 });
    }

    const fileKey = process.env.FIGMA_FILE_KEY?.trim();
    const token = process.env.FIGMA_TOKEN?.trim();

    if (!fileKey || !token) {
      return NextResponse.json({ error: "Missing FIGMA_FILE_KEY or FIGMA_TOKEN in environment" }, { status: 500 });
    }

    const frameNode = await fetchFrameNode(fileKey, token, frameId);
    const templateName = normalizeName(frameNode.name) || frameId;
    const { fields, totalNodesVisited } = collectFields(frameNode);

    if (debug) {
      return NextResponse.json({
        templateId: frameId,
        templateName,
        fieldsCount: fields.length,
        first20Fields: fields.slice(0, 20),
        totalNodesVisited
      });
    }

    return NextResponse.json({
      templateId: frameId,
      templateName,
      fields
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "kind" in error &&
      error.kind === "figma_http" &&
      "status" in error &&
      "statusText" in error &&
      "body" in error
    ) {
      return NextResponse.json(
        {
          error: "Figma API request failed",
          status: error.status,
          statusText: error.statusText,
          body: error.body
        },
        { status: 502 }
      );
    }

    const message = error instanceof Error ? error.message : "Failed to load template schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
