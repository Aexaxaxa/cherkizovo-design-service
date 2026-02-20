import { listObjectKeysByPrefix } from "@/lib/s3";

const PREVIEW_PREFIX_ROOT = "previews";

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

export async function listExistingPreviewFrameIds(fileKey: string): Promise<Set<string>> {
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

  return existing;
}
