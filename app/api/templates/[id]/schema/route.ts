import { NextResponse } from "next/server";
import { getEnv, getFigmaEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { get, getEntry, set } from "@/lib/memoryCache";

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

type SchemaPayload = {
  templateId: string;
  templateName: string;
  fields: SchemaField[];
  fieldsCount: number;
  totalNodesVisited: number;
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

async function buildSchema(fileKey: string, frameId: string): Promise<SchemaPayload> {
  const { data } = await figmaFetchJsonWithMeta<FigmaNodesResponse>(
    `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(frameId)}`,
    {
      maxRetries: 0,
      sleepOn429: false,
      timeoutMs: 5000
    }
  );

  const frameNode = data.nodes?.[frameId]?.document;
  if (!frameNode) {
    throw new Error(`Frame node not found: ${frameId}`);
  }

  const templateName = normalizeName(frameNode.name) || frameId;
  const { fields, totalNodesVisited } = collectFields(frameNode);

  return {
    templateId: frameId,
    templateName,
    fields,
    fieldsCount: fields.length,
    totalNodesVisited
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const frameId = decodeURIComponent(id);
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "1";
  const refresh = searchParams.get("refresh") === "1";

  try {
    if (!frameId) {
      return NextResponse.json({ error: "Template id is required" }, { status: 400 });
    }

    const env = getEnv();
    const { FIGMA_FILE_KEY: fileKey } = getFigmaEnv();
    const cacheKey = `${fileKey}:schema:v1:${frameId}`;

    if (!refresh) {
      const fresh = get<SchemaPayload>(cacheKey);
      if (fresh) {
        if (debug) {
          return NextResponse.json({
            source: "cache",
            stale: false,
            rateLimited: false,
            retryAfterSec: null,
            templateId: fresh.templateId,
            templateName: fresh.templateName,
            fieldsCount: fresh.fieldsCount,
            first20Fields: fresh.fields.slice(0, 20),
            totalNodesVisited: fresh.totalNodesVisited
          });
        }

        return NextResponse.json({
          templateId: fresh.templateId,
          templateName: fresh.templateName,
          fields: fresh.fields
        });
      }
    }

    try {
      const payload = await buildSchema(fileKey, frameId);
      set(cacheKey, payload, env.FIGMA_SCHEMA_TTL_SEC);

      if (debug) {
        return NextResponse.json({
          source: "figma",
          stale: false,
          rateLimited: false,
          retryAfterSec: null,
          templateId: payload.templateId,
          templateName: payload.templateName,
          fieldsCount: payload.fieldsCount,
          first20Fields: payload.fields.slice(0, 20),
          totalNodesVisited: payload.totalNodesVisited
        });
      }

      return NextResponse.json({
        templateId: payload.templateId,
        templateName: payload.templateName,
        fields: payload.fields
      });
    } catch (error) {
      const stale = getEntry<SchemaPayload>(cacheKey);
      if (stale) {
        const staleValue = stale.value;
        const isRateLimited = error instanceof FigmaApiError && error.status === 429;
        const retryAfterSec = error instanceof FigmaApiError ? error.retryAfterSec ?? null : null;

        if (debug) {
          return NextResponse.json({
            source: "stale-cache",
            stale: true,
            rateLimited: isRateLimited,
            retryAfterSec,
            templateId: staleValue.templateId,
            templateName: staleValue.templateName,
            fieldsCount: staleValue.fieldsCount,
            first20Fields: staleValue.fields.slice(0, 20),
            totalNodesVisited: staleValue.totalNodesVisited
          });
        }

        return NextResponse.json({
          templateId: staleValue.templateId,
          templateName: staleValue.templateName,
          fields: staleValue.fields,
          meta: {
            stale: true,
            rateLimited: isRateLimited,
            retryAfterSec
          }
        });
      }

      if (error instanceof FigmaApiError) {
        return NextResponse.json(
          {
            error: "Figma API unavailable",
            retryAfterSec: error.retryAfterSec ?? null
          },
          { status: 429 }
        );
      }

      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load template schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
