import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

export const s3Client = new S3Client({
  endpoint: env.B2_S3_ENDPOINT,
  region: env.B2_S3_REGION,
  credentials: {
    accessKeyId: env.B2_ACCESS_KEY_ID,
    secretAccessKey: env.B2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

export async function putObject(input: Omit<PutObjectCommandInput, "Bucket">) {
  return s3Client.send(
    new PutObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      ...input
    })
  );
}

export async function getObject(key: string) {
  return s3Client.send(
    new GetObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key
    })
  );
}

export async function getSignedGetUrl(key: string) {
  const command = new GetObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(s3Client, command, {
    expiresIn: env.SIGNED_URL_EXPIRES_SEC
  });
}
