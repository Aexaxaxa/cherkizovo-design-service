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
import { getEnv } from "@/lib/env";

let s3Client: S3Client | null = null;

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
