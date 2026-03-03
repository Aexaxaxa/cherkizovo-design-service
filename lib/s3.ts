import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LruTtlCache } from "@/lib/cache";
import { getEnv } from "@/lib/env";
import { streamToBuffer } from "@/lib/streamToBuffer";

let s3Client: S3Client | null = null;
let jsonCache: LruTtlCache<unknown> | null = null;
let bufferCache: LruTtlCache<Buffer> | null = null;

function initCaches() {
  if (jsonCache && bufferCache) return;
  const env = getEnv();
  jsonCache = new LruTtlCache<unknown>({
    maxItems: env.CACHE_JSON_MAX_ITEMS,
    debug: env.CACHE_DEBUG,
    name: "json"
  });
  bufferCache = new LruTtlCache<Buffer>({
    maxItems: env.CACHE_ASSET_MAX_ITEMS,
    maxBytes: env.CACHE_ASSET_MAX_BYTES,
    debug: env.CACHE_DEBUG,
    name: "buffer"
  });
}

export function getS3Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }

  const env = getEnv();
  s3Client = new S3Client({
    endpoint: env.B2_S3_ENDPOINT,
    region: env.B2_S3_REGION,
    credentials: {
      accessKeyId: env.B2_ACCESS_KEY_ID,
      secretAccessKey: env.B2_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });

  return s3Client;
}

export async function putObject(input: Omit<PutObjectCommandInput, "Bucket">) {
  const env = getEnv();
  const s3 = getS3Client();
  return s3.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      ...input
    })
  );
}

export async function getObject(key: string) {
  const env = getEnv();
  const s3 = getS3Client();
  return s3.send(
    new GetObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key
    })
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const response = await getObject(key);
  if (!response.Body) {
    throw new Error(`Object body is empty: ${key}`);
  }
  return streamToBuffer(response.Body);
}

function getJsonCacheKey(s3Key: string): string {
  return `json:${s3Key}`;
}

function getBufferCacheKey(s3Key: string): string {
  return `buf:${s3Key}`;
}

export async function getJsonCached<T>(s3Key: string): Promise<T> {
  const env = getEnv();
  if (!env.CACHE_ENABLED) {
    return JSON.parse((await getObjectBuffer(s3Key)).toString("utf-8")) as T;
  }

  initCaches();
  const ttlMs = env.CACHE_JSON_TTL_SEC * 1000;
  const key = getJsonCacheKey(s3Key);
  return (await jsonCache!.getOrSetAsync(key, ttlMs, async () => {
    const buffer = await getObjectBuffer(s3Key);
    return JSON.parse(buffer.toString("utf-8")) as T;
  })) as T;
}

export async function getBufferCached(s3Key: string): Promise<Buffer> {
  const env = getEnv();
  if (!env.CACHE_ENABLED) {
    return getObjectBuffer(s3Key);
  }

  initCaches();
  const ttlMs = env.CACHE_ASSET_TTL_SEC * 1000;
  const key = getBufferCacheKey(s3Key);
  return bufferCache!.getOrSetAsync(
    key,
    ttlMs,
    async () => {
      const buffer = await getObjectBuffer(s3Key);
      return buffer;
    },
    undefined
  );
}

export async function deleteObject(key: string) {
  const env = getEnv();
  const s3 = getS3Client();
  return s3.send(
    new DeleteObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key
    })
  );
}

export async function headObject(key: string) {
  const env = getEnv();
  const s3 = getS3Client();
  return s3.send(
    new HeadObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key
    })
  );
}

export async function getSignedGetUrl(key: string, expiresInSec?: number) {
  const env = getEnv();
  const s3 = getS3Client();
  const command = new GetObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(s3, command, {
    expiresIn: expiresInSec ?? env.SIGNED_URL_EXPIRES_SEC
  });
}

export async function listObjectKeysByPrefix(prefix: string): Promise<string[]> {
  const env = getEnv();
  const s3 = getS3Client();
  const out: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.B2_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken
      })
    );

    for (const item of response.Contents ?? []) {
      if (item.Key) {
        out.push(item.Key);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return out;
}

export function clearRuntimeCaches() {
  if (jsonCache) jsonCache.clear();
  if (bufferCache) bufferCache.clear();
}

export function getRuntimeCacheStats() {
  initCaches();
  return {
    json: jsonCache!.stats(),
    buffer: bufferCache!.stats(),
    inMemoryEnabled: getEnv().CACHE_ENABLED
  };
}
