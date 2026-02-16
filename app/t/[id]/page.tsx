"use client";

import { FormEvent, use, useState } from "react";

type UploadResponse = {
  objectKey: string;
  signedGetUrl: string;
};

type GenerateResponse = {
  resultKey: string;
  signedGetUrl: string;
};

export default function TemplateEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: templateId } = use(params);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [objectKey, setObjectKey] = useState<string>("");
  const [uploadUrl, setUploadUrl] = useState<string>("");
  const [resultUrl, setResultUrl] = useState<string>("");
  const [resultKey, setResultKey] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const canGenerate = title.trim().length > 0 && objectKey.length > 0 && !generating;

  async function handleUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) {
      setStatus("Выберите файл перед загрузкой");
      return;
    }
    setUploading(true);
    setStatus("Загрузка...");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error ?? `Upload failed: ${response.status}`);
      }
      const data = (await response.json()) as UploadResponse;
      setObjectKey(data.objectKey);
      setUploadUrl(data.signedGetUrl);
      setStatus("Файл загружен");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload error";
      setStatus(message);
    } finally {
      setUploading(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setStatus("Генерация...");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          title,
          objectKey
        })
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error ?? `Generate failed: ${response.status}`);
      }
      const data = (await response.json()) as GenerateResponse;
      setResultUrl(data.signedGetUrl);
      setResultKey(data.resultKey);
      setStatus("Готово");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Generate error";
      setStatus(message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Редактор шаблона: {templateId || "..."}</h1>
        <form onSubmit={handleUpload}>
          <p>
            <label>
              Заголовок
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Введите title"
              />
            </label>
          </p>
          <p>
            <label>
              Фото
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </p>
          <div className="row">
            <button type="submit" disabled={uploading}>
              Upload
            </button>
            <button type="button" onClick={handleGenerate} disabled={!canGenerate}>
              Generate
            </button>
          </div>
        </form>

        <p className="muted">{status || "Ожидание действий"}</p>

        {objectKey ? (
          <p>
            Upload: <code>{objectKey}</code>{" "}
            {uploadUrl ? (
              <a href={uploadUrl} target="_blank" rel="noreferrer">
                Open source
              </a>
            ) : null}
          </p>
        ) : null}

        {resultKey ? (
          <div>
            <p>
              Render: <code>{resultKey}</code>{" "}
              <a href={resultUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </p>
            <img src={resultUrl} alt="Render result" style={{ maxWidth: "100%", borderRadius: 12 }} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
