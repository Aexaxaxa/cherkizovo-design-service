import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { get, getEntry, set } from "@/lib/memoryCache";
import { getSignedGetUrl } from "@/lib/s3";
import {
  getPreviewSignedTtlSec,
  getSignedPreviewKeyByTemplateName,
  getTemplatesSnapshotKey,
  readSnapshotJson,
  type SnapshotTemplate
} from "@/lib/snapshotStore";

export const runtime = "nodejs";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

type TemplatesCacheValue = {
  templates: TemplateItem[];
  framesReturned: number;
  previewsAvailableCount: number;
  previewsMissingCount: number;
  sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }>;
};

async function attachPreviewUrls(templates: SnapshotTemplate[]): Promise<TemplatesCacheValue> {
  const signedTtlSec = getPreviewSignedTtlSec();
  const items: TemplateItem[] = [];
  let previewsAvailableCount = 0;

  for (const tpl of templates) {
    const previewKey = getSignedPreviewKeyByTemplateName(tpl.name);
    let previewSignedUrl: string | null = null;
    try {
      previewSignedUrl = await getSignedGetUrl(previewKey, signedTtlSec);
      previewsAvailableCount += 1;
    } catch {
      previewSignedUrl = null;
    }

    items.push({
      id: tpl.id,
      name: tpl.name,
      page: tpl.page,
      previewSignedUrl
    });
  }

  return {
    templates: items,
    framesReturned: items.length,
    previewsAvailableCount,
    previewsMissingCount: Math.max(0, items.length - previewsAvailableCount),
    sampleFirst10: items.slice(0, 10).map((item) => ({
      id: item.id,
      name: item.name,
      hasPreview: item.previewSignedUrl !== null
    }))
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "1";
  const refresh = searchParams.get("refresh") === "1";

  const env = getEnv();
  const fileKey = env.FIGMA_FILE_KEY?.trim();
  if (!fileKey) {
    return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
  }

  const cacheKey = `${fileKey}:templates:v1`;

  try {
    if (!refresh) {
      const cached = get<TemplatesCacheValue>(cacheKey);
      if (cached) {
        if (debug) {
          return NextResponse.json({
            source: "cache",
            stale: false,
            framesReturned: cached.framesReturned,
            previewsAvailableCount: cached.previewsAvailableCount,
            previewsMissingCount: cached.previewsMissingCount,
            sampleFirst10: cached.sampleFirst10
          });
        }
        return NextResponse.json(cached.templates);
      }
    }

    try {
      const snapshotKey = getTemplatesSnapshotKey(fileKey);
      const templates = await readSnapshotJson<SnapshotTemplate[]>(snapshotKey);
      const built = await attachPreviewUrls(templates);
      set(cacheKey, built, env.FIGMA_TEMPLATES_TTL_SEC);

      if (debug) {
        return NextResponse.json({
          source: "snapshot",
          stale: false,
          framesReturned: built.framesReturned,
          previewsAvailableCount: built.previewsAvailableCount,
          previewsMissingCount: built.previewsMissingCount,
          sampleFirst10: built.sampleFirst10
        });
      }

      return NextResponse.json(built.templates);
    } catch (error) {
      const stale = getEntry<TemplatesCacheValue>(cacheKey);
      if (stale) {
        if (debug) {
          return NextResponse.json({
            source: "stale-cache",
            stale: true,
            framesReturned: stale.value.framesReturned,
            previewsAvailableCount: stale.value.previewsAvailableCount,
            previewsMissingCount: stale.value.previewsMissingCount,
            sampleFirst10: stale.value.sampleFirst10
          });
        }
        return NextResponse.json(stale.value.templates);
      }

      const message = error instanceof Error ? error.message : "No snapshot";
      if (message.includes("NoSuchKey") || message.includes("404")) {
        return NextResponse.json({ error: "No snapshot. Run POST /api/admin/sync" }, { status: 503 });
      }
      return NextResponse.json({ error: "No snapshot. Run POST /api/admin/sync" }, { status: 503 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load templates";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
