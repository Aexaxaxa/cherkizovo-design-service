import { getEnv, getFigmaEnv } from "@/lib/env";
import { getPreviewObjectKey, listExistingPreviewFrameIds } from "@/lib/figmaPreviews";
import { figmaFetchJsonWithMeta } from "@/lib/figmaClient";
import { getSignedGetUrl } from "@/lib/s3";
import type { FigmaNodeLite } from "@/lib/figmaLayout";

type FigmaFileResponse = {
  document?: {
    children?: Array<{
      id?: string;
      type?: string;
      name?: string;
      children?: FigmaNodeLite[];
    }>;
  };
};

type FigmaNodesResponse = {
  nodes?: Record<string, { document?: FigmaNodeLite }>;
};

export type TemplateListItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

export type TemplateListDebug = {
  pages: Array<{ name: string; childCount: number }>;
  framesFoundTotal: number;
  framesReturned: number;
  previewsAvailableCount: number;
  previewsMissingCount: number;
  sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }>;
  figmaRateLimitTypes: string[];
};

type TemplateListCacheItem = {
  id: string;
  name: string;
  page: string;
};

type TemplatesCacheValue = {
  items: TemplateListCacheItem[];
  pages: Array<{ name: string; childCount: number }>;
  framesFoundTotal: number;
  figmaRateLimitTypes: string[];
};

export type TemplateSchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

export type TemplateSchema = {
  templateId: string;
  templateName: string;
  fields: TemplateSchemaField[];
};

const templatesCache = new Map<string, { expiresAt: number; value: TemplatesCacheValue }>();
const schemaCache = new Map<string, { expiresAt: number; value: TemplateSchema }>();
const frameCache = new Map<string, { expiresAt: number; value: FigmaNodeLite }>();

const fieldNameCollator = new Intl.Collator("ru", {
  sensitivity: "base",
  numeric: true
});

const PREVIEW_SIGNED_URL_SEC = 900;

function getTtlMs(): number {
  return getEnv().FIGMA_CACHE_TTL_SEC * 1000;
}

function getFileKey(): string {
  return getFigmaEnv().FIGMA_FILE_KEY;
}

function isVisible(node: FigmaNodeLite | undefined): boolean {
  return !!node && node.visible !== false;
}

function getNodeName(node: FigmaNodeLite | undefined): string {
  return typeof node?.name === "string" ? node.name : "";
}

function getNodeType(node: FigmaNodeLite | undefined): string {
  return typeof node?.type === "string" ? node.type : "";
}

function toTemplateCacheItems(file: FigmaFileResponse): TemplateListCacheItem[] {
  const pages = file.document?.children ?? [];
  const items: TemplateListCacheItem[] = [];

  for (const page of pages) {
    const pageName = typeof page.name === "string" ? page.name : "Untitled";
    const children = page.children ?? [];

    for (const node of children) {
      if (getNodeType(node) !== "FRAME") continue;
      if (!isVisible(node)) continue;
      if (!node.id) continue;
      const normalizedName = getNodeName(node).trim().toUpperCase();
      if (!normalizedName.startsWith("TPL")) continue;

      items.push({
        id: node.id,
        name: getNodeName(node) || node.id,
        page: pageName
      });
    }
  }

  return items;
}

function sortTemplates(items: TemplateListCacheItem[]): TemplateListCacheItem[] {
  const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  return [...items].sort((a, b) => {
    const byPage = collator.compare(a.page, b.page);
    if (byPage !== 0) return byPage;
    return collator.compare(a.name, b.name);
  });
}

function buildPageDebug(file: FigmaFileResponse): Array<{ name: string; childCount: number }> {
  const pages = file.document?.children ?? [];
  return pages.map((page) => ({
    name: typeof page.name === "string" ? page.name : "Untitled",
    childCount: Array.isArray(page.children) ? page.children.length : 0
  }));
}

function countVisibleFrames(file: FigmaFileResponse): number {
  const pages = file.document?.children ?? [];
  let framesFoundTotal = 0;

  for (const page of pages) {
    for (const node of page.children ?? []) {
      if (getNodeType(node) !== "FRAME") continue;
      if (!isVisible(node)) continue;
      framesFoundTotal += 1;
    }
  }

  return framesFoundTotal;
}

async function loadTemplatesFromFigma(fileKey: string): Promise<TemplatesCacheValue> {
  const { data: file, meta } = await figmaFetchJsonWithMeta<FigmaFileResponse>(
    `/v1/files/${encodeURIComponent(fileKey)}`
  );

  const items = sortTemplates(toTemplateCacheItems(file));
  const figmaRateLimitTypes = meta.rateLimitType ? [meta.rateLimitType] : [];

  return {
    items,
    pages: buildPageDebug(file),
    framesFoundTotal: countVisibleFrames(file),
    figmaRateLimitTypes
  };
}

async function getTemplatesCacheValue(refresh = false): Promise<TemplatesCacheValue> {
  const fileKey = getFileKey();
  const cacheKey = `templates:${fileKey}`;

  if (!refresh) {
    const cached = templatesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  const value = await loadTemplatesFromFigma(fileKey);
  templatesCache.set(cacheKey, {
    expiresAt: Date.now() + getTtlMs(),
    value
  });

  return value;
}

async function buildTemplatesWithPreviewUrls(items: TemplateListCacheItem[]): Promise<{
  templates: TemplateListItem[];
  previewsAvailableCount: number;
  previewsMissingCount: number;
  sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }>;
}> {
  const fileKey = getFileKey();
  const previewFrameIds = await listExistingPreviewFrameIds(fileKey);

  const templates: TemplateListItem[] = [];
  let previewsAvailableCount = 0;
  const sampleFirst10: Array<{ id: string; name: string; hasPreview: boolean }> = [];

  for (const item of items) {
    const hasPreview = previewFrameIds.has(item.id);
    if (hasPreview) {
      previewsAvailableCount += 1;
    }

    if (sampleFirst10.length < 10) {
      sampleFirst10.push({
        id: item.id,
        name: item.name,
        hasPreview
      });
    }

    let previewSignedUrl: string | null = null;
    if (hasPreview) {
      const objectKey = getPreviewObjectKey(fileKey, item.id);
      try {
        previewSignedUrl = await getSignedGetUrl(objectKey, PREVIEW_SIGNED_URL_SEC);
      } catch {
        previewSignedUrl = null;
      }
    }

    templates.push({
      id: item.id,
      name: item.name,
      page: item.page,
      previewSignedUrl
    });
  }

  return {
    templates,
    previewsAvailableCount,
    previewsMissingCount: Math.max(0, items.length - previewsAvailableCount),
    sampleFirst10
  };
}

export async function listTemplates(options?: { refresh?: boolean }): Promise<TemplateListItem[]> {
  const refresh = options?.refresh === true;
  const cacheValue = await getTemplatesCacheValue(refresh);
  const withPreview = await buildTemplatesWithPreviewUrls(cacheValue.items);
  return withPreview.templates;
}

export async function listTemplatesWithDebug(options?: {
  refresh?: boolean;
}): Promise<{ templates: TemplateListItem[]; debug: TemplateListDebug }> {
  const refresh = options?.refresh === true;
  const cacheValue = await getTemplatesCacheValue(refresh);
  const withPreview = await buildTemplatesWithPreviewUrls(cacheValue.items);

  return {
    templates: withPreview.templates,
    debug: {
      pages: cacheValue.pages,
      framesFoundTotal: cacheValue.framesFoundTotal,
      framesReturned: cacheValue.items.length,
      previewsAvailableCount: withPreview.previewsAvailableCount,
      previewsMissingCount: withPreview.previewsMissingCount,
      sampleFirst10: withPreview.sampleFirst10,
      figmaRateLimitTypes: cacheValue.figmaRateLimitTypes
    }
  };
}

export async function listTemplateFrames(options?: { refresh?: boolean }): Promise<{
  fileKey: string;
  frames: Array<{ id: string; name: string; page: string }>;
}> {
  const refresh = options?.refresh === true;
  const fileKey = getFileKey();
  const cacheValue = await getTemplatesCacheValue(refresh);

  return {
    fileKey,
    frames: cacheValue.items
  };
}

function flattenNodes(root: FigmaNodeLite): FigmaNodeLite[] {
  const out: FigmaNodeLite[] = [];

  function walk(node: FigmaNodeLite, parentVisible: boolean) {
    const nodeVisible = parentVisible && isVisible(node);
    if (!nodeVisible) {
      return;
    }
    out.push(node);
    for (const child of node.children ?? []) {
      walk(child, nodeVisible);
    }
  }

  walk(root, true);
  return out;
}

function toField(node: FigmaNodeLite): TemplateSchemaField | null {
  if (!isVisible(node)) return null;
  const name = getNodeName(node);
  if (!name) return null;

  if (/^text/i.test(name)) {
    return { key: name, type: "text", label: name };
  }

  if (/^photo/i.test(name)) {
    return { key: name, type: "image", label: name };
  }

  return null;
}

function sortFields(fields: TemplateSchemaField[]): TemplateSchemaField[] {
  return [...fields].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "text" ? -1 : 1;
    }
    return fieldNameCollator.compare(a.key, b.key);
  });
}

async function fetchFrameNode(frameId: string): Promise<FigmaNodeLite> {
  const fileKey = getFileKey();
  const { data: response } = await figmaFetchJsonWithMeta<FigmaNodesResponse>(
    `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(frameId)}`
  );

  const frameNode = response.nodes?.[frameId]?.document;
  if (!frameNode) {
    throw new Error(`Frame node ${frameId} not found`);
  }

  return frameNode;
}

export async function getTemplateFrameNode(frameId: string, refresh = false): Promise<FigmaNodeLite> {
  const cacheKey = `frame:${frameId}`;
  if (!refresh) {
    const cached = frameCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  const frameNode = await fetchFrameNode(frameId);
  frameCache.set(cacheKey, {
    expiresAt: Date.now() + getTtlMs(),
    value: frameNode
  });
  return frameNode;
}

export async function getTemplateSchema(frameId: string, refresh = false): Promise<TemplateSchema> {
  const cacheKey = `schema:${frameId}`;

  if (!refresh) {
    const cached = schemaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  const frameNode = await getTemplateFrameNode(frameId, refresh);
  const flattened = flattenNodes(frameNode);
  const fields = sortFields(flattened.map(toField).filter((field): field is TemplateSchemaField => field !== null));

  const schema: TemplateSchema = {
    templateId: frameId,
    templateName: getNodeName(frameNode) || frameId,
    fields
  };

  schemaCache.set(cacheKey, {
    expiresAt: Date.now() + getTtlMs(),
    value: schema
  });

  return schema;
}
