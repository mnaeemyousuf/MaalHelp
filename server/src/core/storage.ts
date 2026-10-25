import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../config/env';

/** Object storage abstraction: local disk for development, any S3-compatible service in production. */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements StorageDriver {
  private readonly root = resolve(env.STORAGE_DIR);
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
}

class S3Storage implements StorageDriver {
  private clientPromise = (async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: Boolean(env.S3_ENDPOINT),
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' },
    });
  })();
  async put(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.clientPromise).send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
}

export const storage: StorageDriver = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();

/** Allowed upload types, verified by magic bytes — not by the client-supplied MIME type. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'application/zip'; // xlsx
  // Plain text / CSV: no NUL bytes in the first 4 KB
  if (!buf.subarray(0, 4096).includes(0)) return 'text/plain';
  return null;
}
