"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  hasPreview: boolean;
  previewKey: string | null;
};

type TemplatesResponse = TemplateItem[] | { templates?: TemplateItem[]; meta?: unknown; error?: string };

type SyncResponse = {
  retryAfterSec?: number | null;
  error?: string;
};

const PRELOAD_PREVIEW_COUNT = 20;

export default function HomePage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("Loading templates...");
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  const previewInFlightRef = useRef(new Set<string>());
  const previewRequestedRef = useRef(new Set<string>());

  async function fetchPreviewUrl(templateId: string) {
    if (previewInFlightRef.current.has(templateId)) return;
    if (previewUrls[templateId]) return;

    previewInFlightRef.current.add(templateId);
    previewRequestedRef.current.add(templateId);

    try {
      const response = await fetch(`/api/previews/url?templateId=${encodeURIComponent(templateId)}`, {
        cache: "no-store"
      });

      if (!response.ok) return;

      const payload = (await response.json().catch(() => null)) as { previewSignedUrl?: string } | null;
      if (!payload?.previewSignedUrl) return;

      setPreviewUrls((prev) => ({ ...prev, [templateId]: payload.previewSignedUrl as string }));
    } finally {
      previewInFlightRef.current.delete(templateId);
    }
  }

  async function loadTemplates() {
    setLoadingTemplates(true);
    setTemplatesError(null);
    setStatus("Loading templates...");

    try {
      const response = await fetch("/api/templates", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as TemplatesResponse | null;

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && !Array.isArray(payload) && payload.error
            ? payload.error
            : `Failed to load templates: ${response.status}`
        );
      }

      const items = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray(payload.templates)
          ? payload.templates
          : null;

      if (!items) {
        throw new Error("Templates response has invalid format");
      }

      setTemplates(items);
      setPreviewUrls((prev) => {
        const next: Record<string, string> = {};
        for (const template of items) {
          if (prev[template.id]) {
            next[template.id] = prev[template.id];
          }
        }
        return next;
      });
      setStatus(items.length > 0 ? "" : "No templates found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load templates";
      setTemplatesError(message);
      setStatus(message);
    } finally {
      setLoadingTemplates(false);
    }
  }

  useEffect(() => {
    void loadTemplates();
  }, []);

  useEffect(() => {
    const candidates = templates.filter((t) => t.hasPreview).slice(0, PRELOAD_PREVIEW_COUNT);
    for (const template of candidates) {
      if (previewRequestedRef.current.has(template.id)) continue;
      if (previewUrls[template.id]) continue;
      void fetchPreviewUrl(template.id);
    }
  }, [templates, previewUrls]);

  async function handleSyncPreview(templateId: string) {
    if (syncingId) return;

    setSyncingId(templateId);
    setStatus("Downloading preview...");

    try {
      const response = await fetch("/api/previews/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId })
      });

      const payload = (await response.json().catch(() => null)) as SyncResponse | null;

      if (response.status === 429) {
        const retryAfterSec = Number(payload?.retryAfterSec);
        const safeRetryAfter = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.ceil(retryAfterSec) : 30;
        setStatus(`Figma limit reached, retry in ${safeRetryAfter}s`);
        return;
      }

      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to sync preview: ${response.status}`);
      }

      previewRequestedRef.current.delete(templateId);
      setPreviewUrls((prev) => {
        const next = { ...prev };
        delete next[templateId];
        return next;
      });
      await loadTemplates();
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync preview";
      setStatus(message);
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Cherkizovo Design Service</h1>
        <p className="muted">Templates from Figma file</p>

        {status ? <p className="muted">{status}</p> : null}
        {templatesError ? (
          <div className="row">
            <button type="button" onClick={() => void loadTemplates()} disabled={loadingTemplates}>
              {loadingTemplates ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        <div className="templates-grid">
          {templates.map((template) => {
            const previewSignedUrl = previewUrls[template.id] ?? null;
            const isSyncingThis = syncingId === template.id;

            return (
              <article className="template-card" key={template.id}>
                <Link className="template-preview-link" href={`/t/${encodeURIComponent(template.id)}`}>
                  {previewSignedUrl ? (
                    <img className="template-preview" src={previewSignedUrl} alt={template.name} />
                  ) : (
                    <div className="template-preview template-preview--empty">
                      {template.hasPreview ? "Preview loading..." : "Preview not downloaded"}
                    </div>
                  )}
                </Link>

                <div className="template-meta">
                  <strong>{template.name}</strong>
                  <span className="muted">{template.page}</span>
                  <code>{template.id}</code>
                </div>

                <div className="template-actions">
                  <Link href={`/t/${encodeURIComponent(template.id)}`}>Open template</Link>
                  {!template.hasPreview ? (
                    <button type="button" disabled={!!syncingId} onClick={() => void handleSyncPreview(template.id)}>
                      {isSyncingThis ? "Downloading..." : "Download preview"}
                    </button>
                  ) : !previewSignedUrl ? (
                    <button type="button" onClick={() => void fetchPreviewUrl(template.id)}>
                      Show preview
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
