"use client";

import Cropper, { type Area } from "react-easy-crop";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { RichColorTextField, type RichColorTextFieldHandle } from "./RichColorTextField";
import { AppIcon, LoadingMark, type IconName } from "@/app/ui";
import {
  getPlainTextFromSegments,
  normalizeHexColor,
  normalizeSegments,
  type TextSegment
} from "@/lib/richTextSegments";

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
  textDefaults?: Record<
    string,
    {
      defaultText?: string;
      defaultColor?: string;
    }
  >;
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
type EditorActionTone = "primary" | "soft";
type EditorViewportState = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  scale: number;
  isMobile: boolean;
};
type EditorIconSizes = {
  actionCard: number;
  actionButton: number;
  refresh: number;
  warning: number;
  close: number;
};

const RICH_TEXT_FIELD_KEY = "text";
const RICH_TEXT_COLORS = ["#CE0037", "#000000"] as const;
const EDITOR_REFERENCE = {
  width: 1920,
  height: 1080,
  mobileBreakpoint: 980
} as const;
const EDITOR_ICON_MAP = {
  cancel: "close",
  confirm: "confirm",
  create: "create",
  crop: "crop",
  download: "download",
  photobank: "gallery",
  refresh: "refresh",
  upload: "upload"
} as const satisfies Record<string, IconName>;

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

type CropNorm = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type PhotoEditState = {
  cropNorm: CropNorm;
};

type PhotoBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CropEditorState = {
  fieldName: string;
  sourceType: "upload" | "photobank";
  imageUrl: string;
  imageNaturalWidth: number;
  imageNaturalHeight: number;
  frameWidth: number;
  frameHeight: number;
  photoBox: PhotoBox;
  previewUrl: string | null;
  crop: { x: number; y: number };
  zoom: number;
  cropNorm: CropNorm | null;
} | null;

type CropAreaSize = {
  width: number;
  height: number;
};

type ImageRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type ResizeHandleKey = "top-left" | "top-right" | "bottom-right" | "bottom-left";

type ResizeHandleState = {
  pointerId: number;
  handle: ResizeHandleKey;
  startPointer: {
    x: number;
    y: number;
  };
  startZoom: number;
  startCrop: {
    x: number;
    y: number;
  };
  startImgRect: ImageRect;
  startDisplaySize: {
    width: number;
    height: number;
  };
};

type CropMediaSize = {
  width: number;
  height: number;
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
    return asUiError("E_UPLOAD_TOO_LARGE", "Файл слишком большой. Максимум 30MB");
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

function getEditorViewportState(width: number, height: number): EditorViewportState {
  const safeWidth = width > 0 ? width : EDITOR_REFERENCE.width;
  const safeHeight = height > 0 ? height : EDITOR_REFERENCE.height;
  const scaleX = safeWidth / EDITOR_REFERENCE.width;
  const scaleY = safeHeight / EDITOR_REFERENCE.height;
  return {
    width: safeWidth,
    height: safeHeight,
    scaleX,
    scaleY,
    scale: Math.min(scaleX, scaleY),
    isMobile: safeWidth < EDITOR_REFERENCE.mobileBreakpoint
  };
}

function getDisplayFieldLabel(field: Pick<SchemaField, "key" | "label">): string {
  const key = field.key.trim().toLowerCase();

  if (key === "text" || key === "text_title") return "Заголовок";
  if (key === "text_subtitle") return "Подзаголовок";
  if (key === "text_post") return "Должность";
  if (key === "text_name") return "Фамилия Имя";
  if (key === "text_quote") return "Цитата";
  if (key === "photo") return "Фото";

  const photoMatch = key.match(/^photo_(\d+)$/);
  if (photoMatch) {
    return `Фото ${photoMatch[1]}`;
  }

  return field.label;
}

function isMultilineTextField(field: SchemaField): boolean {
  const key = field.key.toLowerCase();
  const label = getDisplayFieldLabel(field).toLowerCase();
  return field.key === RICH_TEXT_FIELD_KEY || key.includes("quote") || label.includes("цитат");
}

function getEditorActionTone(isActive: boolean): EditorActionTone {
  return isActive ? "primary" : "soft";
}

function TextSizeControl({
  fieldLabel,
  value,
  disabled,
  onChange
}: {
  fieldLabel: string;
  value: TextSizeAdjustValue;
  disabled?: boolean;
  onChange: (next: TextSizeAdjustValue) => void;
}) {
  return (
    <div className="editor-size-control" role="radiogroup" aria-label={`Размер текста ${fieldLabel}`}>
      <span className="editor-size-control__line" aria-hidden="true" />
      {([-1, 0, 1] as const).map((option) => {
        const isActive = option === value;
        const label = option === -1 ? "Уменьшить на 10pt" : option === 1 ? "Увеличить на 10pt" : "Размер из шаблона";
        return (
          <button
            key={`${fieldLabel}:${option}`}
            type="button"
            className={`editor-size-control__button${isActive ? " is-active" : ""}`}
            aria-label={`${fieldLabel}: ${label}`}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onChange(option)}
          >
            <AppIcon
              name={option === 0 ? "letterCase" : option === -1 ? "minus" : "plus"}
              tone={isActive ? "white" : "red"}
              size={20}
            />
          </button>
        );
      })}
    </div>
  );
}

function TextColorControl({
  disabled,
  onSelectColor
}: {
  disabled?: boolean;
  onSelectColor: (color: (typeof RICH_TEXT_COLORS)[number]) => void;
}) {
  return (
    <div className="editor-color-control" role="group" aria-label="Цвет текста">
      {RICH_TEXT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className="editor-color-control__swatch"
          style={{ backgroundColor: color }}
          aria-label={`Выбрать цвет ${color}`}
          disabled={disabled}
          onClick={() => onSelectColor(color)}
        />
      ))}
    </div>
  );
}

function PhotoSelectCard({
  label,
  icon,
  previewSrc,
  iconSize,
  disabled,
  onClick
}: {
  label: string;
  icon: IconName;
  previewSrc?: string;
  iconSize: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`editor-photo-card${previewSrc ? " is-filled" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="editor-photo-card__box">
        {previewSrc ? (
          <>
            <img src={previewSrc} alt="" className="editor-photo-card__preview" />
            <span className="editor-photo-card__preview-icon" aria-hidden="true">
              <AppIcon name={icon} tone="red" size={iconSize} />
            </span>
          </>
        ) : (
          <AppIcon name={icon} tone="red" size={iconSize} />
        )}
      </span>
      <span className="editor-photo-card__caption">{label}</span>
    </button>
  );
}

function EditorActionButton({
  label,
  icon,
  tone,
  iconSize,
  disabled,
  onClick
}: {
  label: string;
  icon: IconName;
  tone: EditorActionTone;
  iconSize: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`editor-action-button editor-action-button--${tone}`}
      disabled={disabled}
      onClick={onClick}
    >
      <AppIcon name={icon} tone={tone === "primary" ? "white" : "red"} size={iconSize} />
      <span className="editor-action-button__label">{label}</span>
    </button>
  );
}

function EditorWarningModal({
  error,
  iconSizes,
  onClose
}: {
  error: UiError;
  iconSizes: EditorIconSizes;
  onClose: () => void;
}) {
  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-labelledby="editor-warning-title">
      <div className="editor-warning-modal">
        <button type="button" className="editor-warning-modal__close" aria-label="Закрыть предупреждение" onClick={onClose}>
          <AppIcon name="close" tone="red" size={iconSizes.close} />
        </button>
        <div className="editor-warning-modal__header">
          <AppIcon name="warning" tone="red" size={iconSizes.warning} />
          <h2 className="editor-warning-modal__title" id="editor-warning-title">
            Предупреждение
          </h2>
        </div>
        <p className="editor-warning-modal__message">{error.message}</p>
        <p className="editor-warning-modal__code">Код ошибки: {error.code}</p>
      </div>
    </div>
  );
}

async function measureImageSize(url: string): Promise<{ width: number; height: number }> {
  return await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!Number.isFinite(image.naturalWidth) || !Number.isFinite(image.naturalHeight) || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error("E_CROP_IMAGE_INVALID_SIZE"));
        return;
      }
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight
      });
    };
    image.onerror = () => reject(new Error("E_CROP_IMAGE_LOAD_FAILED"));
    image.src = url;
  });
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
  const [richTextSegments, setRichTextSegments] = useState<Record<string, TextSegment[]>>({});
  const [textDefaultColors, setTextDefaultColors] = useState<Record<string, string>>({});
  const [photoSelections, setPhotoSelections] = useState<Record<string, PhotoSelection | null>>({});
  const [textSizeAdjust, setTextSizeAdjust] = useState<Record<string, TextSizeAdjustValue>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultLoaded, setResultLoaded] = useState(false);
  const [editorViewport, setEditorViewport] = useState<EditorViewportState>(() =>
    getEditorViewportState(EDITOR_REFERENCE.width, EDITOR_REFERENCE.height)
  );

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
  const [cropEditor, setCropEditor] = useState<CropEditorState>(null);
  const [cropAreaSize, setCropAreaSize] = useState<CropAreaSize>({ width: 0, height: 0 });
  const [cropMediaSize, setCropMediaSize] = useState<CropMediaSize | null>(null);

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const richTextFieldRef = useRef<RichColorTextFieldHandle | null>(null);
  const cropObjectUrlRef = useRef<string | null>(null);
  const cropPreviewWrapRef = useRef<HTMLDivElement | null>(null);
  const cropAreaRef = useRef<HTMLDivElement | null>(null);
  const cropperContainerRef = useRef<HTMLDivElement | null>(null);
  const resizeHandleStateRef = useRef<ResizeHandleState | null>(null);

  const closeCropEditor = useCallback(() => {
    if (cropObjectUrlRef.current) {
      URL.revokeObjectURL(cropObjectUrlRef.current);
      cropObjectUrlRef.current = null;
    }
    setCropMediaSize(null);
    setCropEditor(null);
  }, []);

  const textFields = useMemo(() => schemaFields.filter((field) => field.type === "text"), [schemaFields]);
  const imageFields = useMemo(() => schemaFields.filter((field) => field.type === "image"), [schemaFields]);
  const displayFieldLabels = useMemo(
    () =>
      Object.fromEntries(
        schemaFields.map((field) => [field.key, getDisplayFieldLabel(field)])
      ) as Record<string, string>,
    [schemaFields]
  );
  const richTextDefaultColor = useMemo(
    () => normalizeHexColor(textDefaultColors[RICH_TEXT_FIELD_KEY], "#000000"),
    [textDefaultColors]
  );
  const richTextFieldSegments = useMemo(() => {
    const fromState = richTextSegments[RICH_TEXT_FIELD_KEY];
    if (Array.isArray(fromState)) {
      const normalized = normalizeSegments(fromState, richTextDefaultColor);
      if (getPlainTextFromSegments(normalized).length > 0) {
        return normalized;
      }
      return [{ text: "", color: normalizeHexColor(fromState[0]?.color, richTextDefaultColor) }];
    }
    const fallbackText = fields[RICH_TEXT_FIELD_KEY] ?? "";
    if (!fallbackText) return [{ text: "", color: richTextDefaultColor }];
    return normalizeSegments([{ text: fallbackText, color: richTextDefaultColor }], richTextDefaultColor);
  }, [fields, richTextDefaultColor, richTextSegments]);
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

  useEffect(() => {
    const syncViewport = () => {
      setEditorViewport(getEditorViewportState(window.innerWidth, window.innerHeight));
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  useEffect(() => {
    setPreviewLoaded(!previewUrl);
  }, [previewUrl]);

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

      const hasRichTextField = payload.fields.some(
        (field) => field.type === "text" && field.key === RICH_TEXT_FIELD_KEY
      );
      const textDefaultsRaw =
        payload.textDefaults &&
        typeof payload.textDefaults === "object" &&
        !Array.isArray(payload.textDefaults)
          ? payload.textDefaults
          : {};

      if (hasRichTextField) {
        const richDefaults =
          textDefaultsRaw[RICH_TEXT_FIELD_KEY] && typeof textDefaultsRaw[RICH_TEXT_FIELD_KEY] === "object"
            ? textDefaultsRaw[RICH_TEXT_FIELD_KEY]
            : {};
        const defaultColor = normalizeHexColor(richDefaults.defaultColor, "#000000");
        const defaultText = typeof richDefaults.defaultText === "string" ? richDefaults.defaultText : "";
        const normalized = normalizeSegments([{ text: defaultText, color: defaultColor }], defaultColor);

        setTextDefaultColors({
          [RICH_TEXT_FIELD_KEY]: defaultColor
        });
        setRichTextSegments({
          [RICH_TEXT_FIELD_KEY]: normalized
        });
        setFields((prev) => ({
          ...prev,
          [RICH_TEXT_FIELD_KEY]: defaultText
        }));
      } else {
        setTextDefaultColors({});
        setRichTextSegments({});
      }

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
    setRichTextSegments({});
    setTextDefaultColors({});
    setPhotoSelections({});
    setPhotoEdits({});
    setSchemaFrame(null);
    setSchemaPhotoFields([]);
    setTextSizeAdjust({});
    setPhotobankOpen(false);
    setActivePhotoField(null);
    setCurrentFolderName(null);
    setFolderNameByPath({});
    closeCropEditor();
  }, [closeCropEditor, decodedId]);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  const isSchemaComplete = useMemo(() => {
    if (loadingSchema) return false;
    const allTextFilled = textFields.every((field) => (fields[field.key] ?? "").trim().length > 0);
    const allImagesSelected = imageFields.every((field) => Boolean(photoSelections[field.key]));
    return allTextFilled && allImagesSelected;
  }, [fields, imageFields, loadingSchema, photoSelections, textFields]);
  const canGenerate = useMemo(() => isSchemaComplete && !isGenerating, [isGenerating, isSchemaComplete]);

  const handleRichTextSegmentsChange = useCallback(
    (nextSegments: TextSegment[]) => {
      const normalized = normalizeSegments(nextSegments, richTextDefaultColor);
      const plainText = getPlainTextFromSegments(normalized);
      const normalizedForState =
        plainText.length > 0
          ? normalized
          : [{ text: "", color: normalizeHexColor(nextSegments[0]?.color, richTextDefaultColor) }];
      setRichTextSegments((prev) => ({
        ...prev,
        [RICH_TEXT_FIELD_KEY]: normalizedForState
      }));
      setFields((prev) => ({
        ...prev,
        [RICH_TEXT_FIELD_KEY]: plainText
      }));
    },
    [richTextDefaultColor]
  );

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

  const getPhotoFieldGeometry = useCallback(
    (fieldName: string) => schemaPhotoFields.find((item) => item.name.toLowerCase() === fieldName.toLowerCase()) ?? null,
    [schemaPhotoFields]
  );

  const openCropEditor = useCallback(
    async (fieldName: string) => {
      const selection = photoSelections[fieldName];
      if (!selection) {
        const friendly = asUiError("E_CROP_REQUIRED", "Сначала выберите фото для обрезки");
        setError(friendly);
        setStatus(friendly.message);
        return;
      }
      if (!schemaFrame) {
        const friendly = asUiError("E_SCHEMA_FRAME_MISSING", "В шаблоне отсутствует frame для обрезки");
        setError(friendly);
        setStatus(friendly.message);
        return;
      }

      const geometry = getPhotoFieldGeometry(fieldName);
      if (!geometry) {
        const friendly = asUiError("E_PHOTO_GEOMETRY_MISSING", `В этом шаблоне нет слоя ${fieldName}`);
        setError(friendly);
        setStatus(friendly.message);
        return;
      }

      if (cropObjectUrlRef.current) {
        URL.revokeObjectURL(cropObjectUrlRef.current);
        cropObjectUrlRef.current = null;
      }

      let imageUrl = "";
      let sourceType: "upload" | "photobank" = "photobank";
      if (selection.source === "local") {
        sourceType = "upload";
        imageUrl = URL.createObjectURL(selection.file);
        cropObjectUrlRef.current = imageUrl;
      } else {
        sourceType = "photobank";
        imageUrl = selection.previewUrl;
      }

      try {
        const { width: imageNaturalWidth, height: imageNaturalHeight } = await measureImageSize(imageUrl);
        // react-easy-crop uses zoom as a multiplier of already-fitted media.
        const initialZoom = 1;
        const existingCrop = photoEdits[fieldName]?.cropNorm ?? null;

        setCropEditor({
          fieldName,
          sourceType,
          imageUrl,
          imageNaturalWidth,
          imageNaturalHeight,
          frameWidth: schemaFrame.width,
          frameHeight: schemaFrame.height,
          photoBox: geometry.box,
          previewUrl,
          crop: { x: 0, y: 0 },
          zoom: initialZoom,
          cropNorm: existingCrop
        });
        setCropMediaSize(null);
        setError(null);
        setStatus("");
      } catch (err) {
        if (cropObjectUrlRef.current && cropObjectUrlRef.current === imageUrl) {
          URL.revokeObjectURL(cropObjectUrlRef.current);
          cropObjectUrlRef.current = null;
        }
        const message = err instanceof Error ? err.message : "E_CROP_IMAGE_LOAD_FAILED";
        const friendly = asUiError(message, "Не удалось подготовить изображение для обрезки");
        setError(friendly);
        setStatus(friendly.message);
      }
    },
    [getPhotoFieldGeometry, photoEdits, photoSelections, previewUrl, schemaFrame]
  );

  const confirmCropEditor = useCallback(() => {
    if (!cropEditor || !cropEditor.cropNorm) {
      const friendly = asUiError("E_CROP_REQUIRED", "Не удалось сохранить обрезку. Попробуйте еще раз");
      setError(friendly);
      setStatus(friendly.message);
      return;
    }
    const nextCropNorm = cropEditor.cropNorm;
    setPhotoEdits((prev) => ({
      ...prev,
      [cropEditor.fieldName]: {
        cropNorm: nextCropNorm
      }
    }));
    closeCropEditor();
  }, [closeCropEditor, cropEditor]);

  const cancelCropEditor = useCallback(() => {
    closeCropEditor();
  }, [closeCropEditor]);

  useEffect(
    () => () => {
      if (cropObjectUrlRef.current) {
        URL.revokeObjectURL(cropObjectUrlRef.current);
        cropObjectUrlRef.current = null;
      }
    },
    []
  );

  function validateBeforeGenerate(): UiError | null {
    for (const field of textFields) {
      const value = fields[field.key]?.trim() ?? "";
      if (!value) {
        return asUiError(`E_TEXT_REQUIRED_${field.key}`, `Заполните поле "${displayFieldLabels[field.key] ?? field.label}"`);
      }
    }

    for (const field of imageFields) {
      const selection = photoSelections[field.key];
      if (!selection) {
        return asUiError(
          `E_PHOTO_REQUIRED_${field.key}`,
          `Выберите фото для поля "${displayFieldLabels[field.key] ?? field.label}"`
        );
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
      const richTextPayload: Record<string, TextSegment[]> = {};
      if (getPlainTextFromSegments(richTextFieldSegments).length > 0) {
        richTextPayload[RICH_TEXT_FIELD_KEY] = normalizeSegments(richTextFieldSegments, richTextDefaultColor);
      }

      const formData = new FormData();
      formData.append("templateId", decodedId);
      formData.append("fields", JSON.stringify(textPayload));
      formData.append("textSizeAdjust", JSON.stringify(textSizeAdjust));
      formData.append("richText", JSON.stringify(richTextPayload));

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
  const showResultView = Boolean(cropEditor === null && resultUrl);
  const editorScale = editorViewport.isMobile ? 1 : editorViewport.scale;
  const editorRootStyle = useMemo(
    () =>
      ({
        "--editor-scale": String(editorScale)
      }) as CSSProperties,
    [editorScale]
  );
  const iconSizes = useMemo<EditorIconSizes>(() => {
    if (editorViewport.isMobile) {
      return {
        actionCard: 30,
        actionButton: 32,
        refresh: 20,
        warning: 48,
        close: 32
      };
    }

    return {
      actionCard: 40 * editorScale,
      actionButton: 40 * editorScale,
      refresh: 24 * editorScale,
      warning: 64 * editorScale,
      close: 40 * editorScale
    };
  }, [editorScale, editorViewport.isMobile]);
  const showPreviewLoader =
    !cropEditor &&
    (isGenerating || (showResultView ? !resultLoaded : Boolean(previewUrl) && !previewLoaded));
  const showCropLoader = Boolean(cropEditor) && !cropMediaSize;
  const createButtonTone = getEditorActionTone(canGenerate);
  const downloadButtonTone = getEditorActionTone(Boolean(resultUrl) && resultLoaded && !isGenerating);
  const cropBoxStyle = useMemo(() => {
    if (!cropEditor) return undefined;
    return {
      left: `${(cropEditor.photoBox.x / cropEditor.frameWidth) * 100}%`,
      top: `${(cropEditor.photoBox.y / cropEditor.frameHeight) * 100}%`,
      width: `${(cropEditor.photoBox.width / cropEditor.frameWidth) * 100}%`,
      height: `${(cropEditor.photoBox.height / cropEditor.frameHeight) * 100}%`
    };
  }, [cropEditor]);
  const imageRect = useMemo<ImageRect | null>(() => {
    if (!cropEditor || !cropMediaSize) return null;
    if (cropAreaSize.width <= 0 || cropAreaSize.height <= 0) return null;
    const imgW = cropMediaSize.width * cropEditor.zoom;
    const imgH = cropMediaSize.height * cropEditor.zoom;
    const centerX = cropAreaSize.width / 2 + cropEditor.crop.x;
    const centerY = cropAreaSize.height / 2 + cropEditor.crop.y;
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
  }, [cropAreaSize.height, cropAreaSize.width, cropEditor, cropMediaSize]);
  const resizeHandles = useMemo(() => {
    if (!imageRect) return [];
    return [
      { key: "top-left" as const, x: imageRect.left, y: imageRect.top, cursor: "nwse-resize" },
      { key: "top-right" as const, x: imageRect.right, y: imageRect.top, cursor: "nesw-resize" },
      { key: "bottom-right" as const, x: imageRect.right, y: imageRect.bottom, cursor: "nwse-resize" },
      { key: "bottom-left" as const, x: imageRect.left, y: imageRect.bottom, cursor: "nesw-resize" }
    ];
  }, [imageRect]);

  useEffect(() => {
    if (!cropEditor || !cropAreaRef.current) {
      setCropAreaSize({ width: 0, height: 0 });
      return;
    }
    const node = cropAreaRef.current;
    const measure = () => {
      setCropAreaSize({
        width: node.clientWidth,
        height: node.clientHeight
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [cropEditor]);

  const onResizeHandlePointerMove = useCallback((event: PointerEvent) => {
    const state = resizeHandleStateRef.current;
    const node = cropperContainerRef.current;
    if (!state || !node) return;
    if (event.pointerId !== state.pointerId) return;
    const areaRect = node.getBoundingClientRect();
    const pointerX = event.clientX - areaRect.left;
    const pointerY = event.clientY - areaRect.top;
    const deltaX = pointerX - state.startPointer.x;
    const deltaY = pointerY - state.startPointer.y;

    let movedX = 0;
    let movedY = 0;
    let anchorX = 0;
    let anchorY = 0;
    if (state.handle === "top-left") {
      movedX = state.startImgRect.left + deltaX;
      movedY = state.startImgRect.top + deltaY;
      anchorX = state.startImgRect.right;
      anchorY = state.startImgRect.bottom;
    } else if (state.handle === "top-right") {
      movedX = state.startImgRect.right + deltaX;
      movedY = state.startImgRect.top + deltaY;
      anchorX = state.startImgRect.left;
      anchorY = state.startImgRect.bottom;
    } else if (state.handle === "bottom-right") {
      movedX = state.startImgRect.right + deltaX;
      movedY = state.startImgRect.bottom + deltaY;
      anchorX = state.startImgRect.left;
      anchorY = state.startImgRect.top;
    } else {
      movedX = state.startImgRect.left + deltaX;
      movedY = state.startImgRect.bottom + deltaY;
      anchorX = state.startImgRect.right;
      anchorY = state.startImgRect.top;
    }

    const widthFromPointer = Math.max(1, Math.abs(movedX - anchorX));
    const heightFromPointer = Math.max(1, Math.abs(movedY - anchorY));
    const zoomFromWidth = (widthFromPointer / state.startImgRect.width) * state.startZoom;
    const zoomFromHeight = (heightFromPointer / state.startImgRect.height) * state.startZoom;
    let nextZoom = Math.max(zoomFromWidth, zoomFromHeight);
    if (!Number.isFinite(nextZoom)) return;
    nextZoom = Math.max(0.1, Math.min(8, nextZoom));
    const nextW = state.startDisplaySize.width * nextZoom;
    const nextH = state.startDisplaySize.height * nextZoom;
    if (!Number.isFinite(nextW) || !Number.isFinite(nextH)) return;

    let nextLeft = 0;
    let nextTop = 0;
    if (state.handle === "top-left") {
      nextLeft = anchorX - nextW;
      nextTop = anchorY - nextH;
    } else if (state.handle === "top-right") {
      nextLeft = anchorX;
      nextTop = anchorY - nextH;
    } else if (state.handle === "bottom-right") {
      nextLeft = anchorX;
      nextTop = anchorY;
    } else {
      nextLeft = anchorX - nextW;
      nextTop = anchorY;
    }

    const startCenterX = state.startImgRect.left + state.startImgRect.width / 2;
    const startCenterY = state.startImgRect.top + state.startImgRect.height / 2;
    const nextCenterX = nextLeft + nextW / 2;
    const nextCenterY = nextTop + nextH / 2;
    const nextCropX = state.startCrop.x + (nextCenterX - startCenterX);
    const nextCropY = state.startCrop.y + (nextCenterY - startCenterY);
    if (!Number.isFinite(nextCropX) || !Number.isFinite(nextCropY)) return;
    if (process.env.NEXT_PUBLIC_DEBUG_UI === "1" || process.env.DEBUG_UI === "1") {
      console.debug("resize move", {
        handle: state.handle,
        startZoom: state.startZoom,
        newZoom: nextZoom,
        startImgRect: state.startImgRect,
        pointerX,
        pointerY
      });
    }
    setCropEditor((prev) =>
      prev
        ? {
            ...prev,
            zoom: nextZoom,
            crop: {
              x: nextCropX,
              y: nextCropY
            }
          }
        : prev
    );
  }, []);

  const onResizeHandlePointerUp = useCallback(
    (event: PointerEvent) => {
      const state = resizeHandleStateRef.current;
      if (!state) return;
      if (event.pointerId !== state.pointerId) return;
      const node = cropperContainerRef.current;
      if (node && node.hasPointerCapture(state.pointerId)) {
        node.releasePointerCapture(state.pointerId);
      }
      resizeHandleStateRef.current = null;
      window.removeEventListener("pointermove", onResizeHandlePointerMove);
      window.removeEventListener("pointerup", onResizeHandlePointerUp);
      window.removeEventListener("pointercancel", onResizeHandlePointerUp);
    },
    [onResizeHandlePointerMove]
  );

  const onResizeHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!imageRect || !cropEditor || !cropMediaSize) return;
      const handle = event.currentTarget.dataset.handle as ResizeHandleKey | undefined;
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      const node = cropperContainerRef.current;
      if (!node) return;
      if (cropMediaSize.width <= 0 || cropMediaSize.height <= 0) return;
      const areaRect = node.getBoundingClientRect();
      const startPointerX = event.clientX - areaRect.left;
      const startPointerY = event.clientY - areaRect.top;
      if (!Number.isFinite(startPointerX) || !Number.isFinite(startPointerY)) return;

      resizeHandleStateRef.current = {
        pointerId: event.pointerId,
        handle,
        startPointer: {
          x: startPointerX,
          y: startPointerY
        },
        startZoom: cropEditor.zoom,
        startCrop: {
          x: cropEditor.crop.x,
          y: cropEditor.crop.y
        },
        startImgRect: { ...imageRect },
        startDisplaySize: {
          width: cropMediaSize.width,
          height: cropMediaSize.height
        }
      };

      node.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", onResizeHandlePointerMove);
      window.addEventListener("pointerup", onResizeHandlePointerUp);
      window.addEventListener("pointercancel", onResizeHandlePointerUp);
    },
    [cropEditor, cropMediaSize, imageRect, onResizeHandlePointerMove, onResizeHandlePointerUp]
  );

  useEffect(
    () => () => {
      const state = resizeHandleStateRef.current;
      const node = cropperContainerRef.current;
      if (state && node && node.hasPointerCapture(state.pointerId)) {
        node.releasePointerCapture(state.pointerId);
      }
      resizeHandleStateRef.current = null;
      window.removeEventListener("pointermove", onResizeHandlePointerMove);
      window.removeEventListener("pointerup", onResizeHandlePointerUp);
      window.removeEventListener("pointercancel", onResizeHandlePointerUp);
    },
    [onResizeHandlePointerMove, onResizeHandlePointerUp]
  );

  return (
    <main
      className={`screen-page screen-page--editor${editorViewport.isMobile ? " is-mobile" : ""}`}
      style={editorRootStyle}
    >
      <h1 className="visually-hidden">{templateName}</h1>
      <div className="screen-card screen-card--editor">
        <section className="editor-form">
          <div className="editor-form__body ui-scroll">
            {schemaFields.map((field) => {
              const displayLabel = displayFieldLabels[field.key] ?? field.label;

              if (field.type === "text") {
                const isRichTextField = field.key === RICH_TEXT_FIELD_KEY;
                const isMultiline = isMultilineTextField(field);
                const sizeValue = textSizeAdjust[field.key] ?? 0;

                return (
                  <section key={field.key} className="editor-block editor-block--text">
                    <h2 className="editor-block__title">{displayLabel}</h2>
                    <div className="editor-text-layout">
                      <div className="editor-text-layout__field">
                        {isRichTextField ? (
                          <RichColorTextField
                            ref={richTextFieldRef}
                            id={field.key}
                            segments={richTextFieldSegments}
                            defaultColor={richTextDefaultColor}
                            disabled={isGenerating}
                            onChangeSegments={handleRichTextSegmentsChange}
                          />
                        ) : (
                          <textarea
                            id={field.key}
                            rows={isMultiline ? 4 : 1}
                            className={`editor-text-input${isMultiline ? " is-multiline" : " is-single-line"}`}
                            value={fields[field.key] ?? ""}
                            disabled={isGenerating}
                            onChange={(event) =>
                              setFields((prev) => ({
                                ...prev,
                                [field.key]: event.target.value
                              }))
                            }
                          />
                        )}
                      </div>

                      <div className="editor-text-controls" aria-label={`Панель управления ${displayLabel}`}>
                        <TextSizeControl
                          fieldLabel={displayLabel}
                          value={sizeValue}
                          disabled={isGenerating}
                          onChange={(next) =>
                            setTextSizeAdjust((prev) => ({
                              ...prev,
                              [field.key]: next
                            }))
                          }
                        />
                        {isRichTextField ? (
                          <TextColorControl
                            disabled={isGenerating}
                            onSelectColor={(color) => {
                              richTextFieldRef.current?.applyColorToSelection(color);
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  </section>
                );
              }

              const selection = photoSelections[field.key] ?? null;
              const localPreview = localPreviewUrls[field.key];
              const uploadPreview = selection && selection.source === "local" ? localPreview : undefined;
              const photobankPreview = selection && selection.source === "photobank" ? selection.previewUrl : undefined;
              const hasPhoto = Boolean(selection);

              return (
                <section key={field.key} className="editor-block editor-block--photo">
                  <div className="editor-photo-header">
                    <h2 className="editor-block__title">{displayLabel}</h2>
                    <button
                      type="button"
                      className="editor-photo-refresh"
                      aria-label={`Сбросить ${displayLabel}`}
                      onClick={() => {
                        setPhotoSelections((prev) => ({
                          ...prev,
                          [field.key]: null
                        }));
                        setPhotoEdits((prev) => {
                          const next = { ...prev };
                          delete next[field.key];
                          return next;
                        });
                        closeCropEditor();
                        setStatus("");
                      }}
                      disabled={isGenerating}
                    >
                      <AppIcon name={EDITOR_ICON_MAP.refresh} tone="red" size={iconSizes.refresh} />
                    </button>
                  </div>

                  <div className="editor-photo-actions">
                    <PhotoSelectCard
                      label="Загрузить"
                      icon={EDITOR_ICON_MAP.upload}
                      previewSrc={uploadPreview}
                      iconSize={iconSizes.actionCard}
                      disabled={isGenerating}
                      onClick={() => fileInputRefs.current[field.key]?.click()}
                    />
                    <PhotoSelectCard
                      label="Фотобанк"
                      icon={EDITOR_ICON_MAP.photobank}
                      previewSrc={photobankPreview}
                      iconSize={iconSizes.actionCard}
                      disabled={isGenerating}
                      onClick={() => void openPhotobankForField(field.key)}
                    />
                    <EditorActionButton
                      label="Обрезать"
                      icon={EDITOR_ICON_MAP.crop}
                      tone={getEditorActionTone(hasPhoto)}
                      iconSize={iconSizes.actionButton}
                      disabled={isGenerating || !hasPhoto}
                      onClick={() => void openCropEditor(field.key)}
                    />
                  </div>

                  <input
                    ref={(node) => {
                      fileInputRefs.current[field.key] = node;
                    }}
                    id={`upload-${field.key}`}
                    className="visually-hidden"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
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
                      closeCropEditor();
                      setStatus("");
                      event.currentTarget.value = "";
                    }}
                  />
                </section>
              );
            })}
          </div>
        </section>

        <aside className="editor-preview">
          <div className="editor-preview__shell">
            {cropEditor ? (
              <div className={`editor-preview-stage editor-preview-stage--crop${showCropLoader ? " is-loading" : ""}`}>
                <div className="editor-preview-stage__canvas">
                  <div className="result-preview-wrap result-preview-wrap--editor">
                    <div className="crop-stage">
                      <div
                        className="crop-preview-wrap"
                        ref={cropPreviewWrapRef}
                        style={{ aspectRatio: `${cropEditor.frameWidth} / ${cropEditor.frameHeight}` }}
                      >
                        {cropEditor.previewUrl ? (
                          <img src={cropEditor.previewUrl} alt="" className="crop-stage-preview" />
                        ) : null}
                        <div
                          className="crop-area-container"
                          style={cropBoxStyle}
                          ref={(node) => {
                            cropAreaRef.current = node;
                            cropperContainerRef.current = node;
                          }}
                        >
                          <div className="cropper-host">
                            <Cropper
                              image={cropEditor.imageUrl}
                              crop={cropEditor.crop}
                              zoom={cropEditor.zoom}
                              aspect={cropEditor.photoBox.width / cropEditor.photoBox.height}
                              cropSize={
                                cropAreaSize.width > 0 && cropAreaSize.height > 0
                                  ? { width: cropAreaSize.width, height: cropAreaSize.height }
                                  : undefined
                              }
                              onCropChange={(nextCrop) =>
                                setCropEditor((prev) => (prev ? { ...prev, crop: nextCrop } : prev))
                              }
                              onZoomChange={(nextZoom) =>
                                setCropEditor((prev) =>
                                  prev ? { ...prev, zoom: Math.max(0.1, Math.min(8, nextZoom)) } : prev
                                )
                              }
                              onMediaLoaded={(media) => {
                                if (!media || !Number.isFinite(media.width) || !Number.isFinite(media.height)) return;
                                setCropMediaSize({
                                  width: media.width,
                                  height: media.height
                                });
                              }}
                              onCropComplete={(_croppedArea: Area, croppedAreaPixels: Area) => {
                                setCropEditor((prev) => {
                                  if (!prev) return prev;
                                  return {
                                    ...prev,
                                    cropNorm: {
                                      x: clamp01(croppedAreaPixels.x / prev.imageNaturalWidth),
                                      y: clamp01(croppedAreaPixels.y / prev.imageNaturalHeight),
                                      w: clamp01(croppedAreaPixels.width / prev.imageNaturalWidth),
                                      h: clamp01(croppedAreaPixels.height / prev.imageNaturalHeight)
                                    }
                                  };
                                });
                              }}
                              objectFit="contain"
                              showGrid={false}
                              zoomWithScroll={false}
                              restrictPosition={false}
                              style={{
                                containerStyle: {
                                  width: "100%",
                                  height: "100%",
                                  position: "absolute",
                                  inset: "0",
                                  overflow: "visible"
                                },
                                cropAreaStyle: {
                                  width: "100%",
                                  height: "100%"
                                }
                              }}
                            />
                          </div>
                          <div className="crop-handles-layer" aria-hidden="true">
                            {resizeHandles.map((handle) => (
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
                                onPointerDown={onResizeHandlePointerDown}
                                aria-label="Изменить масштаб"
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {showCropLoader ? (
                  <div className="editor-preview-stage__loader" role="status" aria-live="polite">
                    <LoadingMark className="editor-preview-stage__mark" />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className={`editor-preview-stage${showPreviewLoader ? " is-loading" : ""}`} aria-busy={showPreviewLoader}>
                <div className="editor-preview-stage__canvas">
                  {showResultView ? (
                    <div className="result-preview-wrap result-preview-wrap--editor result-preview-stack">
                      <img
                        src={resultUrl ?? ""}
                        alt="Готовый макет"
                        className="result-preview-image editor-preview-media"
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
                    </div>
                  ) : previewUrl ? (
                    <div className="result-preview-wrap result-preview-wrap--editor">
                      <img
                        src={previewUrl}
                        alt=""
                        className="result-preview-image editor-preview-media"
                        onLoad={() => setPreviewLoaded(true)}
                        onError={() => {
                          setPreviewLoaded(true);
                          setPreviewUrl(null);
                        }}
                        style={{ opacity: previewLoaded ? 1 : 0 }}
                      />
                    </div>
                  ) : (
                    <div className="editor-preview-empty" aria-hidden="true" />
                  )}
                </div>
                {showPreviewLoader ? (
                  <div className="editor-preview-stage__loader" role="status" aria-live="polite">
                    <LoadingMark className="editor-preview-stage__mark" />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="editor-action-row">
            {cropEditor ? (
              <>
                <EditorActionButton
                  label="Подтвердить"
                  icon={EDITOR_ICON_MAP.confirm}
                  tone="primary"
                  iconSize={iconSizes.actionButton}
                  disabled={!cropEditor.cropNorm}
                  onClick={() => confirmCropEditor()}
                />
                <EditorActionButton
                  label="Отмена"
                  icon={EDITOR_ICON_MAP.cancel}
                  tone="primary"
                  iconSize={iconSizes.actionButton}
                  onClick={() => cancelCropEditor()}
                />
              </>
            ) : (
              <>
                <EditorActionButton
                  label="Создать"
                  icon={EDITOR_ICON_MAP.create}
                  tone={createButtonTone}
                  iconSize={iconSizes.actionButton}
                  disabled={!canGenerate}
                  onClick={() => void handleGenerate()}
                />
                {resultUrl ? (
                  <EditorActionButton
                    label="Скачать"
                    icon={EDITOR_ICON_MAP.download}
                    tone={downloadButtonTone}
                    iconSize={iconSizes.actionButton}
                    disabled={!resultLoaded || isGenerating}
                    onClick={() => window.open(resultUrl, "_blank", "noopener,noreferrer")}
                  />
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>

      {loadingSchema ? (
        <div className="editor-overlay" role="status" aria-live="polite" aria-label="Загрузка страницы шаблона">
          <div className="loading-card">
            <LoadingMark />
          </div>
        </div>
      ) : null}

      {error ? <EditorWarningModal error={error} iconSizes={iconSizes} onClose={() => setError(null)} /> : null}

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
                    closeCropEditor();
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
