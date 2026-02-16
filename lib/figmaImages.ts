import { getFigmaEnv } from "@/lib/env";
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

function toSafeNodeId(nodeId: string): string {
  return nodeId.replaceAll(":", "_").replaceAll(";", "_");
}

export async function getFigmaNodePng(fileKey: string, nodeId: string, scale = 1): Promise<Buffer> {
  const { FIGMA_TOKEN } = getFigmaEnv();
  const safeNodeId = toSafeNodeId(nodeId);
  const cacheKey = `figma-cache/${fileKey}/${safeNodeId}.png`;

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
  }

  const ids = encodeURIComponent(nodeId);
  const response = await fetch(
    `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${ids}&format=png&scale=${scale}`,
    {
      method: "GET",
      headers: {
        "X-Figma-Token": FIGMA_TOKEN
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(`Figma images request failed: ${response.status}`);
  }

  const data = (await response.json()) as FigmaImagesResponse;
  const imageUrl = data.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma image URL not found for node ${nodeId}`);
  }

  const imageResponse = await fetch(imageUrl, { method: "GET", cache: "no-store" });
  if (!imageResponse.ok) {
    throw new Error(`Figma image download failed: ${imageResponse.status}`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  await putObject({
    Key: cacheKey,
    Body: imageBuffer,
    ContentType: "image/png"
  });

  return imageBuffer;
}
