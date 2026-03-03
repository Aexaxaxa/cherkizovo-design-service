import { getEnv } from "@/lib/env";
import { LruTtlCache } from "@/lib/cache";

const YADISK_API_BASE = "https://cloud-api.yandex.net/v1/disk/public/resources";
const BROWSE_TTL_MS = 60_000;
const browseCache = new LruTtlCache<PhotobankBrowseResult>({
  maxItems: 200,
  debug: false,
  name: "photobank"
});

export type PhotobankItem =
  | {
      type: "dir";
      name: string;
      path: string;
    }
  | {
      type: "file";
      name: string;
      path: string;
      mimeType: string;
      size: number;
      previewUrl: string;
      fileId?: string;
    };

export type PhotobankBrowseResult = {
  path: string;
  items: PhotobankItem[];
  hasMore: boolean;
};

type YadiskResourceItem = {
  type?: string;
  name?: string;
  path?: string;
  mime_type?: string;
  size?: number;
  preview?: string;
  resource_id?: string;
};

type YadiskBrowseResponse = {
  path?: string;
  _embedded?: {
    items?: YadiskResourceItem[];
    total?: number;
    offset?: number;
    limit?: number;
  };
};

type YadiskDownloadResponse = {
  href?: string;
};

function getPublicKey(): string {
  const value = getEnv().YADISK_PUBLIC_KEY;
  if (!value) {
    throw new Error("Missing YADISK_PUBLIC_KEY");
  }
  return value;
}

function isPhotobankDebugEnabled(): boolean {
  return process.env.DEBUG_PHOTOBANK === "1" || getEnv().CACHE_DEBUG;
}

function normalizePath(path: string | null | undefined): string {
  if (path === null || path === undefined || path === "" || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.replace(/^\/+/, "/").replace(/\/{2,}/g, "/");
}

function buildBrowseCacheKey(path: string, limit: number, offset: number): string {
  return `${path}|${limit}|${offset}`;
}

export async function browsePhotobank(input: {
  path?: string | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<PhotobankBrowseResult> {
  const path = normalizePath(input.path);
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const cacheKey = buildBrowseCacheKey(path, limit, offset);

  return browseCache.getOrSetAsync(cacheKey, BROWSE_TTL_MS, async () => {
    const params = new URLSearchParams();
    params.set("public_key", getPublicKey());
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    params.set("preview_size", "M");
    params.set("preview_crop", "false");
    if (path !== "/") {
      params.set("path", path);
    }

    const url = `${YADISK_API_BASE}?${params.toString()}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      if (isPhotobankDebugEnabled()) {
        const body = await response.text().catch(() => "");
        console.error("[photobank:browse]", {
          status: response.status,
          url,
          body
        });
      }
      throw new Error(`Yandex browse failed: ${response.status}`);
    }

    const payload = (await response.json()) as YadiskBrowseResponse;
    const embedded = payload._embedded;
    const rawItems = embedded?.items ?? [];
    const items: PhotobankItem[] = [];

    for (const item of rawItems) {
      const name = item.name;
      const itemPath = item.path;
      if (typeof name !== "string" || typeof itemPath !== "string" || !name || !itemPath) continue;

      if (item.type === "dir") {
        items.push({
          type: "dir",
          name,
          path: itemPath
        });
        continue;
      }

      const mimeType = typeof item.mime_type === "string" ? item.mime_type : "";
      if (item.type !== "file" || !mimeType.startsWith("image/")) continue;
      if (!item.preview) continue;

      items.push({
        type: "file",
        name,
        path: itemPath,
        mimeType,
        size: typeof item.size === "number" ? item.size : 0,
        previewUrl: item.preview,
        fileId: typeof item.resource_id === "string" && item.resource_id ? item.resource_id : undefined
      });
    }

    const total = typeof embedded?.total === "number" ? embedded.total : items.length;
    const actualOffset = typeof embedded?.offset === "number" ? embedded.offset : offset;
    const actualLimit = typeof embedded?.limit === "number" ? embedded.limit : limit;
    const hasMore = actualOffset + actualLimit < total;

    const responsePath = typeof payload.path === "string" && payload.path ? payload.path : path;

    return {
      path: responsePath,
      items,
      hasMore
    };
  });
}

export async function resolvePhotobankDownloadHref(path: string): Promise<string> {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    throw new Error("path is required");
  }

  const url = new URL(`${YADISK_API_BASE}/download`);
  url.searchParams.set("public_key", getPublicKey());
  url.searchParams.set("path", normalizedPath);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Yandex download resolve failed: ${response.status}`);
  }
  const payload = (await response.json()) as YadiskDownloadResponse;
  if (!payload.href || typeof payload.href !== "string") {
    throw new Error("Yandex download href is missing");
  }
  return payload.href;
}
