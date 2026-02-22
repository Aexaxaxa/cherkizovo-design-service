"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type AdminMeta = {
  status: "idle" | "running" | "ok" | "error";
  fileKey: string;
  step: string;
  templatesFound: number;
  framesSaved: number;
  schemasSaved: number;
  assetsSaved: number;
  currentBatchIndex: number;
  totalBatches: number;
  lastError: string | null;
  startedAt: string | null;
  syncedAt: string | null;
  finishedAt: string | null;
  isPartial: boolean;
  templateId: string | null;
  dryRun: boolean;
};

type SyncPayload = Record<string, unknown>;

export default function AdminSyncClient({ token }: { token: string }) {
  const [templateId, setTemplateId] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<AdminMeta | null>(null);
  const [result, setResult] = useState<SyncPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusUrl = useMemo(() => `/api/admin/status?token=${encodeURIComponent(token)}`, [token]);

  const loadStatus = useCallback(async () => {
    const response = await fetch(statusUrl, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as AdminMeta | { error?: string } | null;
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Status request failed: ${response.status}`;
      throw new Error(message);
    }
    if (!payload || Array.isArray(payload)) {
      throw new Error("Invalid status payload");
    }
    setMeta(payload as AdminMeta);
  }, [statusUrl]);

  useEffect(() => {
    void loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Failed to load status"));
  }, [loadStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatus().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  async function runSync(dryRun: boolean) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams();
      params.set("token", token);
      if (dryRun) params.set("dry", "1");
      const trimmedTemplateId = templateId.trim();
      if (trimmedTemplateId) params.set("templateId", trimmedTemplateId);
      const response = await fetch(`/api/admin/sync?${params.toString()}`, {
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as SyncPayload | { error?: string } | null;
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Sync request failed: ${response.status}`;
        throw new Error(message);
      }
      setResult((payload ?? {}) as SyncPayload);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
      await loadStatus().catch(() => undefined);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Admin Sync</h1>
        <p className="muted">Manual Figma snapshot synchronization</p>

        <label htmlFor="templateId">Template ID (optional, partial sync)</label>
        <input
          id="templateId"
          type="text"
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
          placeholder="15:123"
        />

        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" disabled={loading} onClick={() => void runSync(false)}>
            {loading ? "Running..." : "Run Sync"}
          </button>
          <button type="button" disabled={loading} onClick={() => void runSync(true)}>
            {loading ? "Running..." : "Dry Run"}
          </button>
          <button type="button" disabled={loading} onClick={() => void loadStatus()}>
            Refresh Status
          </button>
        </div>

        {error ? <p className="muted" style={{ color: "#a30000", marginTop: 12 }}>{error}</p> : null}

        <h2 style={{ marginTop: 20 }}>Meta</h2>
        <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 8, overflow: "auto" }}>
          {JSON.stringify(meta, null, 2)}
        </pre>

        <h2 style={{ marginTop: 20 }}>Last Response</h2>
        <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 8, overflow: "auto" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      </div>
    </main>
  );
}
