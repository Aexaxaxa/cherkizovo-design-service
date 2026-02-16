import { getFigmaEnv } from "@/lib/env";

const FIGMA_BASE_URL = "https://api.figma.com";
const FIGMA_TIMEOUT_MS = 15_000;

type FigmaErrorOptions = {
  status: number;
  retryAfter?: string | null;
  details?: unknown;
};

export class FigmaApiError extends Error {
  readonly status: number;
  readonly retryAfter?: string | null;
  readonly details?: unknown;

  constructor(message: string, options: FigmaErrorOptions) {
    super(message);
    this.name = "FigmaApiError";
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
  }
}

function parseFigmaErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if ("err" in payload && typeof payload.err === "string") {
    return payload.err;
  }
  if ("message" in payload && typeof payload.message === "string") {
    return payload.message;
  }
  return null;
}

export async function figmaFetch<T>(path: string): Promise<T> {
  const { FIGMA_TOKEN } = getFigmaEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIGMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${FIGMA_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "X-Figma-Token": FIGMA_TOKEN
      },
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      let details: unknown = null;
      let messageFromPayload: string | null = null;

      try {
        details = await response.json();
        messageFromPayload = parseFigmaErrorPayload(details);
      } catch {
        details = await response.text().catch(() => null);
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new FigmaApiError(messageFromPayload ?? "Figma API rate limit exceeded", {
          status: 429,
          retryAfter,
          details
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new FigmaApiError(
          messageFromPayload ??
            "Figma authentication/authorization failed. Check FIGMA_TOKEN and file access.",
          { status: response.status, details }
        );
      }

      throw new FigmaApiError(messageFromPayload ?? `Figma API request failed: ${response.status}`, {
        status: response.status,
        details
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof FigmaApiError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new FigmaApiError(`Figma API request timed out after ${FIGMA_TIMEOUT_MS / 1000}s`, {
        status: 504
      });
    }
    const message = error instanceof Error ? error.message : "Unknown Figma request error";
    throw new FigmaApiError(message, { status: 500 });
  } finally {
    clearTimeout(timeout);
  }
}
