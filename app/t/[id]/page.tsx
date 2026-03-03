"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";

type SchemaField = {
  key: string;
  type: "text" | "image";
  label: string;
};

type SchemaResponse = {
  templateId: string;
  templateName: string;
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

export default function TemplateEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawTemplateId } = use(params);
  const decodedId = decodeURIComponent(rawTemplateId);

  const [templateName, setTemplateName] = useState(decodedId);
  const [schemaFields, setSchemaFields] = useState<SchemaField[]>([]);
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

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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
    setTextSizeAdjust({});
    setPhotobankOpen(false);
    setActivePhotoField(null);
    setCurrentFolderName(null);
    setFolderNameByPath({});
  }, [decodedId]);

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
                {selection ? (
                  <button
                    type="button"
                    onClick={() =>
                      setPhotoSelections((prev) => ({
                        ...prev,
                        [field.key]: null
                      }))
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
