import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getSignedGetUrl, putObject } from "@/lib/s3";

export const runtime = "nodejs";

const supportedMime = new Set(["image/jpeg", "image/png", "image/webp"]);

function extFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    if (!supportedMime.has(file.type)) {
      return NextResponse.json({ error: "Unsupported mime type" }, { status: 400 });
    }

    const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `File is too large. Max ${env.MAX_UPLOAD_MB} MB` },
        { status: 400 }
      );
    }

    const body = Buffer.from(await file.arrayBuffer());
    const objectKey = `uploads/${randomUUID()}.${extFromMime(file.type)}`;

    await putObject({
      Key: objectKey,
      Body: body,
      ContentType: file.type
    });

    const signedGetUrl = await getSignedGetUrl(objectKey);
    return NextResponse.json({ objectKey, signedGetUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
