"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";

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

type UploadBatchResponse = {
  ok: true;
  objectKeys: Record<string, string>;
};

type GenerateResponse = {
  resultKey: string;
  signedGetUrl: string;
};

type UiError = {
  code: string;
  message: string;
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

function toUploadError(payload: unknown, fallbackStatus: number): UiError {
  const parsed = parseApiError(payload);
  if (parsed.code === "E_UPLOAD_TOO_LARGE") {
    return asUiError("E_UPLOAD_TOO_LARGE", "Файл слишком большой. Максимум 15MB");
  }
  if (parsed.code === "E_UPLOAD_TYPE") {
    return asUiError("E_UPLOAD_TYPE", "Неподдерживаемый формат файла. Разрешены JPEG, PNG, WEBP");
  }
  if (fallbackStatus >= 500) {
    return asUiError("E_UPLOAD_FAILED", "Ошибка загрузки файла. Повторите попытку");
  }
  return parsed.code ? parsed : asUiError("E_UPLOAD_FAILED", "Ошибка загрузки файла");
}

function toGenerateError(payload: unknown): UiError {
  const parsed = parseApiError(payload);
  if (parsed.code && parsed.code.startsWith("E_TEXT_REQUIRED_")) {
    return parsed;
  }
  if (parsed.code && parsed.code.startsWith("E_PHOTO_REQUIRED_")) {
    return parsed;
  }
  return asUiError("E_GENERATE_FAILED", "Не удалось создать изображение");
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
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File | null>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [uploadingAll, setUploadingAll] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState("");

  const textFields = useMemo(() => schemaFields.filter((field) => field.type === "text"), [schemaFields]);
  const imageFields = useMemo(() => schemaFields.filter((field) => field.type === "image"), [schemaFields]);

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
      setStatus("");
    } catch (err) {
      const friendly = toSchemaLoadError(err);
      setError(friendly);
      setStatus(`${friendly.message} (${friendly.code})`);
    } finally {
      setLoadingSchema(false);
    }
  }, [decodedId]);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  const canUpload = useMemo(() => {
    if (loadingSchema || uploadingAll || generating) return false;
    return imageFields.some((field) => selectedFiles[field.key] instanceof File);
  }, [generating, imageFields, loadingSchema, selectedFiles, uploadingAll]);

  const canGenerate = useMemo(() => !loadingSchema && !uploadingAll && !generating, [generating, loadingSchema, uploadingAll]);

  async function handleUploadAll() {
    setUploadingAll(true);
    setError(null);
    setStatus("Загрузка файлов...");

    try {
      const formData = new FormData();
      for (const imageField of imageFields) {
        const file = selectedFiles[imageField.key];
        if (file) {
          formData.append(imageField.key, file, file.name);
        }
      }
      if (![...formData.keys()].length) {
        const uiError = asUiError("E_UPLOAD_REQUIRED", "Выберите хотя бы одно фото для загрузки");
        setError(uiError);
        setStatus(`${uiError.message} (${uiError.code})`);
        return;
      }

      const response = await fetch("/api/upload/batch", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json().catch(() => null)) as UploadBatchResponse | { error?: string; code?: string } | null;
      if (!response.ok) {
        const friendly = toUploadError(payload, response.status);
        setError(friendly);
        setStatus(`${friendly.message} (${friendly.code})`);
        return;
      }
      if (!payload || typeof payload !== "object" || !("ok" in payload) || !payload.ok || !("objectKeys" in payload)) {
        throw new Error("Invalid upload response");
      }

      setFields((prev) => ({ ...prev, ...payload.objectKeys }));
      setStatus("Файлы загружены");
    } catch (err) {
      console.error("[upload batch]", err);
      const friendly = asUiError("E_UPLOAD_FAILED", "Ошибка загрузки файлов");
      setError(friendly);
      setStatus(`${friendly.message} (${friendly.code})`);
    } finally {
      setUploadingAll(false);
    }
  }

  function validateBeforeGenerate(): UiError | null {
    for (const field of textFields) {
      const value = fields[field.key]?.trim() ?? "";
      if (!value) return asUiError(`E_TEXT_REQUIRED_${field.key}`, `Заполните поле "${field.label}"`);
    }
    for (const field of imageFields) {
      const value = fields[field.key]?.trim() ?? "";
      if (!value) return asUiError(`E_PHOTO_REQUIRED_${field.key}`, `Загрузите фото для поля "${field.label}"`);
    }
    return null;
  }

  async function handleGenerate() {
    setError(null);
    const validationError = validateBeforeGenerate();
    if (validationError) {
      setError(validationError);
      setStatus(`${validationError.message} (${validationError.code})`);
      return;
    }

    setGenerating(true);
    setStatus("Создание изображения...");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: decodedId,
          fields
        })
      });

      const payload = (await response.json().catch(() => null)) as GenerateResponse | { error?: string; code?: string } | null;
      if (!response.ok) {
        console.error("[generate] api error", payload);
        const friendly = toGenerateError(payload);
        setError(friendly);
        setStatus(`${friendly.message} (${friendly.code})`);
        return;
      }
      if (!payload || typeof payload !== "object" || !("signedGetUrl" in payload) || typeof payload.signedGetUrl !== "string") {
        throw new Error("Generate response has invalid format");
      }

      setResultUrl(payload.signedGetUrl);
      setStatus("Изображение создано");
    } catch (err) {
      console.error("[generate]", err);
      const friendly = asUiError("E_GENERATE_FAILED", "Не удалось создать изображение");
      setError(friendly);
      setStatus(`${friendly.message} (${friendly.code})`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>{templateName}</h1>
        {status ? <p className="muted">{status}</p> : null}

        {error ? (
          <div className="field-block">
            <p className="muted" style={{ color: "#a30000" }}>
              {error.message} ({error.code})
            </p>
          </div>
        ) : null}

        {loadingSchema ? <p className="muted">Загрузка...</p> : null}

        {textFields.map((field) => (
          <div key={field.key} className="field-block">
            <label htmlFor={field.key}>{field.label}</label>
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

        {imageFields.map((field) => (
          <div key={field.key} className="field-block">
            <label htmlFor={field.key}>{field.label}</label>
            <input
              id={field.key}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) =>
                setSelectedFiles((prev) => ({
                  ...prev,
                  [field.key]: event.target.files?.[0] ?? null
                }))
              }
            />
            <p className="muted">
              {fields[field.key]
                ? "Файл загружен"
                : selectedFiles[field.key]
                  ? "Файл выбран, нажмите «Загрузить»"
                  : "Файл не выбран"}
            </p>
          </div>
        ))}

        <div className="row">
          <button type="button" onClick={() => void handleUploadAll()} disabled={!canUpload}>
            {uploadingAll ? "Загрузка..." : "Загрузить"}
          </button>
          <button type="button" onClick={() => void handleGenerate()} disabled={!canGenerate}>
            {generating ? "Создание..." : "Создать изображение"}
          </button>
          {resultUrl ? (
            <button type="button" onClick={() => window.open(resultUrl, "_blank", "noopener,noreferrer")}>
              Скачать макет
            </button>
          ) : null}
        </div>

        {resultUrl ? (
          <div className="field-block">
            <img src={resultUrl} alt="Готовый макет" style={{ maxWidth: "100%", borderRadius: 12 }} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
