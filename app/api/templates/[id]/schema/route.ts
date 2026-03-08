import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { get, getEntry, set } from "@/lib/memoryCache";
import { getFrameSnapshotKey, getSchemaSnapshotKey, readSnapshotJson } from "@/lib/snapshotStore";

export const runtime = "nodejs";

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

type SchemaPayload = {
  templateId: string;
  templateName: string;
  frame: {
    width: number;
    height: number;
  } | null;
  photoFields: Array<{
    name: string;
    nodeId: string;
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    cornerRadii?: [number, number, number, number];
  }>;
  textDefaults?: Record<
    string,
    {
      defaultText?: string;
      defaultColor?: string;
    }
  >;
  fields: SchemaField[];
};

type FrameSnapshotNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  characters?: string;
  fills?: Array<{
    type?: string;
    visible?: boolean;
    opacity?: number;
    color?: {
      r?: number;
      g?: number;
      b?: number;
      a?: number;
    };
  }>;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  children?: FrameSnapshotNode[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRadii(node: FrameSnapshotNode): [number, number, number, number] | undefined {
  if (
    Array.isArray(node.rectangleCornerRadii) &&
    node.rectangleCornerRadii.length >= 4 &&
    node.rectangleCornerRadii.every((value) => isFiniteNumber(value))
  ) {
    return [
      node.rectangleCornerRadii[0] as number,
      node.rectangleCornerRadii[1] as number,
      node.rectangleCornerRadii[2] as number,
      node.rectangleCornerRadii[3] as number
    ];
  }
  if (isFiniteNumber(node.cornerRadius)) {
    return [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toHexChannel(value: number): string {
  const normalized = value <= 1 ? value * 255 : value;
  return clamp(Math.round(normalized), 0, 255).toString(16).padStart(2, "0").toUpperCase();
}

function toHexColor(node: FrameSnapshotNode): string {
  const paints = Array.isArray(node.fills) ? node.fills : [];
  for (const paint of paints) {
    if (!paint || paint.type !== "SOLID" || paint.visible === false || !paint.color) continue;
    if (!isFiniteNumber(paint.color.r) || !isFiniteNumber(paint.color.g) || !isFiniteNumber(paint.color.b)) continue;
    return `#${toHexChannel(paint.color.r)}${toHexChannel(paint.color.g)}${toHexChannel(paint.color.b)}`;
  }
  return "#000000";
}

function extractTextDefaultsFromFrame(frameNode: FrameSnapshotNode): NonNullable<SchemaPayload["textDefaults"]> {
  const defaults: NonNullable<SchemaPayload["textDefaults"]> = {};

  function walk(node: FrameSnapshotNode) {
    if (node.visible === false) return;

    const name = typeof node.name === "string" ? node.name.trim() : "";
    if (name === "text" && node.type === "TEXT" && !defaults.text) {
      defaults.text = {
        defaultText: typeof node.characters === "string" ? node.characters : "",
        defaultColor: toHexColor(node)
      };
      return;
    }

    for (const child of node.children ?? []) {
      if (defaults.text) return;
      walk(child);
    }
  }

  walk(frameNode);
  return defaults;
}

function extractPhotoGeometryFromFrame(frameNode: FrameSnapshotNode): Pick<SchemaPayload, "frame" | "photoFields"> {
  const frameBox = frameNode.absoluteBoundingBox;
  if (
    !frameBox ||
    !isFiniteNumber(frameBox.x) ||
    !isFiniteNumber(frameBox.y) ||
    !isFiniteNumber(frameBox.width) ||
    !isFiniteNumber(frameBox.height) ||
    frameBox.width <= 0 ||
    frameBox.height <= 0
  ) {
    return {
      frame: null,
      photoFields: []
    };
  }

  const frame = {
    width: Math.round(frameBox.width),
    height: Math.round(frameBox.height)
  };
  const frameX = frameBox.x;
  const frameY = frameBox.y;

  const photoFields: SchemaPayload["photoFields"] = [];

  function walk(node: FrameSnapshotNode) {
    if (node.visible === false) return;

    const name = typeof node.name === "string" ? node.name.trim() : "";
    const lower = name.toLowerCase();
    const bbox = node.absoluteBoundingBox;
    if (
      name &&
      lower.startsWith("photo") &&
      node.id &&
      bbox &&
      isFiniteNumber(bbox.x) &&
      isFiniteNumber(bbox.y) &&
      isFiniteNumber(bbox.width) &&
      isFiniteNumber(bbox.height) &&
      bbox.width > 0 &&
      bbox.height > 0
    ) {
      photoFields.push({
        name,
        nodeId: node.id,
        box: {
          x: Math.max(0, Math.round(bbox.x - frameX)),
          y: Math.max(0, Math.round(bbox.y - frameY)),
          width: Math.max(1, Math.round(bbox.width)),
          height: Math.max(1, Math.round(bbox.height))
        },
        cornerRadii: normalizeRadii(node)
      });
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  }

  walk(frameNode);

  return {
    frame,
    photoFields
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("$metadata" in error && typeof error.$metadata === "object" && error.$metadata) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    return metadata.httpStatusCode === 404;
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name === "NoSuchKey" || error.name === "NotFound";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("404") || message.includes("NoSuchKey");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const frameId = decodeURIComponent(id);
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const debug = new URL(request.url).searchParams.get("debug") === "1";

  if (!frameId) {
    return NextResponse.json({ error: "Template id is required" }, { status: 400 });
  }

  const env = getEnv();
  const fileKey = env.FIGMA_FILE_KEY?.trim();
  if (!fileKey) {
    return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
  }

  const cacheKey = `${fileKey}:schema:v2:${frameId}`;

  try {
    if (!refresh) {
      const cached = get<SchemaPayload>(cacheKey);
      if (cached) {
        if (debug) {
          return NextResponse.json({
            source: "cache",
            templateId: cached.templateId,
            templateName: cached.templateName,
            fieldsCount: cached.fields.length,
            first20Fields: cached.fields.slice(0, 20)
          });
        }
        return NextResponse.json(cached);
      }
    }

    try {
      const key = getSchemaSnapshotKey(fileKey, frameId);
      const schemaSnapshot = await readSnapshotJson<{
        templateId: string;
        templateName: string;
        fields: SchemaField[];
      }>(key);
      const frameSnapshot = await readSnapshotJson<FrameSnapshotNode>(getFrameSnapshotKey(fileKey, frameId));
      const geometry = extractPhotoGeometryFromFrame(frameSnapshot);
      const textDefaults = extractTextDefaultsFromFrame(frameSnapshot);
      const hasRichTextField = schemaSnapshot.fields.some((field) => field.type === "text" && field.key === "text");
      if (hasRichTextField && !textDefaults.text) {
        textDefaults.text = {
          defaultText: "",
          defaultColor: "#000000"
        };
      }
      const payload: SchemaPayload = {
        templateId: schemaSnapshot.templateId,
        templateName: schemaSnapshot.templateName,
        fields: schemaSnapshot.fields,
        frame: geometry.frame,
        photoFields: geometry.photoFields,
        textDefaults
      };

      set(cacheKey, payload, env.FIGMA_SCHEMA_TTL_SEC);

      if (debug) {
        return NextResponse.json({
          source: "snapshot",
          templateId: payload.templateId,
          templateName: payload.templateName,
          fieldsCount: payload.fields.length,
          first20Fields: payload.fields.slice(0, 20)
        });
      }

      return NextResponse.json(payload);
    } catch (error) {
      const stale = getEntry<SchemaPayload>(cacheKey);
      if (stale) {
        if (debug) {
          return NextResponse.json({
            source: "stale-cache",
            stale: true,
            templateId: stale.value.templateId,
            templateName: stale.value.templateName,
            fieldsCount: stale.value.fields.length,
            first20Fields: stale.value.fields.slice(0, 20)
          });
        }
        return NextResponse.json(stale.value);
      }

      if (isNotFoundError(error)) {
        return NextResponse.json({ error: "Schema snapshot not found" }, { status: 404 });
      }

      return NextResponse.json({ error: "No snapshot. Run POST /api/admin/sync" }, { status: 503 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
