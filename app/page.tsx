"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

type NetworkFilter = "all" | "vk" | "ok" | "start" | "other";

function getNetworkFromTemplateName(name: string): Exclude<NetworkFilter, "all"> {
  const lower = name.trim().toLowerCase();
  if (lower.startsWith("tpl_vk_")) return "vk";
  if (lower.startsWith("tpl_ok_")) return "ok";
  if (lower.startsWith("tpl_start_")) return "start";
  return "other";
}

function toUserError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : "Не удалось загрузить шаблоны";
  console.error("[templates]", error);
  if (message.includes("No snapshot")) return { code: "E_TEMPLATES_UNAVAILABLE", message: "Шаблоны временно недоступны" };
  return { code: "E_TEMPLATES_LOAD_FAILED", message: "Не удалось загрузить шаблоны" };
}

export default function HomePage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [status, setStatus] = useState("Loading templates...");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>("all");

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
      const friendly = toUserError(err);
      setError(friendly);
      setStatus(`${friendly.message} (${friendly.code})`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplates();
  }, []);

  const visibleTemplates = useMemo(() => {
    if (networkFilter === "all") return templates;
    return templates.filter((template) => getNetworkFromTemplateName(template.name) === networkFilter);
  }, [templates, networkFilter]);

  return (
    <main>
      <div className="card">
        <h1>Cherkizovo Design Service</h1>
        <p className="muted">Выберите шаблон</p>

        <div className="field-block">
          <label htmlFor="network-filter">Соцсеть</label>
          <select
            id="network-filter"
            value={networkFilter}
            onChange={(event) => setNetworkFilter(event.target.value as NetworkFilter)}
          >
            <option value="all">Все</option>
            <option value="vk">Вконтакте</option>
            <option value="ok">Одноклассники</option>
            <option value="start">Старт</option>
            <option value="other">Другие</option>
          </select>
        </div>

        {status ? <p className="muted">{status}</p> : null}
        {error ? (
          <div className="row">
            <button type="button" onClick={() => void loadTemplates()} disabled={loading}>
              {loading ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        <div className="templates-grid">
          {visibleTemplates.map((template) => {
            const hasImage = template.previewSignedUrl && !brokenImages[template.id];
            return (
              <Link className="template-card" href={`/t/${encodeURIComponent(template.id)}`} key={template.id}>
                <div className="template-preview-wrap">
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
                </div>

                <div className="template-meta">
                  <strong>{template.name}</strong>
                  <span className="muted">
                    {getNetworkFromTemplateName(template.name) === "vk"
                      ? "Вконтакте"
                      : getNetworkFromTemplateName(template.name) === "ok"
                        ? "Одноклассники"
                        : getNetworkFromTemplateName(template.name) === "start"
                          ? "Старт"
                          : "Другие"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
