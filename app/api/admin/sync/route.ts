import { NextResponse } from "next/server";
import {
  ADMIN_SYNC_LOCK_TTL_MS,
  createMetaDefaults,
  readAdminSyncLock,
  readAdminSyncMeta,
  releaseAdminSyncLock,
  type AdminSyncMeta,
  writeAdminSyncLock,
  writeAdminSyncMeta
} from "@/lib/adminSyncState";
import { getEnv } from "@/lib/env";
import { FigmaApiError, figmaFetchBytes, figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { extractSchemaFields } from "@/lib/schemaExtractor";
import {
  getFrameSnapshotKey,
  getSchemaSnapshotKey,
  getTemplatesSnapshotKey,
  toSafeNodeId,
  tryReadSnapshotJson,
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

type AssetKind = "logo" | "logo_bg" | "sticker" | "marks";

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

function isTimeoutError(error: unknown): boolean {
  if (error instanceof FigmaApiError) {
    return error.status === 504 || (typeof error.message === "string" && error.message.includes("timed out"));
  }
  return false;
}

function getOwnerTag(): string {
  const host = process.env.VERCEL_URL || process.env.HOSTNAME || "local";
  return `${host}:${process.pid}`;
}

function withResponseStatus(error: unknown): number {
  if (error instanceof FigmaApiError && error.status === 429) return 429;
  if (isTimeoutError(error)) return 503;
  return 500;
}

function buildFrameAssetsMap(root: FigmaNode, assetsMap: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  function walk(node: FigmaNode) {
    if (node.visible === false) return;
    if (node.id) {
      const assetKey = assetsMap.get(node.id);
      if (assetKey) out[node.id] = assetKey;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  }

  walk(root);
  return out;
}

const EXPORT_ASSET_NAMES = new Set(["logo", "logo_bg", "sticker", "marks"]);

function collectAssetNodes(root: FigmaNode, out: Map<string, AssetKind>): void {
  if (root.visible === false) return;
  const lowerName = normalizeName(root.name).toLowerCase();
  if (root.id && EXPORT_ASSET_NAMES.has(lowerName)) {
    out.set(root.id, lowerName as AssetKind);
  }
  for (const child of root.children ?? []) {
    collectAssetNodes(child, out);
  }
}

async function fetchNodesWithFallback(
  fileKey: string,
  frameIds: string[]
): Promise<{ documents: Map<string, FigmaNode>; batchSizeUsed: number }> {
  let lastTimeoutError: unknown = null;

  for (const batchSize of NODE_BATCH_FALLBACK) {
    try {
      const docs = new Map<string, FigmaNode>();
      for (const idsChunk of chunk(frameIds, batchSize)) {
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
          if (frameDoc) docs.set(frameId, frameDoc);
        }
      }
      return { documents: docs, batchSizeUsed: batchSize };
    } catch (error) {
      if (error instanceof FigmaApiError && error.status === 429) throw error;
      if (isTimeoutError(error)) {
        lastTimeoutError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastTimeoutError instanceof Error) throw lastTimeoutError;
  throw new Error("Failed to fetch nodes with fallback batch sizes");
}

function isAuthorized(request: Request): boolean {
  const adminSecret = process.env.ADMIN_SYNC_SECRET?.trim();
  const requestSecret = request.headers.get("x-admin-secret")?.trim();
  if (adminSecret && requestSecret === adminSecret) return true;

  const token = new URL(request.url).searchParams.get("token")?.trim();
  const uiToken = process.env.ADMIN_UI_TOKEN?.trim();
  if (uiToken && token === uiToken) return true;

  return false;
}

function diffTemplates(prev: SnapshotTemplate[], next: SnapshotTemplate[]) {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const newTemplates = next.filter((item) => !prevById.has(item.id));
  const removedTemplates = prev.filter((item) => !nextById.has(item.id));
  return { newTemplates, removedTemplates };
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (syncRunning) {
    return NextResponse.json({ error: "Sync already running" }, { status: 409 });
  }

  syncRunning = true;

  const env = getEnv();
  const fileKey = env.FIGMA_FILE_KEY?.trim();
  if (!fileKey) {
    syncRunning = false;
    return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dry") === "1";
  const templateId = searchParams.get("templateId")?.trim() || null;
  const owner = getOwnerTag();
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ADMIN_SYNC_LOCK_TTL_MS).toISOString();

  const existingLock = await readAdminSyncLock(fileKey);
  if (existingLock && Date.parse(existingLock.expiresAt) > now) {
    const meta = await readAdminSyncMeta(fileKey);
    syncRunning = false;
    return NextResponse.json(
      {
        error: "Sync is locked",
        lock: existingLock,
        meta
      },
      { status: 423 }
    );
  }

  await writeAdminSyncLock(fileKey, { startedAt, owner, expiresAt });

  const meta: AdminSyncMeta = {
    ...createMetaDefaults(fileKey),
    status: "running",
    startedAt,
    syncedAt: startedAt,
    step: "init",
    dryRun,
    isPartial: Boolean(templateId),
    templateId
  };

  const saveMeta = async (patch?: Partial<AdminSyncMeta>) => {
    if (patch) Object.assign(meta, patch);
    await writeAdminSyncMeta(fileKey, meta);
  };

  try {
    await saveMeta();

    const existingTemplates = (await tryReadSnapshotJson<SnapshotTemplate[]>(getTemplatesSnapshotKey(fileKey))) ?? [];

    await saveMeta({ step: "fetch_file" });
    const { data: file } = await figmaFetchJsonWithMeta<FigmaFileResponse>(
      `/v1/files/${encodeURIComponent(fileKey)}`,
      {
        maxRetries: 1,
        sleepOn429: false,
        timeoutMs: FIGMA_SYNC_TIMEOUT_MS
      }
    );

    const allTemplates = extractTemplates(file);
    meta.templatesFound = allTemplates.length;
    await saveMeta({ step: "templates_collected" });

    let templatesToSync = allTemplates;
    if (templateId) {
      const selected = allTemplates.find((tpl) => tpl.id === templateId);
      if (!selected) {
        throw new Error(`Template not found in Figma file: ${templateId}`);
      }
      templatesToSync = [selected];
    }

    const templatesDiff = diffTemplates(existingTemplates, allTemplates);

    if (!dryRun) {
      await saveMeta({ step: "save_templates" });
      if (!templateId) {
        await writeSnapshotJson(getTemplatesSnapshotKey(fileKey), allTemplates);
      } else {
        const map = new Map(existingTemplates.map((tpl) => [tpl.id, tpl]));
        const selected = templatesToSync[0];
        map.set(selected.id, selected);
        const merged = [...map.values()];
        await writeSnapshotJson(getTemplatesSnapshotKey(fileKey), merged);
      }
    }

    const frameIds = templatesToSync.map((tpl) => tpl.id);
    const pendingChunks = chunk(frameIds, TARGET_BATCH_SIZE);
    meta.totalBatches = pendingChunks.length;
    await saveMeta({ step: "fetch_nodes", currentBatchIndex: 0 });

    const docsResult = await fetchNodesWithFallback(fileKey, frameIds);
    const docs = docsResult.documents;

    const exportedAssetsMap = new Map<string, string>();
    if (!dryRun) {
      await saveMeta({ step: "export_assets" });
      const assetsByNode = new Map<string, AssetKind>();
      for (const doc of docs.values()) {
        collectAssetNodes(doc, assetsByNode);
      }
      const missingNodeIds = [...assetsByNode.keys()].filter((nodeId) => !exportedAssetsMap.has(nodeId));

      for (let i = 0; i < missingNodeIds.length; i += TARGET_BATCH_SIZE) {
        const batchNodeIds = missingNodeIds.slice(i, i + TARGET_BATCH_SIZE);
        const idsCsv = batchNodeIds.join(",");
        const { data } = await figmaFetchJsonWithMeta<FigmaImagesResponse>(
          `/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(idsCsv)}&format=png&scale=1`,
          {
            maxRetries: 1,
            sleepOn429: false,
            timeoutMs: FIGMA_SYNC_TIMEOUT_MS
          }
        );

        for (const nodeId of batchNodeIds) {
          const imageUrl = data.images?.[nodeId];
          const kind = assetsByNode.get(nodeId);
          if (!imageUrl || !kind) continue;

          const bytes = await figmaFetchBytes(imageUrl, {
            maxRetries: 1,
            sleepOn429: false,
            timeoutMs: FIGMA_SYNC_TIMEOUT_MS
          });
          const safeNodeId = toSafeNodeId(nodeId);
          const assetKey = `snapshots/${fileKey}/assets/${safeNodeId}__${kind}.png`;
          await putObject({
            Key: assetKey,
            Body: bytes,
            ContentType: "image/png"
          });
          exportedAssetsMap.set(nodeId, assetKey);
          meta.assetsSaved += 1;
        }

        await saveMeta({
          step: "export_assets",
          currentBatchIndex: Math.min(meta.totalBatches, i / TARGET_BATCH_SIZE + 1)
        });
      }
    }

    await saveMeta({ step: "save_frames_and_schemas" });
    for (let i = 0; i < templatesToSync.length; i += 1) {
      const tpl = templatesToSync[i];
      const frameDoc = docs.get(tpl.id);
      meta.currentBatchIndex = Math.min(meta.totalBatches, Math.floor(i / TARGET_BATCH_SIZE) + 1);
      if (!frameDoc) {
        await saveMeta();
        continue;
      }

      frameDoc.assetsMap = buildFrameAssetsMap(frameDoc, exportedAssetsMap);

      if (!dryRun) {
        await writeSnapshotJson(getFrameSnapshotKey(fileKey, tpl.id), frameDoc);
        meta.framesSaved += 1;
        const schema = extractSchemaFields(frameDoc);
        await writeSnapshotJson(getSchemaSnapshotKey(fileKey, tpl.id), {
          templateId: tpl.id,
          templateName: normalizeName(frameDoc.name) || tpl.id,
          fields: schema.fields
        });
        meta.schemasSaved += 1;
      }

      await saveMeta();
    }

    const finishedAt = new Date().toISOString();
    await saveMeta({
      status: "ok",
      step: "finished",
      finishedAt,
      lastError: null
    });

    if (dryRun) {
      return NextResponse.json({
        status: "ok",
        dryRun: true,
        partial: Boolean(templateId),
        templateId,
        templatesFound: allTemplates.length,
        willSaveFrames: templatesToSync.length,
        willSaveSchemas: templatesToSync.length,
        willExportAssets: "auto-detected",
        newTemplates: templatesDiff.newTemplates,
        removedTemplates: templatesDiff.removedTemplates
      });
    }

    return NextResponse.json({
      status: "ok",
      dryRun: false,
      partial: Boolean(templateId),
      templateId,
      templatesFound: allTemplates.length,
      framesSaved: meta.framesSaved,
      schemasSaved: meta.schemasSaved,
      assetsSaved: meta.assetsSaved,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    const finishedAt = new Date().toISOString();
    await saveMeta({
      status: "error",
      step: "failed",
      lastError: message,
      finishedAt
    });
    return NextResponse.json(
      {
        error: message,
        meta
      },
      { status: withResponseStatus(error) }
    );
  } finally {
    await releaseAdminSyncLock(fileKey).catch(() => undefined);
    syncRunning = false;
  }
}
