"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

export default function HomePage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [status, setStatus] = useState("Loading templates...");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  async function loadTemplates() {
    setLoading(true);
    setError(null);
    setStatus("Loading templates...");
    try {
      const response = await fetch("/api/templates", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | TemplateItem[] | null;

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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load templates";
      setError(message);
      setStatus(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplates();
  }, []);

  return (
    <main>
      <div className="card">
        <h1>Cherkizovo Design Service</h1>
        <p className="muted">Templates from Figma file</p>

        {status ? <p className="muted">{status}</p> : null}
        {error ? (
          <div className="row">
            <button type="button" onClick={() => void loadTemplates()} disabled={loading}>
              {loading ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        <div className="templates-grid">
          {templates.map((template) => {
            const hasImage = template.previewSignedUrl && !brokenImages[template.id];
            return (
              <article className="template-card" key={template.id}>
                <Link className="template-preview-link" href={`/t/${encodeURIComponent(template.id)}`}>
                  {hasImage ? (
                    <img
                      className="template-preview"
                      src={template.previewSignedUrl as string}
                      alt={template.name}
                      onError={() =>
                        setBrokenImages((prev) => ({
                          ...prev,
                          [template.id]: true
                        }))
                      }
                    />
                  ) : (
                    <div className="template-preview template-preview--empty">No preview</div>
                  )}
                </Link>

                <div className="template-meta">
                  <strong>{template.name}</strong>
                  <span className="muted">{template.page}</span>
                  <code>{template.id}</code>
                </div>

                <div className="template-actions">
                  <Link href={`/t/${encodeURIComponent(template.id)}`}>Open template</Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
