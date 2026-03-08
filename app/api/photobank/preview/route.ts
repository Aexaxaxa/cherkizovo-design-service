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
          code: "E_PHOTOBANK_PREVIEW_FAILED",
          error: "path is required"
        },
        { status: 400 }
      );
    }

    const previewUrl = await resolvePhotobankPreviewUrl(path, size);
    const previewResponse = await fetch(previewUrl, { cache: "no-store" });
    if (!previewResponse.ok) {
      throw new Error(`Yandex preview download failed: ${previewResponse.status}`);
    }

    const upstreamType = previewResponse.headers.get("content-type")?.split(";")[0]?.trim();
    const contentType =
      upstreamType && upstreamType.startsWith("image/")
        ? upstreamType
        : path.toLowerCase().endsWith(".png")
          ? "image/png"
          : path.toLowerCase().endsWith(".webp")
            ? "image/webp"
            : path.toLowerCase().endsWith(".gif")
              ? "image/gif"
              : "image/jpeg";

    const imageData = await previewResponse.arrayBuffer();

    return new Response(imageData, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: "E_PHOTOBANK_PREVIEW_FAILED",
        error: "Photobank preview failed"
      },
      { status: 502 }
    );
  }
}
