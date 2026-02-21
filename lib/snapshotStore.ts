import { getEnv } from "@/lib/env";
import { getObject, putObject } from "@/lib/s3";
import { streamToBuffer } from "@/lib/streamToBuffer";

export type SnapshotTemplate = {
  id: string;
  name: string;
  page: string;
};

export type SnapshotMeta = {
  syncedAt: string;
  fileKey: string;
  templatesCount: number;
  batchSize: number;
  nodeBatches: number;
};

export function getSnapshotPrefix(fileKey: string): string {
  return `snapshots/${fileKey}`;
}

export function toSafeFrameId(frameId: string): string {
  return frameId.replaceAll(":", "_");
}

export function toSafeNodeId(nodeId: string): string {
  return nodeId.replaceAll(":", "_").replaceAll(";", "_");
}

export function getTemplatesSnapshotKey(fileKey: string): string {
  return `${getSnapshotPrefix(fileKey)}/templates.json`;
}

export function getMetaSnapshotKey(fileKey: string): string {
  return `${getSnapshotPrefix(fileKey)}/meta.json`;
}

export function getFrameSnapshotKey(fileKey: string, frameId: string): string {
  return `${getSnapshotPrefix(fileKey)}/frames/${toSafeFrameId(frameId)}.json`;
}

export function getSchemaSnapshotKey(fileKey: string, frameId: string): string {
  return `${getSnapshotPrefix(fileKey)}/schemas/${toSafeFrameId(frameId)}.json`;
}

export function getAssetSnapshotKey(fileKey: string, nodeId: string): string {
  return `${getSnapshotPrefix(fileKey)}/assets/${toSafeNodeId(nodeId)}.png`;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("$metadata" in error && typeof error.$metadata === "object" && error.$metadata) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (metadata.httpStatusCode === 404) return true;
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name === "NoSuchKey" || error.name === "NotFound";
  }
  return false;
}

export async function readSnapshotJson<T>(key: string): Promise<T> {
  const object = await getObject(key);
  if (!object.Body) {
    throw new Error(`Snapshot body is empty: ${key}`);
  }
  const buffer = await streamToBuffer(object.Body);
  return JSON.parse(buffer.toString("utf-8")) as T;
}

export async function tryReadSnapshotJson<T>(key: string): Promise<T | null> {
  try {
    return await readSnapshotJson<T>(key);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeSnapshotJson(key: string, value: unknown): Promise<void> {
  await putObject({
    Key: key,
    Body: Buffer.from(JSON.stringify(value)),
    ContentType: "application/json"
  });
}

export function getSignedPreviewKeyByTemplateName(templateName: string): string {
  return `previews/${templateName}.jpg`;
}

export function getPreviewSignedTtlSec(): number {
  const env = getEnv();
  return env.SIGNED_URL_EXPIRES_SEC > 0 ? env.SIGNED_URL_EXPIRES_SEC : 900;
}
