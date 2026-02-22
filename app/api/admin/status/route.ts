import { NextResponse } from "next/server";
import { createMetaDefaults, readAdminSyncMeta } from "@/lib/adminSyncState";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  const uiToken = process.env.ADMIN_UI_TOKEN?.trim();
  if (uiToken && token === uiToken) return true;

  const adminSecret = process.env.ADMIN_SYNC_SECRET?.trim();
  const requestSecret = request.headers.get("x-admin-secret")?.trim();
  if (adminSecret && requestSecret === adminSecret) return true;

  return false;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const env = getEnv();
  const fileKey = env.FIGMA_FILE_KEY?.trim();
  if (!fileKey) {
    return NextResponse.json({ error: "Missing FIGMA_FILE_KEY" }, { status: 500 });
  }

  const meta = await readAdminSyncMeta(fileKey).catch(() => createMetaDefaults(fileKey));
  return NextResponse.json(meta);
}
