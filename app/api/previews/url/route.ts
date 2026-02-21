import { NextResponse } from "next/server";
import { getPreviewObjectKey } from "@/lib/figmaPreviews";
import { getSignedGetUrl, headObject } from "@/lib/s3";

export const runtime = "nodejs";

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("$metadata" in error && typeof error.$metadata === "object" && error.$metadata) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (metadata.httpStatusCode === 404) return true;
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name === "NotFound" || error.name === "NoSuchKey";
  }
  return false;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawTemplateId = searchParams.get("templateId");
    const fileKey = process.env.FIGMA_FILE_KEY?.trim();

    if (!rawTemplateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }

    if (!fileKey) {
      return NextResponse.json({ error: "Missing FIGMA_FILE_KEY in environment" }, { status: 500 });
    }

    const templateId = decodeURIComponent(rawTemplateId);
    const previewKey = getPreviewObjectKey(fileKey, templateId);

    try {
      await headObject(previewKey);
    } catch (error) {
      if (isNotFoundError(error)) {
        return NextResponse.json({ error: "Preview not found" }, { status: 404 });
      }
      throw error;
    }

    const previewSignedUrl = await getSignedGetUrl(previewKey, 900);
    return NextResponse.json({ previewSignedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create preview signed url";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
