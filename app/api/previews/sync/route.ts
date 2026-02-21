import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchBytes, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import {
  getPreviewObjectKey,
  invalidatePreviewFrameIdsCache,
  listExistingPreviewFrameIds
} from "@/lib/figmaPreviews";
import { listTemplateFrames } from "@/lib/figmaTemplates";
import { putObject } from "@/lib/s3";

export const runtime = "nodejs";

const BATCH_SIZE = 25;
const MAX_SYNC_RUNTIME_MS = 30_000;
let syncRunning = false;

type FigmaImagesResponse = {
  images?: Record<string, string | undefined>;
};

type SyncRequestBody = {
  templateId?: string;
};

function getPreviewScale(): number {
  const value = getEnv().FIGMA_PREVIEW_SCALE;
  return Number.isFinite(value) && value > 0 ? value : 0.25;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function parseTemplateId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => clearTimeout(timeout));
  });
}

export async function POST(request: Request) {
  if (syncRunning) {
    return NextResponse.json({ error: "Sync already running" }, { status: 409 });
  }

  syncRunning = true;
  const startedAt = Date.now();

  const errors: Array<{ frameId?: string; message: string; stage: "images" | "download" | "upload" }> = [];
  let framesTotal = 0;
  let missingTotal = 0;
  let downloaded = 0;
  let skippedExisting = 0;

  try {
    let templateId: string | null = null;
    try {
      const body = (await request.json()) as SyncRequestBody;
      templateId = parseTemplateId(body?.templateId);
    } catch {
      templateId = null;
    }

    const { fileKey, frames } = await withTimeout(
      listTemplateFrames({ refresh: true }),
      MAX_SYNC_RUNTIME_MS,
      "Sync timed out"
    );
    const targetFrames = templateId ? frames.filter((frame) => frame.id === templateId) : frames;

    if (templateId && targetFrames.length === 0) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    framesTotal = targetFrames.length;

    const existingPreviewFrameIds = await listExistingPreviewFrameIds(fileKey, { refresh: true });
    const missingFrameIds = targetFrames
      .map((frame) => frame.id)
      .filter((frameId) => !existingPreviewFrameIds.has(frameId));

    missingTotal = missingFrameIds.length;
    skippedExisting = framesTotal - missingTotal;

    if (missingFrameIds.length === 0) {
      return NextResponse.json({
        status: "ok",
        framesTotal,
        missingTotal,
        downloaded: 0,
        skippedExisting,
        rateLimited: false
      });
    }

    const previewScale = getPreviewScale();
    const batches = chunk(missingFrameIds, BATCH_SIZE);

    for (const batch of batches) {
      if (Date.now() - startedAt > MAX_SYNC_RUNTIME_MS) {
        return NextResponse.json(
          {
            error: "Sync timed out",
            framesTotal,
            missingTotal,
            downloaded,
            skippedExisting,
            rateLimited: false
          },
          { status: 504 }
        );
      }

      const idsCsv = batch.join(",");
      const requestPath =
        `/v1/images/${encodeURIComponent(fileKey)}` +
        `?ids=${encodeURIComponent(idsCsv)}&format=png&scale=${encodeURIComponent(String(previewScale))}`;

      let imagesMap: Record<string, string | undefined> = {};
      try {
        const { data: payload } = await figmaFetchJsonWithMeta<FigmaImagesResponse>(requestPath, {
          maxRetries: 0,
          sleepOn429: false,
          timeoutMs: 5000
        });
        imagesMap = payload.images ?? {};
      } catch (error) {
        if (error instanceof FigmaApiError && error.status === 429) {
          return NextResponse.json(
            {
              framesTotal,
              missingTotal,
              downloaded,
              skippedExisting,
              rateLimited: true,
              retryAfterSec: error.retryAfterSec ?? null,
              errors
            },
            { status: 429 }
          );
        }

        const message = error instanceof Error ? error.message : "Failed to fetch Figma image urls";
        for (const frameId of batch) {
          errors.push({ frameId, message, stage: "images" });
        }
        continue;
      }

      for (const frameId of batch) {
        const imageUrl = imagesMap[frameId];
        if (!imageUrl) {
          errors.push({
            frameId,
            message: "Figma did not return preview url for frame",
            stage: "images"
          });
          continue;
        }

        let pngBuffer: Buffer;
        try {
          pngBuffer = await figmaFetchBytes(imageUrl);
        } catch (error) {
          if (error instanceof FigmaApiError && error.status === 429) {
            return NextResponse.json(
              {
                framesTotal,
                missingTotal,
                downloaded,
                skippedExisting,
                rateLimited: true,
                retryAfterSec: error.retryAfterSec ?? null,
                errors
              },
              { status: 429 }
            );
          }

          const message = error instanceof Error ? error.message : "Failed to download preview image";
          errors.push({ frameId, message, stage: "download" });
          continue;
        }

        const objectKey = getPreviewObjectKey(fileKey, frameId);
        try {
          await putObject({
            Key: objectKey,
            Body: pngBuffer,
            ContentType: "image/png"
          });
          downloaded += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to upload preview to B2";
          errors.push({ frameId, message, stage: "upload" });
        }
      }
    }

    invalidatePreviewFrameIdsCache(fileKey);

    return NextResponse.json({
      status: "ok",
      framesTotal,
      missingTotal,
      downloaded,
      skippedExisting,
      rateLimited: false,
      ...(errors.length > 0 ? { errors } : {})
    });
  } catch (error) {
    if (error instanceof FigmaApiError && error.status === 429) {
      return NextResponse.json(
        {
          framesTotal,
          missingTotal,
          downloaded,
          skippedExisting,
          rateLimited: true,
          retryAfterSec: error.retryAfterSec ?? null,
          errors
        },
        { status: 429 }
      );
    }

    const message = error instanceof Error ? error.message : "Failed to sync previews";
    return NextResponse.json(
      {
        error: message,
        framesTotal,
        missingTotal,
        downloaded,
        skippedExisting,
        rateLimited: false,
        ...(errors.length > 0 ? { errors } : {})
      },
      { status: 500 }
    );
  } finally {
    syncRunning = false;
  }
}
