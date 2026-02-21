import { NextResponse } from "next/server";
import { getEnv, getFigmaEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { getPreviewObjectKey, listExistingPreviewFrameIds } from "@/lib/figmaPreviews";
import { get, getEntry, set } from "@/lib/memoryCache";

export const runtime = "nodejs";

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
};

type FigmaFileResponse = {
  name?: string;
  document?: {
    name?: string;
    children?: FigmaNode[];
  };
};

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  hasPreview: boolean;
  previewKey: string | null;
};

type TemplatesCacheValue = {
  templates: TemplateItem[];
  framesReturned: number;
  previewsAvailableCount: number;
  previewsMissingCount: number;
  sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }>;
};

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTemplateFrames(file: FigmaFileResponse): Array<{ id: string; name: string; page: string }> {
  const pages = file.document?.children ?? [];
  const templates: Array<{ id: string; name: string; page: string }> = [];

  for (const page of pages) {
    const pageName = normalizeName(page.name) || "Untitled";

    for (const node of page.children ?? []) {
      if (node?.type !== "FRAME") continue;
      if (node.visible === false) continue;
      const name = normalizeName(node.name);
      if (!name.toUpperCase().startsWith("TPL")) continue;
      if (!node.id || typeof node.id !== "string") continue;

      templates.push({
        id: node.id,
        name: name || node.id,
        page: pageName
      });
    }
  }

  const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  templates.sort((a, b) => {
    const byPage = collator.compare(a.page, b.page);
    if (byPage !== 0) return byPage;
    return collator.compare(a.name, b.name);
  });

  return templates;
}

async function buildTemplates(fileKey: string): Promise<TemplatesCacheValue> {
  const { data: file } = await figmaFetchJsonWithMeta<FigmaFileResponse>(
    `/v1/files/${encodeURIComponent(fileKey)}`,
    {
      maxRetries: 0,
      sleepOn429: false,
      timeoutMs: 5000
    }
  );

  const frames = parseTemplateFrames(file);
  const previewFrameIds = await listExistingPreviewFrameIds(fileKey);

  let previewsAvailableCount = 0;
  const sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }> = [];

  const templates = frames.map((frame) => {
    const hasPreview = previewFrameIds.has(frame.id);
    if (hasPreview) {
      previewsAvailableCount += 1;
    }
    if (sampleFirst10.length < 10) {
      sampleFirst10.push({
        id: frame.id,
        name: frame.name,
        hasPreview
      });
    }

    return {
      id: frame.id,
      name: frame.name,
      page: frame.page,
      hasPreview,
      previewKey: hasPreview ? getPreviewObjectKey(fileKey, frame.id) : null
    };
  });

  return {
    templates,
    framesReturned: templates.length,
    previewsAvailableCount,
    previewsMissingCount: Math.max(0, templates.length - previewsAvailableCount),
    sampleFirst10
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "1";
  const refresh = searchParams.get("refresh") === "1";

  try {
    const env = getEnv();
    const { FIGMA_FILE_KEY: fileKey } = getFigmaEnv();
    const cacheKey = `${fileKey}:templates:v1`;

    if (!refresh) {
      const freshCache = get<TemplatesCacheValue>(cacheKey);
      if (freshCache) {
        if (debug) {
          return NextResponse.json({
            source: "cache",
            framesReturned: freshCache.framesReturned,
            previewsAvailableCount: freshCache.previewsAvailableCount,
            previewsMissingCount: freshCache.previewsMissingCount,
            sampleFirst10: freshCache.sampleFirst10,
            stale: false,
            rateLimited: false,
            retryAfterSec: null
          });
        }
        return NextResponse.json(freshCache.templates);
      }
    }

    try {
      const built = await buildTemplates(fileKey);
      set(cacheKey, built, env.FIGMA_TEMPLATES_TTL_SEC);

      if (debug) {
        return NextResponse.json({
          source: "figma",
          framesReturned: built.framesReturned,
          previewsAvailableCount: built.previewsAvailableCount,
          previewsMissingCount: built.previewsMissingCount,
          sampleFirst10: built.sampleFirst10,
          stale: false,
          rateLimited: false,
          retryAfterSec: null
        });
      }

      return NextResponse.json(built.templates);
    } catch (error) {
      const staleEntry = getEntry<TemplatesCacheValue>(cacheKey);
      if (staleEntry) {
        const staleValue = staleEntry.value;
        const isRateLimited = error instanceof FigmaApiError && error.status === 429;
        const retryAfterSec = error instanceof FigmaApiError ? error.retryAfterSec ?? null : null;
        const figmaUnavailable = !isRateLimited;

        if (debug) {
          return NextResponse.json({
            source: "stale-cache",
            framesReturned: staleValue.framesReturned,
            previewsAvailableCount: staleValue.previewsAvailableCount,
            previewsMissingCount: staleValue.previewsMissingCount,
            sampleFirst10: staleValue.sampleFirst10,
            stale: true,
            rateLimited: isRateLimited,
            retryAfterSec,
            figmaUnavailable
          });
        }

        return NextResponse.json({
          templates: staleValue.templates,
          meta: {
            stale: true,
            rateLimited: isRateLimited,
            retryAfterSec,
            figmaUnavailable
          }
        });
      }

      if (error instanceof FigmaApiError) {
        if (error.status === 429) {
          return NextResponse.json(
            {
              error: "Figma rate limit",
              retryAfterSec: error.retryAfterSec ?? null
            },
            { status: 429 }
          );
        }

        return NextResponse.json(
          {
            error: "Figma API unavailable",
            retryAfterSec: error.retryAfterSec ?? null
          },
          { status: 503 }
        );
      }

      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load templates";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
