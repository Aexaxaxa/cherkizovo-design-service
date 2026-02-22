import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { putObject } from "@/lib/s3";

export const runtime = "nodejs";

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;

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

function errorJson(code: string, error: string, status: number) {
  return NextResponse.json({ ok: false, code, error }, { status });
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const entries = [...formData.entries()];
    if (entries.length === 0) {
      return errorJson("E_UPLOAD_REQUIRED", "Файлы не переданы", 400);
    }

    const objectKeys: Record<string, string> = {};

    for (const [fieldName, value] of entries) {
      if (!(value instanceof File)) {
        return errorJson("E_UPLOAD_REQUIRED", `Поле ${fieldName} не содержит файл`, 400);
      }

      if (!SUPPORTED_MIME.has(value.type)) {
        return errorJson("E_UPLOAD_TYPE", `Недопустимый тип файла для ${fieldName}`, 400);
      }

      if (value.size > MAX_FILE_BYTES) {
        return errorJson("E_UPLOAD_TOO_LARGE", `Файл ${fieldName} превышает 15MB`, 400);
      }

      const body = Buffer.from(await value.arrayBuffer());
      const objectKey = `uploads/${randomUUID()}.${extFromMime(value.type)}`;
      await putObject({
        Key: objectKey,
        Body: body,
        ContentType: value.type
      });
      objectKeys[fieldName] = objectKey;
    }

    return NextResponse.json({
      ok: true,
      objectKeys
    });
  } catch (error) {
    console.error("[upload batch]", error);
    return errorJson("E_UPLOAD_FAILED", "Ошибка загрузки файлов", 500);
  }
}
