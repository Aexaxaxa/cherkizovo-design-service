import { NextResponse } from "next/server";
import { getEnv, getFigmaEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { get, getEntry, set } from "@/lib/memoryCache";
import { getSignedGetUrl, listObjectKeysByPrefix } from "@/lib/s3";

export const runtime = "nodejs";

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
};

type FigmaFileResponse = {
  document?: {
    children?: FigmaNode[];
  };
};

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

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTemplateFrames(file: FigmaFileResponse): Array<{ id: string; name: string; page: string }> {
  const pages = file.document?.children ?? [];
  const templates: Array<{ id: string; name: string; page: string }> = [];

  for (const page of pages) {
    const pageName = normalizeName(page.name) || "Untitled";
    for (const node of page.children ?? []) {
      if (node.type !== "FRAME") continue;
      if (node.visible === false) continue;
      if (!node.id || typeof node.id !== "string") continue;
      const name = normalizeName(node.name);
      if (!name.toUpperCase().startsWith("TPL")) continue;
      templates.push({ id: node.id, name: name || node.id, page: pageName });
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

async function listExistingPreviewNames(): Promise<Set<string>> {
  const cacheKey = "b2:previews:names:v1";
  const cached = get<Set<string>>(cacheKey);
  if (cached) {
    return cached;
  }

  const keys = await listObjectKeysByPrefix("previews/");
  const names = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith("previews/")) continue;
    if (!key.toLowerCase().endsWith(".jpg")) continue;
    const name = key.slice("previews/".length, -4);
    if (name) names.add(name);
  }

  set(cacheKey, names, 300);
  return names;
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
  const previewNames = await listExistingPreviewNames();
  const signedTtlSec = getEnv().SIGNED_URL_EXPIRES_SEC || 900;

  const templates: TemplateItem[] = await Promise.all(
    frames.map(async (frame) => {
      const hasPreview = previewNames.has(frame.name);
      if (!hasPreview) {
        return { id: frame.id, name: frame.name, page: frame.page, previewSignedUrl: null };
      }

      const previewKey = `previews/${frame.name}.jpg`;
      try {
        const previewSignedUrl = await getSignedGetUrl(previewKey, signedTtlSec);
        return { id: frame.id, name: frame.name, page: frame.page, previewSignedUrl };
      } catch {
        return { id: frame.id, name: frame.name, page: frame.page, previewSignedUrl: null };
      }
    })
  );

  const previewsAvailableCount = templates.filter((item) => item.previewSignedUrl !== null).length;

  return {
    templates,
    framesReturned: templates.length,
    previewsAvailableCount,
    previewsMissingCount: Math.max(0, templates.length - previewsAvailableCount),
    sampleFirst10: templates.slice(0, 10).map((item) => ({
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
            stale: false,
            rateLimited: false,
            framesReturned: freshCache.framesReturned,
            previewsAvailableCount: freshCache.previewsAvailableCount,
            previewsMissingCount: freshCache.previewsMissingCount,
            sampleFirst10: freshCache.sampleFirst10
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
          stale: false,
          rateLimited: false,
          framesReturned: built.framesReturned,
          previewsAvailableCount: built.previewsAvailableCount,
          previewsMissingCount: built.previewsMissingCount,
          sampleFirst10: built.sampleFirst10
        });
      }
      return NextResponse.json(built.templates);
    } catch (error) {
      const staleCache = getEntry<TemplatesCacheValue>(cacheKey);
      if (staleCache) {
        const stale = staleCache.value;
        const retryAfterSec = error instanceof FigmaApiError ? error.retryAfterSec ?? null : null;
        const rateLimited = error instanceof FigmaApiError && error.status === 429;

        if (debug) {
          return NextResponse.json({
            source: "stale-cache",
            stale: true,
            rateLimited,
            retryAfterSec,
            framesReturned: stale.framesReturned,
            previewsAvailableCount: stale.previewsAvailableCount,
            previewsMissingCount: stale.previewsMissingCount,
            sampleFirst10: stale.sampleFirst10
          });
        }
        return NextResponse.json(stale.templates);
      }

      if (error instanceof FigmaApiError && error.status === 429) {
        return NextResponse.json(
          {
            error: "Figma rate limit",
            retryAfterSec: error.retryAfterSec ?? null
          },
          { status: 429 }
        );
      }

      return NextResponse.json({ error: "Figma API unavailable" }, { status: 503 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load templates";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
