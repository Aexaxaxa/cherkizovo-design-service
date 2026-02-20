import { getFigmaEnv } from "@/lib/env";

const FIGMA_BASE_URL = "https://api.figma.com";
const FIGMA_TIMEOUT_MS = 15_000;
const FIGMA_MAX_RETRIES = 3;
const MAX_JITTER_MS = 200;

export type FigmaResponseMeta = {
  status: number;
  url: string;
  rateLimitType: string | null;
};

type FigmaErrorOptions = {
  status: number;
  retryAfter?: string | null;
  retryAfterSec?: number | null;
  rateLimitType?: string | null;
  details?: unknown;
};

export class FigmaApiError extends Error {
  readonly status: number;
  readonly retryAfter?: string | null;
  readonly retryAfterSec?: number | null;
  readonly rateLimitType?: string | null;
  readonly details?: unknown;

  constructor(message: string, options: FigmaErrorOptions) {
    super(message);
    this.name = "FigmaApiError";
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.retryAfterSec = options.retryAfterSec;
    this.rateLimitType = options.rateLimitType;
    this.details = options.details;
  }
}

function parseFigmaErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if ("err" in payload && typeof payload.err === "string") return payload.err;
  if ("message" in payload && typeof payload.message === "string") return payload.message;
  return null;
}

function getRetryDelayMs(retryAfter: string | null, attempt: number): number {
  if (!retryAfter) return 500 * (attempt + 1);
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }
  const asDateMs = Date.parse(retryAfter);
  if (Number.isFinite(asDateMs)) {
    return Math.max(0, asDateMs - Date.now());
  }
  return 500 * (attempt + 1);
}

function parseRetryAfterSeconds(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.ceil(asNumber);
  }
  const asDateMs = Date.parse(retryAfter);
  if (Number.isFinite(asDateMs)) {
    return Math.max(0, Math.ceil((asDateMs - Date.now()) / 1000));
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFigmaUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  return `${FIGMA_BASE_URL}${pathOrUrl}`;
}

async function figmaFetchRaw(pathOrUrl: string, asBytes: boolean): Promise<{ data: unknown; meta: FigmaResponseMeta }> {
  const { FIGMA_TOKEN } = getFigmaEnv();
  const url = resolveFigmaUrl(pathOrUrl);

  for (let attempt = 0; attempt <= FIGMA_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FIGMA_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
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
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSec = parseRetryAfterSeconds(retryAfter);
        const rateLimitType = response.headers.get("X-Figma-Rate-Limit-Type");

        try {
          details = await response.json();
          messageFromPayload = parseFigmaErrorPayload(details);
        } catch {
          details = await response.text().catch(() => null);
        }

        if (response.status === 429) {
          if (attempt < FIGMA_MAX_RETRIES) {
            const baseDelay = retryAfterSec !== null ? retryAfterSec * 1000 : getRetryDelayMs(retryAfter, attempt);
            await sleep(baseDelay + Math.floor(Math.random() * (MAX_JITTER_MS + 1)));
            continue;
          }
          throw new FigmaApiError(messageFromPayload ?? "Figma API rate limit exceeded", {
            status: 429,
            retryAfter,
            retryAfterSec,
            rateLimitType,
            details
          });
        }

        if (response.status === 401 || response.status === 403) {
          throw new FigmaApiError(
            messageFromPayload ??
              "Figma authentication/authorization failed. Check FIGMA_TOKEN and file access.",
            { status: response.status, retryAfter, retryAfterSec, rateLimitType, details }
          );
        }

        throw new FigmaApiError(messageFromPayload ?? `Figma API request failed: ${response.status}`, {
          status: response.status,
          retryAfter,
          retryAfterSec,
          rateLimitType,
          details
        });
      }

      if (asBytes) {
        return {
          data: Buffer.from(await response.arrayBuffer()),
          meta: {
            status: response.status,
            url,
            rateLimitType: response.headers.get("X-Figma-Rate-Limit-Type")
          }
        };
      }
      return {
        data: await response.json(),
        meta: {
          status: response.status,
          url,
          rateLimitType: response.headers.get("X-Figma-Rate-Limit-Type")
        }
      };
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

  throw new FigmaApiError("Figma API request failed after retries", { status: 500 });
}

export async function figmaFetchJson<T>(pathOrUrl: string): Promise<T> {
  const result = await figmaFetchRaw(pathOrUrl, false);
  return result.data as T;
}

export async function figmaFetchJsonWithMeta<T>(pathOrUrl: string): Promise<{ data: T; meta: FigmaResponseMeta }> {
  const result = await figmaFetchRaw(pathOrUrl, false);
  return {
    data: result.data as T,
    meta: result.meta
  };
}

export async function figmaFetchBytes(pathOrUrl: string): Promise<Buffer> {
  const bytes = (await figmaFetchRaw(pathOrUrl, true)).data;
  if (!Buffer.isBuffer(bytes)) {
    throw new FigmaApiError("Failed to download binary payload from Figma", { status: 500 });
  }
  return bytes;
}
