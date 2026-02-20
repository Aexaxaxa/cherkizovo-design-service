import { figmaFetchBytes, figmaFetchJson } from "@/lib/figmaClient";
import { getObject, headObject, putObject } from "@/lib/s3";
import { streamToBuffer } from "@/lib/streamToBuffer";

type FigmaImagesResponse = {
  images?: Record<string, string | undefined>;
};

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("$metadata" in error && typeof error.$metadata === "object" && error.$metadata) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (metadata.httpStatusCode === 404) return true;
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name === "NotFound" || error.name === "NoSuchKey";
  }
  return false;
}

export function toSafeNodeId(nodeId: string): string {
  return nodeId.replaceAll(":", "_").replaceAll(";", "_");
}

async function getCachedPng(cacheKey: string): Promise<Buffer | null> {
  try {
    await headObject(cacheKey);
    const cached = await getObject(cacheKey);
    if (!cached.Body) {
      throw new Error(`Cached object body is empty for ${cacheKey}`);
    }
    return streamToBuffer(cached.Body);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    return null;
  }
}

async function getImageUrl(fileKey: string, nodeId: string, scale: number): Promise<string> {
  const ids = encodeURIComponent(nodeId);
  const payload = await figmaFetchJson<FigmaImagesResponse>(
    `/v1/images/${encodeURIComponent(fileKey)}?ids=${ids}&format=png&scale=${scale}`
  );

  const imageUrl = payload.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma image URL not found for node ${nodeId}`);
  }
  return imageUrl;
}

export async function getFigmaNodePng(fileKey: string, nodeId: string, scale = 1): Promise<Buffer> {
  const safeNodeId = toSafeNodeId(nodeId);
  const cacheKey = `figma-cache/${fileKey}/${safeNodeId}.png`;

  const cached = await getCachedPng(cacheKey);
  if (cached) return cached;

  const imageUrl = await getImageUrl(fileKey, nodeId, scale);
  const imageBuffer = await figmaFetchBytes(imageUrl);

  await putObject({
    Key: cacheKey,
    Body: imageBuffer,
    ContentType: "image/png"
  });

  return imageBuffer;
}

export async function cacheFigmaPreviewPng(fileKey: string, nodeId: string, scale: number): Promise<string> {
  const safeNodeId = toSafeNodeId(nodeId);
  const cacheKey = `figma-previews/${fileKey}/${safeNodeId}.png`;

  const cached = await getCachedPng(cacheKey);
  if (cached) return cacheKey;

  const imageUrl = await getImageUrl(fileKey, nodeId, scale);
  const imageBuffer = await figmaFetchBytes(imageUrl);

  await putObject({
    Key: cacheKey,
    Body: imageBuffer,
    ContentType: "image/png"
  });

  return cacheKey;
}
