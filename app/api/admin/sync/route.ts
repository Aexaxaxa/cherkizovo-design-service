import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchBytes, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { extractSchemaFields } from "@/lib/schemaExtractor";
import {
  getAssetSnapshotKey,
  getFrameSnapshotKey,
  getMetaSnapshotKey,
  getSchemaSnapshotKey,
  getTemplatesSnapshotKey,
  type SnapshotTemplate,
  writeSnapshotJson
} from "@/lib/snapshotStore";
import { putObject } from "@/lib/s3";

export const runtime = "nodejs";

const TARGET_BATCH_SIZE = 25;
const NODE_BATCH_FALLBACK = [25, 10, 5];
const FIGMA_SYNC_TIMEOUT_MS = 60_000;

let syncRunning = false;

type FigmaNode = {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
  assetsMap?: Record<string, string>;
};

type FigmaFileResponse = {
  document?: {
    children?: FigmaNode[];
  };
};

type FigmaNodesResponse = {
  nodes?: Record<string, { document?: FigmaNode }>;
};

type FigmaImagesResponse = {
  images?: Record<string, string | undefined>;
};

type SyncProgress = {
  templatesFound: number;
  framesSaved: number;
  schemasSaved: number;
  currentBatchIndex: number;
  lastProcessedId: string | null;
  batchSizeUsed: number;
};

type BatchSummary = {
  size: number;
  total: number;
  processed: number;
  batchSizeUsed: number;
};

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractTemplates(file: FigmaFileResponse): SnapshotTemplate[] {
  const templates: SnapshotTemplate[] = [];
  const pages = file.document?.children ?? [];

  for (const page of pages) {
    const pageName = normalizeName(page.name) || "Untitled";
    for (const node of page.children ?? []) {
      if (node.type !== "FRAME") continue;
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

function shouldExportLogoAsset(node: FigmaNode): boolean {
  if (node.visible === false) return false;
  const lowerName = normalizeName(node.name).toLowerCase();
  return lowerName === "logo" || lowerName === "logo_bg";
}

function collectLogoNodeIds(root: FigmaNode, out: Set<string>): void {
  if (root.visible === false) return;

  if (root.id && shouldExportLogoAsset(root)) {
    out.add(root.id);
  }

  for (const child of root.children ?? []) {
    collectLogoNodeIds(child, out);
  }
}

function buildFrameAssetsMap(root: FigmaNode, assetsMap: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  function walk(node: FigmaNode) {
    if (node.visible === false) return;
    if (node.id) {
      const assetKey = assetsMap.get(node.id);
      if (assetKey) {
        out[node.id] = assetKey;
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  }

  walk(root);
  return out;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof FigmaApiError) {
    return error.status === 504 || (typeof error.message === "string" && error.message.includes("timed out"));
  }
  return false;
}

function buildRateLimitResponse(
  retryAfterSec: number | null,
  progress: SyncProgress,
  batches?: BatchSummary,
  debug?: { totalIds: number; batchSizeUsed: number; chunks: number[] }
) {
  return NextResponse.json(
    {
      error: "Figma rate limit",
      retryAfterSec,
      progress,
      ...(batches ? { batches } : {}),
      ...(debug ? { debug } : {})
    },
    { status: 429 }
  );
}

function buildUnavailableResponse(
  message: string,
  progress: SyncProgress,
  batches?: BatchSummary,
  debug?: { totalIds: number; batchSizeUsed: number; chunks: number[] }
) {
  return NextResponse.json(
    {
      error: message,
      progress,
      ...(batches ? { batches } : {}),
      ...(debug ? { debug } : {})
    },
    { status: 503 }
  );
}

function getChunkSizes(totalIds: number, batchSizeUsed: number): number[] {
  if (totalIds <= 0 || batchSizeUsed <= 0) return [];
  return chunk(Array.from({ length: totalIds }, (_, i) => i), batchSizeUsed).map((part) => part.length);
}

function buildBatchSummary(totalIds: number, batchSizeUsed: number, processedBatches: number): BatchSummary {
  const safeBatchSize = batchSizeUsed > 0 ? batchSizeUsed : TARGET_BATCH_SIZE;
  const total = totalIds > 0 ? Math.max(1, Math.ceil(totalIds / safeBatchSize)) : 0;
  return {
    size: TARGET_BATCH_SIZE,
    total,
    processed: processedBatches,
    batchSizeUsed: safeBatchSize
  };
}

async function writeMeta(
  fileKey: string,
  input: {
    status: "in_progress" | "ok";
    syncedAt: string;
    templatesCount: number;
    framesSaved: number;
    schemasSaved: number;
    nodeBatches: number;
    batchSizeUsed: number;
    currentBatchIndex: number;
    lastProcessedId: string | null;
    finishedAt?: string;
  }
) {
  await writeSnapshotJson(getMetaSnapshotKey(fileKey), {
    status: input.status,
    syncedAt: input.syncedAt,
    finishedAt: input.finishedAt ?? null,
    fileKey,
    templatesCount: input.templatesCount,
    batchSize: TARGET_BATCH_SIZE,
    batchSizeUsed: input.batchSizeUsed,
    nodeBatches: input.nodeBatches,
    framesSaved: input.framesSaved,
    schemasSaved: input.schemasSaved,
    currentBatchIndex: input.currentBatchIndex,
    lastProcessedId: input.lastProcessedId
  });
}

async function fetchNodesWithFallback(
  fileKey: string,
  frameIds: string[],
  onBatchRequest: () => void
): Promise<{ documents: Map<string, FigmaNode>; batchSizeUsed: number }> {
  let lastTimeoutError: unknown = null;

  for (const batchSize of NODE_BATCH_FALLBACK) {
    try {
      const docs = new Map<string, FigmaNode>();
      for (const idsChunk of chunk(frameIds, batchSize)) {
        onBatchRequest();
        const idsCsv = idsChunk.join(",");
        const { data } = await figmaFetchJsonWithMeta<FigmaNodesResponse>(
          `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(idsCsv)}`,
          {
            maxRetries: 1,
            sleepOn429: false,
            timeoutMs: FIGMA_SYNC_TIMEOUT_MS
          }
        );

        for (const frameId of idsChunk) {
          const frameDoc = data.nodes?.[frameId]?.document;
          if (frameDoc) {
            docs.set(frameId, frameDoc);
          }
        }
      }
      return { documents: docs, batchSizeUsed: batchSize };
    } catch (error) {
      if (error instanceof FigmaApiError && error.status === 429) {
        throw error;
      }
      if (isTimeoutError(error)) {
        lastTimeoutError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastTimeoutError instanceof Error) {
    throw lastTimeoutError;
  }
  throw new Error("Failed to fetch nodes with fallback batch sizes");
}

async function exportLogoAssetsForFrames(
  fileKey: string,
  frameDocs: Map<string, FigmaNode>,
  sharedAssetsMap: Map<string, string>,
  progress: SyncProgress,
  onBatchRequest: () => void
): Promise<void> {
  const logoNodeIds = new Set<string>();
  for (const frameDoc of frameDocs.values()) {
    collectLogoNodeIds(frameDoc, logoNodeIds);
  }
  const missingNodeIds = [...logoNodeIds].filter((nodeId) => !sharedAssetsMap.has(nodeId));
  if (missingNodeIds.length === 0) return;

  for (const idsChunk of chunk(missingNodeIds, TARGET_BATCH_SIZE)) {
    onBatchRequest();
    const idsCsv = idsChunk.join(",");
    const { data } = await figmaFetchJsonWithMeta<FigmaImagesResponse>(
      `/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(idsCsv)}&format=png&scale=1`,
      {
        maxRetries: 1,
        sleepOn429: false,
        timeoutMs: FIGMA_SYNC_TIMEOUT_MS
      }
    );

    for (const nodeId of idsChunk) {
      const imageUrl = data.images?.[nodeId];
      if (!imageUrl) continue;
      const bytes = await figmaFetchBytes(imageUrl, {
        maxRetries: 1,
        sleepOn429: false,
        timeoutMs: FIGMA_SYNC_TIMEOUT_MS
      });
      const assetKey = getAssetSnapshotKey(fileKey, nodeId);
      await putObject({
        Key: assetKey,
        Body: bytes,
        ContentType: "image/png"
      });
      sharedAssetsMap.set(nodeId, assetKey);
      progress.lastProcessedId = nodeId;
    }
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const debugRequested = searchParams.get("debug") === "1" || process.env.DEBUG_RENDER === "1";
  const adminSecret = process.env.ADMIN_SYNC_SECRET?.trim();
  const requestSecret = request.headers.get("x-admin-secret")?.trim();

  if (!adminSecret || requestSecret !== adminSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (syncRunning) {
    return NextResponse.json({ error: "Sync already running" }, { status: 409 });
  }

  syncRunning = true;

  const progress: SyncProgress = {
    templatesFound: 0,
    framesSaved: 0,
    schemasSaved: 0,
    currentBatchIndex: 0,
    lastProcessedId: null,
    batchSizeUsed: TARGET_BATCH_SIZE
  };
  let totalIds = 0;
  let processedBatches = 0;

  try {
    const env = getEnv();
    const fileKey = env.FIGMA_FILE_KEY?.trim();
    if (!fileKey) {
      return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
    }

    const syncedAt = new Date().toISOString();
    const { data: file } = await figmaFetchJsonWithMeta<FigmaFileResponse>(
      `/v1/files/${encodeURIComponent(fileKey)}`,
      {
        maxRetries: 1,
        sleepOn429: false,
        timeoutMs: FIGMA_SYNC_TIMEOUT_MS
      }
    );

    const templates = extractTemplates(file);
    progress.templatesFound = templates.length;
    totalIds = templates.length;

    await writeSnapshotJson(getTemplatesSnapshotKey(fileKey), templates);
    await writeMeta(fileKey, {
      status: "in_progress",
      syncedAt,
      templatesCount: templates.length,
      framesSaved: progress.framesSaved,
      schemasSaved: progress.schemasSaved,
      nodeBatches: Math.ceil(templates.length / TARGET_BATCH_SIZE),
      batchSizeUsed: progress.batchSizeUsed,
      currentBatchIndex: progress.currentBatchIndex,
      lastProcessedId: progress.lastProcessedId
    });

    const pendingTemplates: SnapshotTemplate[] = [...templates];
    const exportedAssetsMap = new Map<string, string>();

    const pendingChunks = chunk(pendingTemplates, TARGET_BATCH_SIZE);
    for (let i = 0; i < pendingChunks.length; i += 1) {
      progress.currentBatchIndex = i + 1;
      const chunkTemplates = pendingChunks[i];
      const frameIds = chunkTemplates.map((item) => item.id);

      let docsResult: { documents: Map<string, FigmaNode>; batchSizeUsed: number };
      try {
        docsResult = await fetchNodesWithFallback(fileKey, frameIds, () => {
          processedBatches += 1;
        });
      } catch (error) {
        const batches = buildBatchSummary(totalIds, progress.batchSizeUsed, processedBatches);
        const debug = debugRequested
          ? { totalIds, batchSizeUsed: batches.batchSizeUsed, chunks: getChunkSizes(totalIds, batches.batchSizeUsed) }
          : undefined;
        if (error instanceof FigmaApiError && error.status === 429) {
          await writeMeta(fileKey, {
            status: "in_progress",
            syncedAt,
            templatesCount: templates.length,
            framesSaved: progress.framesSaved,
            schemasSaved: progress.schemasSaved,
            nodeBatches: pendingChunks.length,
            batchSizeUsed: progress.batchSizeUsed,
            currentBatchIndex: progress.currentBatchIndex,
            lastProcessedId: progress.lastProcessedId
          });
          return buildRateLimitResponse(error.retryAfterSec ?? null, progress, batches, debug);
        }
        await writeMeta(fileKey, {
          status: "in_progress",
          syncedAt,
          templatesCount: templates.length,
          framesSaved: progress.framesSaved,
          schemasSaved: progress.schemasSaved,
          nodeBatches: pendingChunks.length,
          batchSizeUsed: progress.batchSizeUsed,
          currentBatchIndex: progress.currentBatchIndex,
          lastProcessedId: progress.lastProcessedId
        });
        const message = isTimeoutError(error)
          ? "Figma API request timed out during nodes sync"
          : error instanceof Error
            ? error.message
            : "Nodes sync failed";
        return buildUnavailableResponse(message, progress, batches, debug);
      }

      progress.batchSizeUsed = docsResult.batchSizeUsed;

      for (const tpl of chunkTemplates) {
        const frameDoc = docsResult.documents.get(tpl.id);
        if (!frameDoc) {
          continue;
        }
        progress.lastProcessedId = tpl.id;
      }

      try {
        await exportLogoAssetsForFrames(fileKey, docsResult.documents, exportedAssetsMap, progress, () => {
          processedBatches += 1;
        });
      } catch (error) {
        const batches = buildBatchSummary(totalIds, progress.batchSizeUsed, processedBatches);
        const debug = debugRequested
          ? { totalIds, batchSizeUsed: batches.batchSizeUsed, chunks: getChunkSizes(totalIds, batches.batchSizeUsed) }
          : undefined;
        if (error instanceof FigmaApiError && error.status === 429) {
          await writeMeta(fileKey, {
            status: "in_progress",
            syncedAt,
            templatesCount: templates.length,
            framesSaved: progress.framesSaved,
            schemasSaved: progress.schemasSaved,
            nodeBatches: pendingChunks.length,
            batchSizeUsed: progress.batchSizeUsed,
            currentBatchIndex: progress.currentBatchIndex,
            lastProcessedId: progress.lastProcessedId
          });
          return buildRateLimitResponse(error.retryAfterSec ?? null, progress, batches, debug);
        }
        await writeMeta(fileKey, {
          status: "in_progress",
          syncedAt,
          templatesCount: templates.length,
          framesSaved: progress.framesSaved,
          schemasSaved: progress.schemasSaved,
          nodeBatches: pendingChunks.length,
          batchSizeUsed: progress.batchSizeUsed,
          currentBatchIndex: progress.currentBatchIndex,
          lastProcessedId: progress.lastProcessedId
        });
        const message = isTimeoutError(error)
          ? "Figma API request timed out during assets sync"
          : error instanceof Error
            ? error.message
            : "Assets sync failed";
        return buildUnavailableResponse(message, progress, batches, debug);
      }

      for (const tpl of chunkTemplates) {
        const frameDoc = docsResult.documents.get(tpl.id);
        if (!frameDoc) {
          continue;
        }

        const frameSnapshotKey = getFrameSnapshotKey(fileKey, tpl.id);
        const schemaSnapshotKey = getSchemaSnapshotKey(fileKey, tpl.id);

        frameDoc.assetsMap = buildFrameAssetsMap(frameDoc, exportedAssetsMap);

        await writeSnapshotJson(frameSnapshotKey, frameDoc);
        progress.framesSaved += 1;

        const schema = extractSchemaFields(frameDoc);
        await writeSnapshotJson(schemaSnapshotKey, {
          templateId: tpl.id,
          templateName: normalizeName(frameDoc.name) || tpl.id,
          fields: schema.fields
        });
        progress.schemasSaved += 1;

        await writeMeta(fileKey, {
          status: "in_progress",
          syncedAt,
          templatesCount: templates.length,
          framesSaved: progress.framesSaved,
          schemasSaved: progress.schemasSaved,
          nodeBatches: pendingChunks.length,
          batchSizeUsed: progress.batchSizeUsed,
          currentBatchIndex: progress.currentBatchIndex,
          lastProcessedId: progress.lastProcessedId
        });
      }
    }

    const finishedAt = new Date().toISOString();
    await writeMeta(fileKey, {
      status: "ok",
      syncedAt,
      finishedAt,
      templatesCount: templates.length,
      framesSaved: progress.framesSaved,
      schemasSaved: progress.schemasSaved,
      nodeBatches: pendingChunks.length,
      batchSizeUsed: progress.batchSizeUsed,
      currentBatchIndex: progress.currentBatchIndex,
      lastProcessedId: progress.lastProcessedId
    });

    const batches = buildBatchSummary(totalIds, progress.batchSizeUsed, processedBatches);
    const debug = debugRequested
      ? { totalIds, batchSizeUsed: batches.batchSizeUsed, chunks: getChunkSizes(totalIds, batches.batchSizeUsed) }
      : undefined;

    return NextResponse.json({
      status: "ok",
      syncedAt,
      finishedAt,
      templatesCount: templates.length,
      framesSaved: progress.framesSaved,
      schemasSaved: progress.schemasSaved,
      batches,
      ...(debug ? { debug } : {})
    });
  } catch (error) {
    const batches = buildBatchSummary(totalIds, progress.batchSizeUsed, processedBatches);
    const debug = debugRequested
      ? { totalIds, batchSizeUsed: batches.batchSizeUsed, chunks: getChunkSizes(totalIds, batches.batchSizeUsed) }
      : undefined;
    if (error instanceof FigmaApiError && error.status === 429) {
      return buildRateLimitResponse(error.retryAfterSec ?? null, progress, batches, debug);
    }
    const message = isTimeoutError(error)
      ? "Figma API request timed out"
      : error instanceof Error
        ? error.message
        : "Sync failed";
    return buildUnavailableResponse(message, progress, batches, debug);
  } finally {
    syncRunning = false;
  }
}
