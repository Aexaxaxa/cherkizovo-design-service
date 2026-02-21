import { getFigmaEnv } from "@/lib/env";

const FIGMA_BASE_URL = "https://api.figma.com";
const FIGMA_TIMEOUT_MS = 15_000;
const FIGMA_MAX_RETRIES = 3;
const MAX_JITTER_MS = 200;

export type FigmaFetchOptions = {
  maxRetries?: number;
  sleepOn429?: boolean;
  timeoutMs?: number;
};

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
  return figmaFetchRawWithOptions(pathOrUrl, asBytes, {});
}

async function figmaFetchRawWithOptions(
  pathOrUrl: string,
  asBytes: boolean,
  options: FigmaFetchOptions
): Promise<{ data: unknown; meta: FigmaResponseMeta }> {
  const { FIGMA_TOKEN } = getFigmaEnv();
  const url = resolveFigmaUrl(pathOrUrl);
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries ?? 0) : FIGMA_MAX_RETRIES;
  const sleepOn429 = options.sleepOn429 ?? true;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? (options.timeoutMs as number) : FIGMA_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          if (attempt < maxRetries) {
            if (sleepOn429) {
              const baseDelay = retryAfterSec !== null ? retryAfterSec * 1000 : getRetryDelayMs(retryAfter, attempt);
              await sleep(baseDelay + Math.floor(Math.random() * (MAX_JITTER_MS + 1)));
            }
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
        throw new FigmaApiError(`Figma API request timed out after ${Math.round(timeoutMs / 1000)}s`, {
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
  const result = await figmaFetchRawWithOptions(pathOrUrl, false, {});
  return result.data as T;
}

export async function figmaFetchJsonWithMeta<T>(
  pathOrUrl: string,
  options: FigmaFetchOptions = {}
): Promise<{ data: T; meta: FigmaResponseMeta }> {
  const result = await figmaFetchRawWithOptions(pathOrUrl, false, options);
  return {
    data: result.data as T,
    meta: result.meta
  };
}

export async function figmaFetchBytes(pathOrUrl: string, options: FigmaFetchOptions = {}): Promise<Buffer> {
  const bytes = (await figmaFetchRawWithOptions(pathOrUrl, true, options)).data;
  if (!Buffer.isBuffer(bytes)) {
    throw new FigmaApiError("Failed to download binary payload from Figma", { status: 500 });
  }
  return bytes;
}
