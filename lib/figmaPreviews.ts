import { getEnv } from "@/lib/env";
import { listObjectKeysByPrefix } from "@/lib/s3";

const PREVIEW_PREFIX_ROOT = "previews";
const previewsCache = new Map<string, { expiresAt: number; value: Set<string> }>();

export function toSafeFrameId(frameId: string): string {
  return encodeURIComponent(frameId);
}

export function fromSafeFrameId(safeFrameId: string): string {
  return decodeURIComponent(safeFrameId);
}

export function getPreviewsPrefix(fileKey: string): string {
  return `${PREVIEW_PREFIX_ROOT}/${fileKey}/`;
}

export function getPreviewObjectKey(fileKey: string, frameId: string): string {
  return `${getPreviewsPrefix(fileKey)}${toSafeFrameId(frameId)}.png`;
}

function getPreviewIdsTtlMs(): number {
  const baseSec = Math.floor(getEnv().FIGMA_TEMPLATES_TTL_SEC / 2);
  const safeSec = Math.min(300, Math.max(60, baseSec || 60));
  return safeSec * 1000;
}

export function invalidatePreviewFrameIdsCache(fileKey: string): void {
  previewsCache.delete(fileKey);
}

export async function listExistingPreviewFrameIds(
  fileKey: string,
  options?: { refresh?: boolean }
): Promise<Set<string>> {
  const refresh = options?.refresh === true;
  if (!refresh) {
    const cached = previewsCache.get(fileKey);
    if (cached && cached.expiresAt > Date.now()) {
      return new Set(cached.value);
    }
  }

  const prefix = getPreviewsPrefix(fileKey);
  const objectKeys = await listObjectKeysByPrefix(prefix);
  const existing = new Set<string>();

  for (const key of objectKeys) {
    if (!key.startsWith(prefix) || !key.endsWith(".png")) continue;
    const safeFrameId = key.slice(prefix.length, -4);
    if (!safeFrameId) continue;
    try {
      existing.add(fromSafeFrameId(safeFrameId));
    } catch {
      continue;
    }
  }

  previewsCache.set(fileKey, {
    expiresAt: Date.now() + getPreviewIdsTtlMs(),
    value: existing
  });

  return new Set(existing);
}
