import { NextResponse } from "next/server";
import { resolvePhotobankPreviewUrl } from "@/lib/photobank";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path")?.trim();
    const size = searchParams.get("size")?.trim() || "XL";

    if (!path) {
      return NextResponse.json(
        {
          code: "E_PHOTOBANK_BROWSE",
          error: "path is required"
        },
        { status: 400 }
      );
    }

    const previewUrl = await resolvePhotobankPreviewUrl(path, size);
    return NextResponse.json({ previewUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve photobank preview";
    return NextResponse.json(
      {
        code: "E_PHOTOBANK_BROWSE",
        error: message
      },
      { status: 500 }
    );
  }
}
