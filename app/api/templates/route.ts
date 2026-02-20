import { NextResponse } from "next/server";
import { FigmaApiError } from "@/lib/figmaClient";
import { listTemplates, listTemplatesWithDebug } from "@/lib/figmaTemplates";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const debug = searchParams.get("debug") === "1";
    const refresh = searchParams.get("refresh") === "1";

    if (debug) {
      const payload = await listTemplatesWithDebug({ refresh });
      return NextResponse.json({
        framesReturned: payload.debug.framesReturned,
        previewsAvailableCount: payload.debug.previewsAvailableCount,
        previewsMissingCount: payload.debug.previewsMissingCount,
        sampleFirst10: payload.debug.sampleFirst10,
        pages: payload.debug.pages,
        framesFoundTotal: payload.debug.framesFoundTotal,
        figmaRateLimitTypes: payload.debug.figmaRateLimitTypes
      });
    }

    const templates = await listTemplates({ refresh });
    return NextResponse.json(templates);
  } catch (error) {
    if (error instanceof FigmaApiError) {
      if (error.status === 429) {
        return NextResponse.json(
          {
            error: "Figma API rate limit exceeded",
            retryAfterSec: error.retryAfterSec ?? null
          },
          { status: 429 }
        );
      }

      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return NextResponse.json(
        {
          error: error.message,
          status
        },
        { status }
      );
    }

    const message = error instanceof Error ? error.message : "Failed to load templates";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
