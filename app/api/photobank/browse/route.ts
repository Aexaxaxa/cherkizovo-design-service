import { NextResponse } from "next/server";
import { browsePhotobank } from "@/lib/photobank";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path");
    const limit = searchParams.get("limit");
    const offset = searchParams.get("offset");

    const result = await browsePhotobank({
      path,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to browse photobank";
    return NextResponse.json(
      {
        code: "E_PHOTOBANK_BROWSE",
        error: message
      },
      { status: 500 }
    );
  }
}

