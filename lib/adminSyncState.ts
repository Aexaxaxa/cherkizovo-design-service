import {
  getMetaSnapshotKey,
  tryReadSnapshotJson,
  writeSnapshotJson
} from "@/lib/snapshotStore";
import { deleteObject } from "@/lib/s3";

export const ADMIN_SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

export type AdminSyncLock = {
  startedAt: string;
  owner: string;
  expiresAt: string;
};

export type AdminSyncStatus = "idle" | "running" | "ok" | "error";

export type AdminSyncMeta = {
  status: AdminSyncStatus;
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

export function getAdminSyncLockKey(fileKey: string): string {
  return `admin/${fileKey}/sync.lock.json`;
}

export function createMetaDefaults(fileKey: string): AdminSyncMeta {
  return {
    status: "idle",
    fileKey,
    step: "idle",
    templatesFound: 0,
    framesSaved: 0,
    schemasSaved: 0,
    assetsSaved: 0,
    currentBatchIndex: 0,
    totalBatches: 0,
    lastError: null,
    startedAt: null,
    syncedAt: null,
    finishedAt: null,
    isPartial: false,
    templateId: null,
    dryRun: false
  };
}

export async function readAdminSyncMeta(fileKey: string): Promise<AdminSyncMeta> {
  const existing = await tryReadSnapshotJson<AdminSyncMeta>(getMetaSnapshotKey(fileKey));
  if (!existing) return createMetaDefaults(fileKey);
  return {
    ...createMetaDefaults(fileKey),
    ...existing,
    fileKey
  };
}

export async function writeAdminSyncMeta(fileKey: string, meta: AdminSyncMeta): Promise<void> {
  await writeSnapshotJson(getMetaSnapshotKey(fileKey), meta);
}

export async function readAdminSyncLock(fileKey: string): Promise<AdminSyncLock | null> {
  return tryReadSnapshotJson<AdminSyncLock>(getAdminSyncLockKey(fileKey));
}

export async function writeAdminSyncLock(fileKey: string, lock: AdminSyncLock): Promise<void> {
  await writeSnapshotJson(getAdminSyncLockKey(fileKey), lock);
}

export async function releaseAdminSyncLock(fileKey: string): Promise<void> {
  await deleteObject(getAdminSyncLockKey(fileKey));
}
