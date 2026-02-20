"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

type SyncResponse = {
  retryAfterSec?: number | null;
};

export default function HomePage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [status, setStatus] = useState("Loading templates...");
  const [syncing, setSyncing] = useState(false);

  const loadTemplates = useCallback(async () => {
    const response = await fetch("/api/templates", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | TemplateItem[]
      | null;

    if (!response.ok) {
      throw new Error(
        payload && typeof payload === "object" && !Array.isArray(payload) && payload.error
          ? payload.error
          : `Failed to load templates: ${response.status}`
      );
    }

    if (!Array.isArray(payload)) {
      throw new Error("Templates response has invalid format");
    }

    setTemplates(payload);
    setStatus(payload.length > 0 ? "" : "No templates found");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function runLoad() {
      try {
        await loadTemplates();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load templates";
        if (!cancelled) {
          setStatus(message);
        }
      }
    }

    void runLoad();

    return () => {
      cancelled = true;
    };
  }, [loadTemplates]);

  async function handleSyncPreviews() {
    if (syncing) return;

    setSyncing(true);
    setStatus("Скачиваем превью...");

    try {
      const response = await fetch("/api/previews/sync", {
        method: "POST"
      });

      const payload = (await response.json().catch(() => null)) as SyncResponse | { error?: string } | null;

      if (response.status === 429) {
        const retryAfterSec =
          payload && typeof payload === "object" && "retryAfterSec" in payload
            ? Number(payload.retryAfterSec)
            : NaN;
        const safeRetryAfter = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.ceil(retryAfterSec) : 30;
        setStatus(`лимит Figma, повторить через ${safeRetryAfter} секунд`);
        return;
      }

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && payload.error
            ? payload.error
            : `Failed to sync previews: ${response.status}`
        );
      }

      await loadTemplates();
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync previews";
      setStatus(message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Cherkizovo Design Service</h1>
        <p className="muted">Templates from Figma file</p>

        {status ? <p className="muted">{status}</p> : null}

        <div className="templates-grid">
          {templates.map((template) => (
            <article className="template-card" key={template.id}>
              <Link className="template-preview-link" href={`/t/${encodeURIComponent(template.id)}`}>
                {template.previewSignedUrl ? (
                  <img className="template-preview" src={template.previewSignedUrl} alt={template.name} />
                ) : (
                  <div className="template-preview template-preview--empty">Preview not downloaded</div>
                )}
              </Link>

              <div className="template-meta">
                <strong>{template.name}</strong>
                <span className="muted">{template.page}</span>
                <code>{template.id}</code>
              </div>

              <div className="template-actions">
                <Link href={`/t/${encodeURIComponent(template.id)}`}>Открыть шаблон</Link>
                {!template.previewSignedUrl ? (
                  <button type="button" disabled={syncing} onClick={() => void handleSyncPreviews()}>
                    {syncing ? "Скачивание..." : "Скачать превью"}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
