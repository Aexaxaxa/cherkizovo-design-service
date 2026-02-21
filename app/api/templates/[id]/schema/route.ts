import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { get, getEntry, set } from "@/lib/memoryCache";
import { getSchemaSnapshotKey, readSnapshotJson, type SnapshotTemplate } from "@/lib/snapshotStore";

export const runtime = "nodejs";

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

type SchemaPayload = {
  templateId: string;
  templateName: string;
  fields: SchemaField[];
};

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

  const cacheKey = `${fileKey}:schema:v1:${frameId}`;

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
      const payload = await readSnapshotJson<SchemaPayload>(key);
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
