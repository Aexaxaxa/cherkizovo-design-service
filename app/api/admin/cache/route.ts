import { NextResponse } from "next/server";
import { clearRuntimeCaches, getRuntimeCacheStats } from "@/lib/s3";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const adminSecret = process.env.ADMIN_SYNC_SECRET?.trim();
  const requestSecret = request.headers.get("x-admin-secret")?.trim();
  return Boolean(adminSecret && requestSecret && adminSecret === requestSecret);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(getRuntimeCacheStats());
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  clearRuntimeCaches();
  return NextResponse.json({
    status: "ok",
    ...getRuntimeCacheStats()
  });
}
