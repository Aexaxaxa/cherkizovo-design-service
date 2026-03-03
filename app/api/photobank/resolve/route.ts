import { NextResponse } from "next/server";
import { resolvePhotobankDownloadHref } from "@/lib/photobank";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as { path?: string } | null;
    const path = payload?.path?.trim();
    if (!path) {
      return NextResponse.json(
        {
          code: "E_PHOTOBANK_DOWNLOAD",
          error: "path is required"
        },
        { status: 400 }
      );
    }

    const href = await resolvePhotobankDownloadHref(path);
    return NextResponse.json({ href });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve photobank file";
    return NextResponse.json(
      {
        code: "E_PHOTOBANK_DOWNLOAD",
        error: message
      },
      { status: 500 }
    );
  }
}

