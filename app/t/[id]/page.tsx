"use client";

import { FormEvent, use, useEffect, useMemo, useState } from "react";

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

type UploadResponse = {
  objectKey: string;
  signedGetUrl: string;
};

type GenerateResponse = {
  resultKey: string;
  signedGetUrl: string;
  renderMode?: "universal" | "legacy" | "figma" | "test";
  debug?: unknown;
};

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
  const [uploadedImageUrls, setUploadedImageUrls] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("Loading schema...");
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [resultKey, setResultKey] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [debugText, setDebugText] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadSchema() {
      setLoadingSchema(true);
      setStatus("Loading schema...");
      try {
        const response = await fetch(`/api/templates/${encodeURIComponent(decodedId)}/schema`, {
          cache: "no-store"
        });
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | SchemaResponse
          | null;

        if (!response.ok) {
          throw new Error(
            payload && typeof payload === "object" && "error" in payload && payload.error
              ? payload.error
              : `Schema request failed: ${response.status}`
          );
        }

        if (!payload || typeof payload !== "object" || !("fields" in payload) || !Array.isArray(payload.fields)) {
          throw new Error("Schema response has invalid format");
        }

        if (cancelled) return;

        setTemplateName(payload.templateName || decodedId);
        setSchemaFields(payload.fields);
        setStatus(payload.fields.length > 0 ? "" : "Template has no editable fields");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load schema";
        if (!cancelled) {
          setStatus(message);
        }
      } finally {
        if (!cancelled) {
          setLoadingSchema(false);
        }
      }
    }

    void loadSchema();

    return () => {
      cancelled = true;
    };
  }, [decodedId]);

  const canGenerate = useMemo(() => {
    if (generating || loadingSchema) return false;
    return true;
  }, [generating, loadingSchema]);

  async function handleUpload(fieldKey: string, event: FormEvent) {
    event.preventDefault();
    const file = selectedFiles[fieldKey];
    if (!file) {
      setStatus(`Select a file for ${fieldKey}`);
      return;
    }

    setUploadingField(fieldKey);
    setStatus(`Uploading ${fieldKey}...`);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | UploadResponse
        | null;

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && payload.error
            ? payload.error
            : `Upload failed: ${response.status}`
        );
      }

      if (!payload || typeof payload !== "object" || !("objectKey" in payload)) {
        throw new Error("Upload response has invalid format");
      }

      setFields((prev) => ({ ...prev, [fieldKey]: payload.objectKey }));
      setUploadedImageUrls((prev) => ({ ...prev, [fieldKey]: payload.signedGetUrl }));
      setStatus(`Uploaded ${fieldKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setStatus(message);
    } finally {
      setUploadingField(null);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setDebugText("");
    setStatus("Generating...");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: decodedId,
          fields
        })
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | GenerateResponse
        | null;

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && payload.error
            ? payload.error
            : `Generate failed: ${response.status}`
        );
      }

      if (!payload || typeof payload !== "object" || !("resultKey" in payload)) {
        throw new Error("Generate response has invalid format");
      }

      setResultKey(payload.resultKey);
      setResultUrl(payload.signedGetUrl);
      if (payload.debug) {
        setDebugText(JSON.stringify(payload.debug, null, 2));
      }
      setStatus(`Done (${payload.renderMode ?? "unknown"})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Generate failed";
      setStatus(message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Template: {templateName}</h1>
        <p className="muted">
          ID: <code>{decodedId}</code>
        </p>

        {status ? <p className="muted">{status}</p> : null}
        {!loadingSchema && schemaFields.length === 0 ? (
          <p className="muted">0 editable fields for this template</p>
        ) : null}

        {schemaFields.map((field) => {
          if (field.type === "text") {
            return (
              <div key={field.key} className="field-block">
                <label htmlFor={field.key}>{field.label}</label>
                <textarea
                  id={field.key}
                  rows={4}
                  value={fields[field.key] ?? ""}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [field.key]: e.target.value
                    }))
                  }
                />
              </div>
            );
          }

          return (
            <form key={field.key} className="field-block" onSubmit={(e) => void handleUpload(field.key, e)}>
              <label htmlFor={field.key}>{field.label}</label>
              <input
                id={field.key}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) =>
                  setSelectedFiles((prev) => ({
                    ...prev,
                    [field.key]: e.target.files?.[0] ?? null
                  }))
                }
              />
              <div className="row">
                <button type="submit" disabled={uploadingField === field.key}>
                  {uploadingField === field.key ? "Uploading..." : "Upload"}
                </button>
                {fields[field.key] ? <code>{fields[field.key]}</code> : null}
              </div>
              {uploadedImageUrls[field.key] ? (
                <a href={uploadedImageUrls[field.key]} target="_blank" rel="noreferrer">
                  Open uploaded image
                </a>
              ) : null}
            </form>
          );
        })}

        <div className="row">
          <button type="button" onClick={handleGenerate} disabled={!canGenerate}>
            {generating ? "Generating..." : "Generate"}
          </button>
        </div>

        {resultKey ? (
          <div className="field-block">
            <p>
              Render: <code>{resultKey}</code>{" "}
              <a href={resultUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </p>
            <img src={resultUrl} alt="Render result" style={{ maxWidth: "100%", borderRadius: 12 }} />
          </div>
        ) : null}

        {debugText ? (
          <div className="field-block">
            <p>Debug</p>
            <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap", fontSize: 12 }}>{debugText}</pre>
          </div>
        ) : null}
      </div>
    </main>
  );
}
