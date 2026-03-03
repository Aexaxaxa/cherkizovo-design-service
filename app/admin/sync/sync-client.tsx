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
type SyncMode = "full" | "dry" | "single";

function readString(payload: SyncPayload | null, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "n/a";
}

export default function AdminSyncClient({ token }: { token: string }) {
  const [templateId, setTemplateId] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<AdminMeta | null>(null);
  const [result, setResult] = useState<SyncPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPageVisible, setIsPageVisible] = useState(true);

  const statusUrl = useMemo(() => `/api/admin/status?token=${encodeURIComponent(token)}`, [token]);
  const isRunning = loading || meta?.status === "running";

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
    setIsPageVisible(typeof document === "undefined" ? true : !document.hidden);
    void loadStatus().catch((err) => {
      console.error("[admin/sync] status init failed", err);
      setError("Failed to load current sync status");
    });
  }, [loadStatus]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = !document.hidden;
      setIsPageVisible(visible);
      if (visible) {
        void loadStatus().catch((err) => {
          console.error("[admin/sync] status reload after tab focus failed", err);
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [loadStatus]);

  useEffect(() => {
    if (!isPageVisible) return;

    const intervalMs = meta?.status === "running" ? 3000 : 60000;
    const timer = window.setTimeout(() => {
      void loadStatus().catch((err) => {
        console.error("[admin/sync] polling failed", err);
      });
    }, intervalMs);

    return () => window.clearTimeout(timer);
  }, [isPageVisible, loadStatus, meta?.status]);

  async function runSync(mode: SyncMode) {
    if (mode === "single" && !templateId.trim()) {
      setError("Enter templateId for single template sync");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams();
      params.set("token", token);
      if (mode === "dry") {
        params.set("dry", "1");
      }
      if (mode === "single") {
        params.set("templateId", templateId.trim());
      }

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
      console.error("[admin/sync] sync run failed", err);
      setError("Failed to start sync");
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
          <button type="button" disabled={isRunning} onClick={() => void runSync("full")}>
            {isRunning ? "Running..." : "Run full sync"}
          </button>
          <button type="button" disabled={isRunning} onClick={() => void runSync("dry")}>
            {isRunning ? "Running..." : "Dry run"}
          </button>
          <button type="button" disabled={isRunning} onClick={() => void runSync("single")}>
            {isRunning ? "Running..." : "Run single template sync"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              void loadStatus().catch((err) => {
                console.error("[admin/sync] manual refresh failed", err);
                setError("Failed to refresh status");
              })
            }
          >
            Refresh Status
          </button>
        </div>

        {error ? <p className="muted" style={{ color: "#a30000", marginTop: 12 }}>{error}</p> : null}

        <h2 style={{ marginTop: 20 }}>Current status</h2>
        <p className="muted">
          State: <strong>{meta?.status ?? "unknown"}</strong>
        </p>
        <p className="muted">Started: {meta?.startedAt ?? "n/a"}</p>
        <p className="muted">Finished: {meta?.finishedAt ?? "n/a"}</p>
        <p className="muted">Synced: {meta?.syncedAt ?? "n/a"}</p>
        <p className="muted">
          Counters: templates {meta?.templatesFound ?? 0}, frames {meta?.framesSaved ?? 0}, schemas{" "}
          {meta?.schemasSaved ?? 0}, assets {meta?.assetsSaved ?? 0}
        </p>
        <p className="muted">Batch: {meta ? `${meta.currentBatchIndex}/${meta.totalBatches}` : "0/0"}</p>

        <h2 style={{ marginTop: 20 }}>Last Response</h2>
        <p className="muted">Status: {readString(result, "status")}</p>
        <p className="muted">Started: {readString(result, "startedAt")}</p>
        <p className="muted">Finished: {readString(result, "finishedAt")}</p>
      </div>
    </main>
  );
}
