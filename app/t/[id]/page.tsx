"use client";

import Cropper, { type Area } from "react-easy-crop";
import { use, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

type SchemaResponse = {
  templateId: string;
  templateName: string;
  frame?: {
    width: number;
    height: number;
  } | null;
  photoFields?: Array<{
    name: string;
    nodeId: string;
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    cornerRadii?: [number, number, number, number];
  }>;
  fields: SchemaField[];
};

type GenerateResponse = {
  resultKey: string;
  signedGetUrl: string;
};

type TemplateListItem = {
  id: string;
  name: string;
  previewSignedUrl: string | null;
};

type UiError = {
  code: string;
  message: string;
};

type TextSizeAdjustValue = -1 | 0 | 1;

type PhotobankDirItem = {
  type: "dir";
  name: string;
  path: string;
};

type PhotobankFileItem = {
  type: "file";
  name: string;
  path: string;
  mimeType: string;
  size: number;
  previewUrl: string;
  fileId?: string;
};

type PhotobankItem = PhotobankDirItem | PhotobankFileItem;

type PhotobankBrowseResponse = {
  path: string;
  items: PhotobankItem[];
  hasMore: boolean;
};

type PhotobankRef = {
  source: "photobank";
  path: string;
  name: string;
  previewUrl: string;
};

type PhotoSelection =
  | {
      source: "local";
      file: File;
    }
  | PhotobankRef;

type CropPixels = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CropNorm = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type PhotoEditState = {
  cropNorm: CropNorm;
  zoom?: number;
};

type CropRectPx = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type MediaSize = {
  width: number;
  height: number;
};

type CropHandle =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

type ImgRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ResizeState = {
  pointerId: number;
  handle: CropHandle;
  startZoom: number;
  startCrop: { x: number; y: number };
  startImgRect: ImgRect;
  handleElement: HTMLButtonElement | null;
};

function asUiError(code: string, message: string): UiError {
  return { code, message };
}

function parseApiError(payload: unknown): UiError {
  if (!payload || typeof payload !== "object") {
    return asUiError("E_GENERATE_FAILED", "Не удалось выполнить операцию");
  }
  const code = "code" in payload && typeof payload.code === "string" ? payload.code : "E_GENERATE_FAILED";
  const message = "error" in payload && typeof payload.error === "string" ? payload.error : "Не удалось выполнить операцию";
  return asUiError(code, message);
}

function toSchemaLoadError(error: unknown): UiError {
  console.error("[schema]", error);
  return asUiError("E_SCHEMA_LOAD_FAILED", "Не удалось загрузить поля шаблона");
}

function toGenerateError(payload: unknown): UiError {
  const parsed = parseApiError(payload);
  if (parsed.code && parsed.code.startsWith("E_TEXT_TOO_LONG_")) {
    const field =
      payload && typeof payload === "object" && "field" in payload && typeof payload.field === "string"
        ? payload.field
        : parsed.code.replace("E_TEXT_TOO_LONG_", "");
    const maxLines =
      payload && typeof payload === "object" && "maxLines" in payload && typeof payload.maxLines === "number"
        ? payload.maxLines
        : null;
    const message = maxLines
      ? `Текст в блоке "${field}" слишком длинный, уменьшите текст (лимит: ${maxLines} строк).`
      : `Текст в блоке "${field}" слишком длинный, уменьшите текст.`;
    return asUiError(parsed.code, message);
  }

  if (parsed.code === "E_UPLOAD_TOO_LARGE") {
    return asUiError("E_UPLOAD_TOO_LARGE", "Файл слишком большой. Максимум 15MB");
  }

  if (parsed.code === "E_UPLOAD_TYPE") {
    return asUiError("E_UPLOAD_TYPE", "Неподдерживаемый формат файла. Разрешены JPEG, PNG, WEBP");
  }

  if (parsed.code === "E_PHOTOBANK_DOWNLOAD") {
    return asUiError("E_PHOTOBANK_DOWNLOAD", "Не удалось загрузить фото из фотобанка");
  }

  if (parsed.code === "E_CROP_OUT_OF_BOUNDS") {
    return asUiError("E_CROP_OUT_OF_BOUNDS", "Область обрезки выходит за пределы изображения. Уменьшите crop");
  }

  return parsed;
}

function getParentPhotobankPath(path: string): string {
  if (!path || path === "/") return "";
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return normalized.slice(0, lastSlash);
}

function isRootPhotobankPath(path: string | null | undefined): boolean {
  return !path || path === "/";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function createDownscaledPreviewUrl(file: File, maxSide = 1600): Promise<string> {
  const srcUrl = URL.createObjectURL(file);
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      return srcUrl;
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );
    bitmap.close();
    if (!blob) {
      return srcUrl;
    }
    URL.revokeObjectURL(srcUrl);
    return URL.createObjectURL(blob);
  } catch {
    return srcUrl;
  }
}

function isDebugUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEBUG_UI === "1" || process.env.DEBUG_UI === "1";
}

function debugUi(message: string, payload?: unknown): void {
  if (!isDebugUiEnabled()) return;
  if (payload === undefined) {
    console.debug(`[crop-ui] ${message}`);
    return;
  }
  console.debug(`[crop-ui] ${message}`, payload);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code = "E_CROP_PREVIEW_TIMEOUT"): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(code));
      }, timeoutMs);
    })
  ]);
}

export default function TemplateEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawTemplateId } = use(params);
  const decodedId = decodeURIComponent(rawTemplateId);

  const [templateName, setTemplateName] = useState(decodedId);
  const [schemaFields, setSchemaFields] = useState<SchemaField[]>([]);
  const [schemaFrame, setSchemaFrame] = useState<{ width: number; height: number } | null>(null);
  const [schemaPhotoFields, setSchemaPhotoFields] = useState<
    Array<{ name: string; nodeId: string; box: { x: number; y: number; width: number; height: number } }>
  >([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [photoSelections, setPhotoSelections] = useState<Record<string, PhotoSelection | null>>({});
  const [textSizeAdjust, setTextSizeAdjust] = useState<Record<string, TextSizeAdjustValue>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultLoaded, setResultLoaded] = useState(false);

  const [localPreviewUrls, setLocalPreviewUrls] = useState<Record<string, string>>({});
  const [photoEdits, setPhotoEdits] = useState<Record<string, PhotoEditState>>({});
  const [photobankOpen, setPhotobankOpen] = useState(false);
  const [activePhotoField, setActivePhotoField] = useState<string | null>(null);
  const [photobankPath, setPhotobankPath] = useState("");
  const [currentFolderName, setCurrentFolderName] = useState<string | null>(null);
  const [photobankItems, setPhotobankItems] = useState<PhotobankItem[]>([]);
  const [photobankHasMore, setPhotobankHasMore] = useState(false);
  const [photobankLoading, setPhotobankLoading] = useState(false);
  const [photobankLoadingMore, setPhotobankLoadingMore] = useState(false);
  const [photobankError, setPhotobankError] = useState<string | null>(null);
  const [folderNameByPath, setFolderNameByPath] = useState<Record<string, string>>({});
  const [cropOpen, setCropOpen] = useState(false);
  const [cropFieldKey, setCropFieldKey] = useState<string | null>(null);
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropNormDraft, setCropNormDraft] = useState<CropNorm | null>(null);
  const [cropRectPx, setCropRectPx] = useState<CropRectPx | null>(null);
  const [cropPreviewLoaded, setCropPreviewLoaded] = useState(false);
  const [cropMediaSize, setCropMediaSize] = useState<MediaSize | null>(null);
  const [cropInitialized, setCropInitialized] = useState(false);
  const [cropUiImageSrc, setCropUiImageSrc] = useState("");
  const [cropPreparingField, setCropPreparingField] = useState<string | null>(null);

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cropStageRef = useRef<HTMLDivElement | null>(null);
  const cropPreviewWrapRef = useRef<HTMLDivElement | null>(null);
  const cropPreviewImgRef = useRef<HTMLImageElement | null>(null);
  const cropperContainerRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const cropUiObjectUrlRef = useRef<string | null>(null);
  const cropMeasureRafRef = useRef<number | null>(null);
  const cropResizeObserverRef = useRef<ResizeObserver | null>(null);

  const clearCropUiImage = useCallback(() => {
    if (cropUiObjectUrlRef.current) {
      URL.revokeObjectURL(cropUiObjectUrlRef.current);
      cropUiObjectUrlRef.current = null;
    }
    setCropUiImageSrc("");
  }, []);

  const textFields = useMemo(() => schemaFields.filter((field) => field.type === "text"), [schemaFields]);
  const imageFields = useMemo(() => schemaFields.filter((field) => field.type === "image"), [schemaFields]);
  const photobankDirs = useMemo(
    () => photobankItems.filter((item): item is PhotobankDirItem => item.type === "dir"),
    [photobankItems]
  );
  const photobankFiles = useMemo(
    () => photobankItems.filter((item): item is PhotobankFileItem => item.type === "file"),
    [photobankItems]
  );

  useEffect(() => {
    const objectUrls: Record<string, string> = {};

    for (const [fieldKey, selection] of Object.entries(photoSelections)) {
      if (selection && selection.source === "local") {
        objectUrls[fieldKey] = URL.createObjectURL(selection.file);
      }
    }

    setLocalPreviewUrls((prev) => {
      for (const url of Object.values(prev)) {
        URL.revokeObjectURL(url);
      }
      return objectUrls;
    });

    return () => {
      for (const url of Object.values(objectUrls)) {
        URL.revokeObjectURL(url);
      }
    };
  }, [photoSelections]);

  const loadPreview = useCallback(async (templateId: string, templateNameValue: string) => {
    try {
      const response = await fetch("/api/templates", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as TemplateListItem[] | { error?: string } | null;

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error("Preview list request failed");
      }

      const matchedTemplate =
        payload.find((template) => template.id === templateId) ??
        payload.find((template) => template.name === templateNameValue);

      setPreviewUrl(matchedTemplate?.previewSignedUrl ?? null);
    } catch (err) {
      console.error("[preview]", err);
      setPreviewUrl(null);
    }
  }, []);

  const loadSchema = useCallback(async () => {
    setLoadingSchema(true);
    setError(null);
    setStatus("Загрузка полей...");

    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(decodedId)}/schema`, {
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as SchemaResponse | { error?: string } | null;

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Schema request failed: ${response.status}`
        );
      }
      if (!payload || typeof payload !== "object" || !("fields" in payload) || !Array.isArray(payload.fields)) {
        throw new Error("Schema response has invalid format");
      }

      setTemplateName(payload.templateName || decodedId);
      setSchemaFields(payload.fields);
      setSchemaFrame(payload.frame && payload.frame.width > 0 && payload.frame.height > 0 ? payload.frame : null);
      setSchemaPhotoFields(
        Array.isArray(payload.photoFields)
          ? payload.photoFields
              .filter(
                (item) =>
                  item &&
                  typeof item.name === "string" &&
                  item.box &&
                  Number.isFinite(item.box.x) &&
                  Number.isFinite(item.box.y) &&
                  Number.isFinite(item.box.width) &&
                  Number.isFinite(item.box.height)
              )
              .map((item) => ({
                name: item.name,
                nodeId: item.nodeId,
                box: {
                  x: Math.round(item.box.x),
                  y: Math.round(item.box.y),
                  width: Math.round(item.box.width),
                  height: Math.round(item.box.height)
                }
              }))
          : []
      );
      await loadPreview(decodedId, payload.templateName || decodedId);
      setStatus("");
    } catch (err) {
      const friendly = toSchemaLoadError(err);
      setError(friendly);
      setStatus(friendly.message);
    } finally {
      setLoadingSchema(false);
    }
  }, [decodedId, loadPreview]);

  useEffect(() => {
    setResultUrl(null);
    setResultLoaded(false);
    setPreviewUrl(null);
    setStatus("");
    setError(null);
    setFields({});
    setPhotoSelections({});
    setPhotoEdits({});
    setSchemaFrame(null);
    setSchemaPhotoFields([]);
    setTextSizeAdjust({});
    setPhotobankOpen(false);
    setActivePhotoField(null);
    setCurrentFolderName(null);
    setFolderNameByPath({});
    setCropOpen(false);
    setCropFieldKey(null);
    setCropNormDraft(null);
    setCropPreparingField(null);
    clearCropUiImage();
  }, [clearCropUiImage, decodedId]);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  const canGenerate = useMemo(() => !loadingSchema && !isGenerating, [isGenerating, loadingSchema]);

  const loadPhotobank = useCallback(async (path: string, append = false, folderName?: string | null) => {
    if (append) {
      setPhotobankLoadingMore(true);
    } else {
      setPhotobankLoading(true);
      setPhotobankError(null);
    }

    try {
      const offset = append ? photobankItems.length : 0;
      const params = new URLSearchParams();
      params.set("path", path);
      params.set("limit", "200");
      params.set("offset", String(offset));

      const response = await fetch(`/api/photobank/browse?${params.toString()}`, {
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as
        | PhotobankBrowseResponse
        | { code?: string; error?: string }
        | null;

      if (!response.ok || !payload || typeof payload !== "object" || !("items" in payload) || !Array.isArray(payload.items)) {
        const message = payload && typeof payload === "object" && "error" in payload ? payload.error : "Ошибка загрузки фотобанка";
        throw new Error(typeof message === "string" ? message : "Ошибка загрузки фотобанка");
      }

      setPhotobankPath(payload.path);
      if (!append) {
        if (isRootPhotobankPath(payload.path)) {
          setCurrentFolderName(null);
        } else if (typeof folderName === "string") {
          setCurrentFolderName(folderName);
        } else {
          setCurrentFolderName(folderNameByPath[payload.path] ?? null);
        }
      }
      setPhotobankItems((prev) => {
        if (!append) return payload.items;
        const merged = [...prev, ...payload.items];
        const byPath = new Map<string, PhotobankItem>();
        for (const item of merged) {
          byPath.set(item.path, item);
        }
        return [...byPath.values()];
      });
      setPhotobankHasMore(Boolean(payload.hasMore));
      setFolderNameByPath((prev) => {
        const next = { ...prev };
        for (const item of payload.items) {
          if (item.type === "dir") {
            next[item.path] = item.name;
          }
        }
        if (!isRootPhotobankPath(payload.path) && currentFolderName) {
          next[payload.path] = currentFolderName;
        }
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка загрузки фотобанка";
      setPhotobankError(message);
    } finally {
      if (append) {
        setPhotobankLoadingMore(false);
      } else {
        setPhotobankLoading(false);
      }
    }
  }, [currentFolderName, folderNameByPath, photobankItems.length]);

  async function openPhotobankForField(fieldKey: string) {
    setActivePhotoField(fieldKey);
    setPhotobankOpen(true);
    await loadPhotobank("", false, null);
  }

  const cropFieldLabel = useMemo(
    () => imageFields.find((field) => field.key === cropFieldKey)?.label ?? cropFieldKey ?? "",
    [cropFieldKey, imageFields]
  );

  const cropFieldGeometry = useMemo(() => {
    if (!cropFieldKey) return null;
    const lower = cropFieldKey.toLowerCase();
    return schemaPhotoFields.find((item) => item.name.toLowerCase() === lower) ?? null;
  }, [cropFieldKey, schemaPhotoFields]);

  const recalcCropRect = useCallback(
    (attempt = 0) => {
      if (!cropFieldGeometry || !schemaFrame || !cropPreviewWrapRef.current) {
        setCropRectPx(null);
        return;
      }

      const wrapperRect = cropPreviewWrapRef.current.getBoundingClientRect();
      const hasSize = wrapperRect.width > 0 && wrapperRect.height > 0;
      if (!hasSize) {
        if (attempt < 10) {
          if (cropMeasureRafRef.current) {
            cancelAnimationFrame(cropMeasureRafRef.current);
          }
          cropMeasureRafRef.current = requestAnimationFrame(() => recalcCropRect(attempt + 1));
          return;
        }
        const friendly = asUiError("E_CROP_PREVIEW_NOT_READY", "Не удалось подготовить область обрезки. Попробуйте снова.");
        setError(friendly);
        setStatus(friendly.message);
        setCropPreparingField(null);
        debugUi("cropRect failed after retries", { attempt });
        return;
      }

      const scaleX = wrapperRect.width / schemaFrame.width;
      const scaleY = wrapperRect.height / schemaFrame.height;
      const scale = Math.min(scaleX, scaleY);
      const nextRect = {
        left: cropFieldGeometry.box.x * scale,
        top: cropFieldGeometry.box.y * scale,
        width: cropFieldGeometry.box.width * scale,
        height: cropFieldGeometry.box.height * scale
      };
      setCropRectPx(nextRect);
      setCropPreparingField(null);
      setStatus("");
      debugUi("cropRect ready", nextRect);
    },
    [cropFieldGeometry, schemaFrame]
  );

  const getImageRect = useCallback(
    (zoom: number, crop: { x: number; y: number }, mediaSize: MediaSize, cropRect: CropRectPx): ImgRect => {
      const imgW = mediaSize.width * zoom;
      const imgH = mediaSize.height * zoom;
      const centerX = cropRect.width / 2 + crop.x;
      const centerY = cropRect.height / 2 + crop.y;
      const left = centerX - imgW / 2;
      const top = centerY - imgH / 2;
      return {
        left,
        top,
        right: left + imgW,
        bottom: top + imgH,
        width: imgW,
        height: imgH
      };
    },
    []
  );

  const imgRect = useMemo(() => {
    if (!cropRectPx || !cropMediaSize) return null;
    return getImageRect(cropZoom, cropPosition, cropMediaSize, cropRectPx);
  }, [cropMediaSize, cropPosition, cropRectPx, cropZoom, getImageRect]);

  const handleDescriptors = useMemo(() => {
    if (!imgRect || !cropRectPx) return [];
    const clampX = (value: number) => Math.max(0, Math.min(cropRectPx.width, value));
    const clampY = (value: number) => Math.max(0, Math.min(cropRectPx.height, value));

    const left = clampX(imgRect.left);
    const right = clampX(imgRect.right);
    const top = clampY(imgRect.top);
    const bottom = clampY(imgRect.bottom);
    const centerX = clampX((imgRect.left + imgRect.right) / 2);
    const centerY = clampY((imgRect.top + imgRect.bottom) / 2);

    return [
      { key: "top-left" as const, x: left, y: top, cursor: "nwse-resize" },
      { key: "top" as const, x: centerX, y: top, cursor: "ns-resize" },
      { key: "top-right" as const, x: right, y: top, cursor: "nesw-resize" },
      { key: "right" as const, x: right, y: centerY, cursor: "ew-resize" },
      { key: "bottom-right" as const, x: right, y: bottom, cursor: "nwse-resize" },
      { key: "bottom" as const, x: centerX, y: bottom, cursor: "ns-resize" },
      { key: "bottom-left" as const, x: left, y: bottom, cursor: "nesw-resize" },
      { key: "left" as const, x: left, y: centerY, cursor: "ew-resize" }
    ];
  }, [cropRectPx, imgRect]);

  async function openCropModal(fieldKey: string) {
    const selection = photoSelections[fieldKey];
    debugUi("open click", {
      fieldKey,
      hasSelection: Boolean(selection),
      source: selection?.source,
      hasFile: selection?.source === "local" ? Boolean(selection.file) : false,
      photobankPath: selection?.source === "photobank" ? selection.path : undefined
    });
    if (!selection) {
      const friendly = asUiError("E_CROP_REQUIRED", "Сначала выберите фото для обрезки");
      setError(friendly);
      setStatus(friendly.message);
      return;
    }

    const geometry = schemaPhotoFields.find((item) => item.name.toLowerCase() === fieldKey.toLowerCase());
    if (!geometry || !schemaFrame) {
      const friendly = asUiError("E_PHOTO_GEOMETRY_MISSING", `В этом шаблоне нет слоя ${fieldKey}`);
      setError(friendly);
      setStatus(friendly.message);
      return;
    }

    let nextCropUiSrc = "";
    setCropPreparingField(fieldKey);
    setError(null);
    setStatus("Подготовка обрезки...");
    try {
      if (selection.source === "local") {
        nextCropUiSrc = await withTimeout(createDownscaledPreviewUrl(selection.file, 1600), 10_000);
        if (cropUiObjectUrlRef.current) {
          URL.revokeObjectURL(cropUiObjectUrlRef.current);
        }
        cropUiObjectUrlRef.current = nextCropUiSrc;
      } else {
        const response = await withTimeout(
          fetch(`/api/photobank/preview?path=${encodeURIComponent(selection.path)}&size=XL`, {
            cache: "no-store"
          }),
          10_000
        );
        const payload = (await response.json().catch(() => null)) as { previewUrl?: string } | null;
        nextCropUiSrc = payload?.previewUrl && response.ok ? payload.previewUrl : selection.previewUrl;
      }
    } catch (errorUnknown) {
      const code =
        errorUnknown instanceof Error && errorUnknown.message === "E_CROP_PREVIEW_TIMEOUT"
          ? "E_CROP_PREVIEW_TIMEOUT"
          : "E_CROP_PREVIEW_FAILED";
      debugUi("preview prepare error", {
        fieldKey,
        code,
        error: errorUnknown instanceof Error ? errorUnknown.message : String(errorUnknown)
      });
      nextCropUiSrc = selection.source === "photobank" ? selection.previewUrl : (localPreviewUrls[fieldKey] ?? URL.createObjectURL(selection.file));
      if (selection.source === "local" && !cropUiObjectUrlRef.current && nextCropUiSrc.startsWith("blob:")) {
        cropUiObjectUrlRef.current = nextCropUiSrc;
      }
      const friendly = asUiError(
        code,
        code === "E_CROP_PREVIEW_TIMEOUT"
          ? "Превью для обрезки готовится слишком долго. Попробуйте снова."
          : "Не удалось подготовить превью в высоком качестве. Использовано базовое превью."
      );
      setStatus(friendly.message);
    }

    if (!nextCropUiSrc) {
      const friendly = asUiError("E_CROP_PREVIEW_FAILED", "Не удалось подготовить изображение для обрезки");
      setError(friendly);
      setStatus(friendly.message);
      setCropPreparingField(null);
      return;
    }

    const existing = photoEdits[fieldKey];
    setCropUiImageSrc(nextCropUiSrc);
    setCropFieldKey(fieldKey);
    setCropPosition({ x: 0, y: 0 });
    setCropZoom(existing?.zoom && Number.isFinite(existing.zoom) ? existing.zoom : 1);
    setCropNormDraft(existing?.cropNorm ?? null);
    setCropRectPx(null);
    setCropPreviewLoaded(true);
    setCropMediaSize(null);
    setCropInitialized(false);
    setCropOpen(true);
    setStatus("Подготовка обрезки...");
    debugUi("crop opened", { fieldKey, source: selection.source });
  }

  function confirmCrop() {
    if (!cropFieldKey || !cropNormDraft) {
      const friendly = asUiError("E_CROP_REQUIRED", "Не удалось сохранить обрезку. Попробуйте еще раз");
      setError(friendly);
      setStatus(friendly.message);
      return;
    }

    setPhotoEdits((prev) => ({
      ...prev,
      [cropFieldKey]: {
        cropNorm: cropNormDraft,
        zoom: cropZoom
      }
    }));
    setCropOpen(false);
    setCropFieldKey(null);
    setCropNormDraft(null);
    setCropPreparingField(null);
    clearCropUiImage();
    setCropInitialized(false);
  }

  function cancelCrop() {
    setCropOpen(false);
    setCropFieldKey(null);
    setCropNormDraft(null);
    setCropPreparingField(null);
    clearCropUiImage();
    setCropInitialized(false);
  }

  const onHandlePointerMove = useCallback((event: PointerEvent) => {
    const state = resizeStateRef.current;
    const container = cropperContainerRef.current;
    const mediaSize = cropMediaSize;
    if (!state || !container || !mediaSize) return;

    const containerRect = container.getBoundingClientRect();
    const pointerX = event.clientX - containerRect.left;
    const pointerY = event.clientY - containerRect.top;
    const leftFixed = state.startImgRect.left;
    const rightFixed = state.startImgRect.right;
    const topFixed = state.startImgRect.top;
    const bottomFixed = state.startImgRect.bottom;

    const handle = state.handle;
    const hasLeft = handle === "left" || handle === "top-left" || handle === "bottom-left";
    const hasRight = handle === "right" || handle === "top-right" || handle === "bottom-right";
    const hasTop = handle === "top" || handle === "top-left" || handle === "top-right";
    const hasBottom = handle === "bottom" || handle === "bottom-left" || handle === "bottom-right";

    let widthFromPointer = 0;
    let heightFromPointer = 0;
    if (hasRight) widthFromPointer = Math.max(1, pointerX - leftFixed);
    if (hasLeft) widthFromPointer = Math.max(1, rightFixed - pointerX);
    if (hasBottom) heightFromPointer = Math.max(1, pointerY - topFixed);
    if (hasTop) heightFromPointer = Math.max(1, bottomFixed - pointerY);

    let nextZoom = state.startZoom;
    if (hasLeft || hasRight) {
      nextZoom = widthFromPointer / mediaSize.width;
    }
    if (hasTop || hasBottom) {
      const zoomByHeight = heightFromPointer / mediaSize.height;
      nextZoom = hasLeft || hasRight ? Math.max(nextZoom, zoomByHeight) : zoomByHeight;
    }
    nextZoom = Math.max(1, Math.min(6, nextZoom));

    const nextW = mediaSize.width * nextZoom;
    const nextH = mediaSize.height * nextZoom;

    let centerX = cropRectPx ? cropRectPx.width / 2 + state.startCrop.x : 0;
    let centerY = cropRectPx ? cropRectPx.height / 2 + state.startCrop.y : 0;

    if (hasRight) centerX = leftFixed + nextW / 2;
    if (hasLeft) centerX = rightFixed - nextW / 2;
    if (hasBottom) centerY = topFixed + nextH / 2;
    if (hasTop) centerY = bottomFixed - nextH / 2;

    if (!cropRectPx) return;
    setCropZoom(nextZoom);
    setCropPosition({
      x: centerX - cropRectPx.width / 2,
      y: centerY - cropRectPx.height / 2
    });
  }, [cropMediaSize, cropRectPx]);

  const stopHandleZoom = useCallback(() => {
    if (resizeStateRef.current?.handleElement && resizeStateRef.current.handleElement.hasPointerCapture(resizeStateRef.current.pointerId)) {
      resizeStateRef.current.handleElement.releasePointerCapture(resizeStateRef.current.pointerId);
    }
    resizeStateRef.current = null;
    window.removeEventListener("pointermove", onHandlePointerMove);
  }, [onHandlePointerMove]);

  const onHandlePointerUp = useCallback((event: PointerEvent) => {
    const state = resizeStateRef.current;
    if (!state) return;
    if (event.pointerId !== state.pointerId) return;
    window.removeEventListener("pointerup", onHandlePointerUp);
    window.removeEventListener("pointercancel", onHandlePointerUp);
    stopHandleZoom();
  }, [stopHandleZoom]);

  const startHandleZoom = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!cropRectPx || !imgRect) return;
    const handle = event.currentTarget.dataset.handle as CropHandle | undefined;
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      pointerId: event.pointerId,
      handle,
      startZoom: cropZoom,
      startCrop: cropPosition,
      startImgRect: imgRect,
      handleElement: event.currentTarget
    };

    window.addEventListener("pointermove", onHandlePointerMove);
    window.addEventListener("pointerup", onHandlePointerUp);
    window.addEventListener("pointercancel", onHandlePointerUp);
  }, [cropPosition, cropRectPx, cropZoom, imgRect, onHandlePointerMove, onHandlePointerUp]);

  useEffect(() => {
    if (!cropOpen) return;
    if (!cropFieldGeometry || !schemaFrame) return;
    recalcCropRect(0);

    const observerTarget = cropPreviewWrapRef.current;
    if (observerTarget && typeof ResizeObserver !== "undefined") {
      cropResizeObserverRef.current?.disconnect();
      cropResizeObserverRef.current = new ResizeObserver(() => recalcCropRect(0));
      cropResizeObserverRef.current.observe(observerTarget);
    }

    const onResize = () => recalcCropRect(0);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cropResizeObserverRef.current?.disconnect();
      cropResizeObserverRef.current = null;
      if (cropMeasureRafRef.current) {
        cancelAnimationFrame(cropMeasureRafRef.current);
        cropMeasureRafRef.current = null;
      }
    };
  }, [cropFieldGeometry, cropOpen, recalcCropRect, schemaFrame]);

  useEffect(() => {
    if (!cropOpen || !previewUrl || !cropPreviewImgRef.current) return;
    if (!cropPreviewImgRef.current.complete) return;
    setCropPreviewLoaded(true);
  }, [cropOpen, previewUrl]);

  useEffect(() => {
    if (!cropOpen || cropInitialized || !cropRectPx || !cropMediaSize) return;
    const initialZoom = Math.max(cropRectPx.width / cropMediaSize.width, cropRectPx.height / cropMediaSize.height, 1);
    setCropPosition({ x: 0, y: 0 });
    setCropZoom(initialZoom);
    setCropInitialized(true);
  }, [cropInitialized, cropMediaSize, cropOpen, cropRectPx]);

  useEffect(
    () => () => {
      window.removeEventListener("pointerup", onHandlePointerUp);
      window.removeEventListener("pointercancel", onHandlePointerUp);
      stopHandleZoom();
      cropResizeObserverRef.current?.disconnect();
      cropResizeObserverRef.current = null;
      if (cropMeasureRafRef.current) {
        cancelAnimationFrame(cropMeasureRafRef.current);
        cropMeasureRafRef.current = null;
      }
      clearCropUiImage();
    },
    [clearCropUiImage, onHandlePointerUp, stopHandleZoom]
  );

  function validateBeforeGenerate(): UiError | null {
    for (const field of textFields) {
      const value = fields[field.key]?.trim() ?? "";
      if (!value) return asUiError(`E_TEXT_REQUIRED_${field.key}`, `Заполните поле "${field.label}"`);
    }

    for (const field of imageFields) {
      const selection = photoSelections[field.key];
      if (!selection) {
        return asUiError(`E_PHOTO_REQUIRED_${field.key}`, `Выберите фото для поля "${field.label}"`);
      }
    }

    return null;
  }

  async function validateTextLimitsBeforeGenerate(): Promise<UiError | null> {
    const textPayload: Record<string, string> = {};
    for (const field of textFields) {
      textPayload[field.key] = fields[field.key] ?? "";
    }

    const response = await fetch("/api/generate?validate=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: decodedId,
        fields: textPayload,
        textSizeAdjust
      })
    });

    const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (response.ok) {
      return null;
    }
    return toGenerateError(payload);
  }

  async function handleGenerate() {
    setError(null);
    const validationError = validateBeforeGenerate();
    if (validationError) {
      setError(validationError);
      setStatus(validationError.message);
      return;
    }

    try {
      const limitsError = await validateTextLimitsBeforeGenerate();
      if (limitsError) {
        setError(limitsError);
        setStatus(limitsError.message);
        return;
      }
    } catch (err) {
      console.error("[generate preflight]", err);
      const friendly = asUiError("E_GENERATE_FAILED", "Не удалось проверить ограничения текста");
      setError(friendly);
      setStatus(friendly.message);
      return;
    }

    setIsGenerating(true);
    setStatus("Создание изображения...");

    try {
      const textPayload: Record<string, string> = {};
      for (const field of textFields) {
        textPayload[field.key] = fields[field.key] ?? "";
      }

      const photoRefs: Record<string, PhotobankRef> = {};
      const formData = new FormData();
      formData.append("templateId", decodedId);
      formData.append("fields", JSON.stringify(textPayload));
      formData.append("textSizeAdjust", JSON.stringify(textSizeAdjust));

      for (const imageField of imageFields) {
        const selection = photoSelections[imageField.key];
        if (!selection) continue;

        if (selection.source === "local") {
          formData.append(imageField.key, selection.file, selection.file.name);
        } else {
          photoRefs[imageField.key] = selection;
        }
      }

      formData.append("photoRefs", JSON.stringify(photoRefs));
      formData.append("photoEdits", JSON.stringify(photoEdits));

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json().catch(() => null)) as GenerateResponse | { error?: string; code?: string } | null;
      if (!response.ok) {
        console.error("[generate] api error", payload);
        const friendly = toGenerateError(payload);
        setError(friendly);
        setStatus(friendly.message);
        return;
      }
      if (!payload || typeof payload !== "object" || !("signedGetUrl" in payload) || typeof payload.signedGetUrl !== "string") {
        throw new Error("Generate response has invalid format");
      }

      setResultUrl(payload.signedGetUrl);
      setResultLoaded(false);
      setStatus("Изображение создано");
    } catch (err) {
      console.error("[generate]", err);
      const friendly = asUiError("E_GENERATE_FAILED", "Не удалось создать изображение");
      setError(friendly);
      setStatus(friendly.message);
    } finally {
      setIsGenerating(false);
    }
  }

  const photobankTitle = isRootPhotobankPath(photobankPath)
    ? "Фотобанк"
    : currentFolderName
      ? `Фотобанк: ${currentFolderName}`
      : "Фотобанк";
  const isInlineCropping = Boolean(
    cropOpen && cropFieldKey && cropFieldGeometry?.box && schemaFrame && cropUiImageSrc
  );

  return (
    <main>
      <div className="card">
        <h1>{templateName}</h1>
        {status ? <p className="muted">{status}</p> : null}

        {error ? (
          <div className="field-block">
            <p className="muted" style={{ color: "#a30000" }}>
              {error.message}
            </p>
          </div>
        ) : null}

        {loadingSchema ? <p className="muted">Загрузка...</p> : null}

        {textFields.map((field) => (
          <div key={field.key} className="field-block">
            <div className="text-field-header">
              <label htmlFor={field.key}>{field.label}</label>
              <div className="size-adjust" role="radiogroup" aria-label={`Размер текста ${field.label}`}>
                <span className="size-adjust-line" />
                {([-1, 0, 1] as const).map((value) => {
                  const current = textSizeAdjust[field.key] ?? 0;
                  const isActive = current === value;
                  const title = value === -1 ? "-10pt" : value === 1 ? "+10pt" : "0";
                  const marker = value === -1 ? "-" : value === 1 ? "+" : "";
                  return (
                    <button
                      key={`${field.key}:${value}`}
                      type="button"
                      className={`size-adjust-dot${isActive ? " is-active" : ""}`}
                      aria-label={`${field.label}: ${title}`}
                      aria-pressed={isActive}
                      onClick={() =>
                        setTextSizeAdjust((prev) => ({
                          ...prev,
                          [field.key]: value
                        }))
                      }
                    >
                      {marker}
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              id={field.key}
              rows={4}
              value={fields[field.key] ?? ""}
              onChange={(event) =>
                setFields((prev) => ({
                  ...prev,
                  [field.key]: event.target.value
                }))
              }
            />
          </div>
        ))}

        {imageFields.map((field) => {
          const selection = photoSelections[field.key] ?? null;
          const hasPhoto = Boolean(selection);
          const isPreparingCropForField = cropPreparingField === field.key;
          const localPreview = localPreviewUrls[field.key];
          const previewSrc =
            selection && selection.source === "photobank" ? selection.previewUrl : selection && selection.source === "local" ? localPreview : "";

          return (
            <div key={field.key} className="field-block">
              <label>{field.label}</label>
              <div className="row">
                <button
                  type="button"
                  onClick={() => fileInputRefs.current[field.key]?.click()}
                  disabled={isGenerating}
                >
                  Загрузить
                </button>
                <button type="button" onClick={() => void openPhotobankForField(field.key)} disabled={isGenerating}>
                  Фотобанк
                </button>
                <button
                  type="button"
                  onClick={() => void openCropModal(field.key)}
                  disabled={isGenerating || !hasPhoto || isPreparingCropForField}
                >
                  {isPreparingCropForField ? "Подготовка..." : "Обрезать фото"}
                </button>
                {hasPhoto ? (
                  <button
                    type="button"
                    onClick={() =>
                      {
                        setPhotoSelections((prev) => ({
                          ...prev,
                          [field.key]: null
                        }));
                        setPhotoEdits((prev) => {
                          const next = { ...prev };
                          delete next[field.key];
                          return next;
                        });
                      }
                    }
                    disabled={isGenerating}
                  >
                    Сбросить
                  </button>
                ) : null}
              </div>

              <input
                ref={(node) => {
                  fileInputRefs.current[field.key] = node;
                }}
                id={`upload-${field.key}`}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setPhotoSelections((prev) => ({
                    ...prev,
                    [field.key]: file ? { source: "local", file } : null
                  }));
                  setPhotoEdits((prev) => {
                    const next = { ...prev };
                    delete next[field.key];
                    return next;
                  });
                  event.currentTarget.value = "";
                }}
              />

              <p className="muted">
                {!selection
                  ? "Фото не выбрано"
                  : "Фото выбрано"}
              </p>

              {previewSrc ? (
                <div className="selected-photo-preview-wrap">
                  <img src={previewSrc} alt={field.label} className="selected-photo-preview" />
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="row">
          <button type="button" onClick={() => void handleGenerate()} disabled={!canGenerate}>
            {isGenerating ? "Создание..." : "Создать изображение"}
          </button>
          {resultUrl ? (
            <button type="button" onClick={() => window.open(resultUrl, "_blank", "noopener,noreferrer")}>
              Скачать
            </button>
          ) : null}
        </div>

        <div className="field-block">
          {isInlineCropping ? (
            <>
              <p className="muted">Обрезка фото: {cropFieldLabel}</p>
              <div className="result-preview-wrap">
                <div className="crop-stage" ref={cropStageRef}>
                  <div
                    ref={cropPreviewWrapRef}
                    className="crop-preview-wrap"
                    style={schemaFrame ? { aspectRatio: `${schemaFrame.width} / ${schemaFrame.height}` } : undefined}
                  >
                    {previewUrl ? (
                      <img
                        ref={cropPreviewImgRef}
                        src={previewUrl}
                        alt="Template preview"
                        className="crop-stage-preview"
                        onLoad={() => {
                          setCropPreviewLoaded(true);
                        }}
                      />
                    ) : (
                      <div className="crop-stage-empty">Preview шаблона недоступен</div>
                    )}

                    {cropRectPx ? (
                      <>
                        <div
                          className="crop-outside-mask-part"
                          style={{
                            left: 0,
                            top: 0,
                            width: "100%",
                            height: cropRectPx.top
                          }}
                        />
                        <div
                          className="crop-outside-mask-part"
                          style={{
                            left: 0,
                            top: cropRectPx.top + cropRectPx.height,
                            width: "100%",
                            bottom: 0
                          }}
                        />
                        <div
                          className="crop-outside-mask-part"
                          style={{
                            left: 0,
                            top: cropRectPx.top,
                            width: cropRectPx.left,
                            height: cropRectPx.height
                          }}
                        />
                        <div
                          className="crop-outside-mask-part"
                          style={{
                            left: cropRectPx.left + cropRectPx.width,
                            top: cropRectPx.top,
                            right: 0,
                            height: cropRectPx.height
                          }}
                        />
                      </>
                    ) : null}

                    {cropRectPx ? (
                      <div
                        ref={cropperContainerRef}
                        className="crop-area-container"
                        style={{
                          left: cropRectPx.left,
                          top: cropRectPx.top,
                          width: cropRectPx.width,
                          height: cropRectPx.height
                        }}
                        onWheelCapture={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <Cropper
                          image={cropUiImageSrc}
                          crop={cropPosition}
                          zoom={cropZoom}
                          aspect={
                            cropFieldGeometry ? cropFieldGeometry.box.width / cropFieldGeometry.box.height : 1
                          }
                          cropSize={{
                            width: cropRectPx.width,
                            height: cropRectPx.height
                          }}
                          onCropChange={setCropPosition}
                          onZoomChange={setCropZoom}
                          onMediaLoaded={(media) => {
                            if (!media || !Number.isFinite(media.width) || !Number.isFinite(media.height)) return;
                            setCropMediaSize({
                              width: Number.isFinite(media.naturalWidth ?? NaN) ? Number(media.naturalWidth) : media.width,
                              height: Number.isFinite(media.naturalHeight ?? NaN) ? Number(media.naturalHeight) : media.height
                            });
                          }}
                          onCropComplete={(_croppedArea: Area, croppedAreaPixels: Area) => {
                            if (!cropMediaSize || cropMediaSize.width <= 0 || cropMediaSize.height <= 0) return;
                            setCropNormDraft({
                              x: clamp01(croppedAreaPixels.x / cropMediaSize.width),
                              y: clamp01(croppedAreaPixels.y / cropMediaSize.height),
                              w: clamp01(croppedAreaPixels.width / cropMediaSize.width),
                              h: clamp01(croppedAreaPixels.height / cropMediaSize.height)
                            });
                          }}
                          objectFit="contain"
                          showGrid={false}
                          zoomWithScroll={false}
                          restrictPosition={false}
                          style={{
                            containerStyle: {
                              overflow: "visible"
                            },
                            cropAreaStyle: {
                              border: "0"
                            }
                          }}
                        />
                        <div className="crop-handles-layer" aria-hidden="true">
                          {handleDescriptors.map((handle) => (
                            <button
                              key={handle.key}
                              type="button"
                              className="crop-handle"
                              data-handle={handle.key}
                              style={{
                                left: `${handle.x}px`,
                                top: `${handle.y}px`,
                                cursor: handle.cursor
                              }}
                              aria-label="Изменить масштаб"
                              onPointerDown={startHandleZoom}
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="crop-loading-overlay">
                        <span className="result-preview-spinner" />
                        <span className="muted">Подготовка обрезки...</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" onClick={() => confirmCrop()} disabled={!cropNormDraft}>
                  Подтвердить
                </button>
                <button type="button" onClick={() => cancelCrop()}>
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <div className="result-preview-wrap" aria-busy={isGenerating || (Boolean(resultUrl) && !resultLoaded)}>
              {resultUrl || previewUrl ? (
                <div className="result-preview-stack">
                  {previewUrl && (!resultUrl || !resultLoaded) ? (
                    <img src={previewUrl} alt="Preview template" className="result-preview-image" />
                  ) : null}
                  {resultUrl ? (
                    <img
                      src={resultUrl}
                      alt="Готовый макет"
                      className="result-preview-image"
                      onLoad={() => setResultLoaded(true)}
                      onError={() => {
                        const friendly = asUiError("E_RESULT_LOAD_FAILED", "Не удалось загрузить созданный макет");
                        setError(friendly);
                        setStatus(friendly.message);
                        setResultLoaded(false);
                        setResultUrl(null);
                      }}
                      style={{ opacity: resultLoaded ? 1 : 0 }}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="result-preview-empty muted">Preview unavailable</div>
              )}
              {isGenerating || (Boolean(resultUrl) && !resultLoaded) ? (
                <div className="result-preview-loader" role="status" aria-live="polite">
                  <span className="result-preview-spinner" />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {photobankOpen ? (
        <div className="modal-backdrop" onClick={() => setPhotobankOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{photobankTitle}</h2>
              <button type="button" onClick={() => setPhotobankOpen(false)}>
                Закрыть
              </button>
            </div>

            {!isRootPhotobankPath(photobankPath) ? (
              <div className="row">
                <button
                  type="button"
                  onClick={() => {
                    const parentPath = getParentPhotobankPath(photobankPath);
                    const parentName = isRootPhotobankPath(parentPath) ? null : folderNameByPath[parentPath] ?? null;
                    void loadPhotobank(parentPath, false, parentName);
                  }}
                  disabled={photobankLoading || photobankLoadingMore}
                >
                  Назад
                </button>
              </div>
            ) : null}

            {photobankError ? <p className="muted" style={{ color: "#a30000" }}>{photobankError}</p> : null}
            {photobankLoading ? <p className="muted">Загрузка...</p> : null}

            {photobankDirs.length > 0 ? (
              <div className="photobank-folders">
                {photobankDirs.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="photobank-item photobank-folder"
                    onClick={() => void loadPhotobank(item.path, false, item.name)}
                    disabled={photobankLoading || photobankLoadingMore}
                    title={item.name}
                    aria-label={item.name}
                  >
                    <span className="photobank-folder-content">
                      <span className="photobank-folder-icon" aria-hidden="true">📁</span>
                      <span className="photobank-folder-name">{item.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="photobank-photo-grid">
              {photobankFiles.map((item) => (
                <button
                  type="button"
                  className="photobank-photo-card"
                  key={item.path}
                  disabled={!activePhotoField}
                  title={item.name}
                  aria-label={item.name}
                  onClick={() => {
                    if (!activePhotoField) return;
                    setPhotoSelections((prev) => ({
                      ...prev,
                      [activePhotoField]: {
                        source: "photobank",
                        path: item.path,
                        name: item.name,
                        previewUrl: item.previewUrl
                      }
                    }));
                    setPhotoEdits((prev) => {
                      const next = { ...prev };
                      delete next[activePhotoField];
                      return next;
                    });
                    setPhotobankOpen(false);
                  }}
                >
                  <img src={item.previewUrl} alt={item.name} className="photobank-preview" />
                </button>
              ))}
            </div>
            {photobankHasMore ? (
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => void loadPhotobank(photobankPath, true)}
                  disabled={photobankLoading || photobankLoadingMore}
                >
                  {photobankLoadingMore ? "Загрузка..." : "Показать еще"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
