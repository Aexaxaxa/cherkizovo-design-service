type RuntimeEnv = {
  FIGMA_TOKEN?: string;
  FIGMA_FILE_KEY?: string;
  USE_FIGMA_RENDER?: string;
  DEBUG_RENDER?: string;
  B2_BUCKET_NAME: string;
  B2_S3_REGION: string;
  B2_S3_ENDPOINT: string;
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_ACCESS_KEY: string;
  MAX_UPLOAD_MB: number;
  SIGNED_URL_EXPIRES_SEC: number;
};

let cachedEnv: RuntimeEnv | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }
  return value;
}

export function getEnv(): RuntimeEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = {
    FIGMA_TOKEN: process.env.FIGMA_TOKEN,
    FIGMA_FILE_KEY: process.env.FIGMA_FILE_KEY,
    USE_FIGMA_RENDER: process.env.USE_FIGMA_RENDER,
    DEBUG_RENDER: process.env.DEBUG_RENDER,
    B2_BUCKET_NAME: getRequiredEnv("B2_BUCKET_NAME"),
    B2_S3_REGION: getRequiredEnv("B2_S3_REGION"),
    B2_S3_ENDPOINT: getRequiredEnv("B2_S3_ENDPOINT"),
    B2_ACCESS_KEY_ID: getRequiredEnv("B2_ACCESS_KEY_ID"),
    B2_SECRET_ACCESS_KEY: getRequiredEnv("B2_SECRET_ACCESS_KEY"),
    MAX_UPLOAD_MB: getNumberEnv("MAX_UPLOAD_MB", 10),
    SIGNED_URL_EXPIRES_SEC: getNumberEnv("SIGNED_URL_EXPIRES_SEC", 900)
  };

  return cachedEnv;
}

export function getFigmaEnv() {
  const env = getEnv();
  return {
    FIGMA_TOKEN: env.FIGMA_TOKEN ?? getRequiredEnv("FIGMA_TOKEN"),
    FIGMA_FILE_KEY: env.FIGMA_FILE_KEY ?? getRequiredEnv("FIGMA_FILE_KEY")
  };
}

export function isFigmaRenderEnabled(): boolean {
  return getEnv().USE_FIGMA_RENDER === "1";
}
