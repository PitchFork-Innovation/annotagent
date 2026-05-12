import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

const SIGNED_URL_TTL_SECONDS = 60 * 15;

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const Bucket = env.S3_BUCKET;

export async function createPresignedPutUrl(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn: SIGNED_URL_TTL_SECONDS }
  );
}

export async function createPresignedGetUrl(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket, Key: key }),
    { expiresIn: SIGNED_URL_TTL_SECONDS }
  );
}

export async function downloadObject(key: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  try {
    const { Body, ContentType } = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
    if (!Body) return null;
    const bytes = await (Body as import("@smithy/types").SdkStreamMixin).transformToByteArray();
    return { bytes: bytes.buffer as ArrayBuffer, contentType: ContentType ?? "application/pdf" };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return true;
  } catch (e) {
    const err = e as { $metadata?: { httpStatusCode?: number } };
    if (err.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

export async function uploadObject(key: string, body: ArrayBuffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: Buffer.from(body), ContentType: contentType }));
}
