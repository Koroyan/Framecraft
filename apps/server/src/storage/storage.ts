import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Env } from '../config/env';

export interface StorageDriver {
  readonly kind: 'local' | 's3';
  putFile(key: string, filePath: string, contentType: string): Promise<{ sizeBytes: number }>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<{ sizeBytes: number }>;
  /** Download an object to a local path (for FFmpeg processing). */
  getToFile(key: string, filePath: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  createReadStream(key: string, range?: { start: number; end?: number }): Promise<{ stream: Readable; size: number }>;
  stat(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Short-lived URL usable by the browser (and by providers when publicly reachable). */
  signedUrl(key: string, opts?: { expiresSec?: number; download?: string }): Promise<string>;
  /** Whether signed URLs are reachable from the public internet (needed to pass inputs to providers). */
  readonly publicUrls: boolean;
}

const safeKey = (key: string) => {
  if (key.includes('..') || path.isAbsolute(key) || key.startsWith('/')) throw new Error('Invalid storage key');
  return key;
};

// ------------------------------------------------------------------ local

export function signLocal(secret: string, key: string, exp: number, download?: string): string {
  return crypto.createHmac('sha256', secret).update(`${key}\n${exp}\n${download ?? ''}`).digest('base64url');
}

export function verifyLocalSignature(secret: string, key: string, exp: number, sig: string, download?: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signLocal(secret, key, exp, download));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  readonly publicUrls = false;
  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly urlPrefix = '/api/media',
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  pathFor(key: string) {
    return path.join(this.root, safeKey(key));
  }

  async putFile(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const dest = this.pathFor(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(filePath, dest);
    return { sizeBytes: (await fsp.stat(dest)).size };
  }

  async putBuffer(key: string, data: Buffer): Promise<{ sizeBytes: number }> {
    const dest = this.pathFor(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
    return { sizeBytes: data.length };
  }

  async getToFile(key: string, filePath: string) {
    await fsp.copyFile(this.pathFor(key), filePath);
  }

  async getBuffer(key: string) {
    return fsp.readFile(this.pathFor(key));
  }

  async createReadStream(key: string, range?: { start: number; end?: number }) {
    const p = this.pathFor(key);
    const { size } = await fsp.stat(p);
    return { stream: fs.createReadStream(p, range ? { start: range.start, end: range.end } : undefined), size };
  }

  async stat(key: string) {
    try {
      return { size: (await fsp.stat(this.pathFor(key))).size };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await fsp.rm(this.pathFor(key), { force: true });
  }

  async signedUrl(key: string, opts: { expiresSec?: number; download?: string } = {}) {
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresSec ?? 3600);
    const sig = signLocal(this.secret, key, exp, opts.download);
    const qs = new URLSearchParams({ exp: String(exp), sig });
    if (opts.download) qs.set('dl', opts.download);
    return `${this.urlPrefix}/${key.split('/').map(encodeURIComponent).join('/')}?${qs}`;
  }
}

// ------------------------------------------------------------------ S3 / R2 / MinIO

export class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  readonly publicUrls = true;
  private clientPromise: Promise<{
    client: import('@aws-sdk/client-s3').S3Client;
    /** Client configured with the public endpoint, used only to presign URLs. */
    signer: import('@aws-sdk/client-s3').S3Client;
    sdk: typeof import('@aws-sdk/client-s3');
    presign: typeof import('@aws-sdk/s3-request-presigner').getSignedUrl;
  }>;

  constructor(private readonly env: Env) {
    this.clientPromise = (async () => {
      const sdk = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const make = (endpoint?: string) =>
        new sdk.S3Client({
          region: env.S3_REGION,
          endpoint,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
        });
      const client = make(env.S3_ENDPOINT);
      const signer = env.S3_PUBLIC_ENDPOINT ? make(env.S3_PUBLIC_ENDPOINT) : client;
      return { client, signer, sdk, presign: getSignedUrl };
    })();
  }

  private get bucket() {
    return this.env.S3_BUCKET!;
  }

  async putFile(key: string, filePath: string, contentType: string) {
    const { client, sdk } = await this.clientPromise;
    const size = (await fsp.stat(filePath)).size;
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: fs.createReadStream(filePath), ContentType: contentType, ContentLength: size }));
    return { sizeBytes: size };
  }

  async putBuffer(key: string, data: Buffer, contentType: string) {
    const { client, sdk } = await this.clientPromise;
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, ContentType: contentType }));
    return { sizeBytes: data.length };
  }

  async getToFile(key: string, filePath: string) {
    const { stream } = await this.createReadStream(key);
    await pipeline(stream, fs.createWriteStream(filePath));
  }

  async getBuffer(key: string) {
    const { stream } = await this.createReadStream(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }

  async createReadStream(key: string, range?: { start: number; end?: number }) {
    const { client, sdk } = await this.clientPromise;
    const res = await client.send(
      new sdk.GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined }),
    );
    return { stream: res.Body as Readable, size: Number(res.ContentLength ?? 0) };
  }

  async stat(key: string) {
    const { client, sdk } = await this.clientPromise;
    try {
      const r = await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    const { client, sdk } = await this.clientPromise;
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }

  async signedUrl(key: string, opts: { expiresSec?: number; download?: string } = {}) {
    const { signer, sdk, presign } = await this.clientPromise;
    const cmd = new sdk.GetObjectCommand({
      Bucket: this.bucket,
      Key: safeKey(key),
      ResponseContentDisposition: opts.download ? `attachment; filename="${opts.download.replace(/"/g, '')}"` : undefined,
    });
    return presign(signer, cmd, { expiresIn: opts.expiresSec ?? 3600 });
  }
}

export function createStorage(env: Env): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') return new S3Storage(env);
  return new LocalStorage(path.resolve(env.STORAGE_LOCAL_DIR), env.storageSigningSecret);
}

export async function streamToFile(body: ReadableStream<Uint8Array> | null, filePath: string, maxBytes = 2 * 1024 ** 3): Promise<number> {
  if (!body) throw new Error('Empty response body');
  let total = 0;
  const node = Readable.fromWeb(body as never);
  node.on('data', (c: Buffer) => {
    total += c.length;
    if (total > maxBytes) node.destroy(new Error('Downloaded file exceeds the size limit'));
  });
  await pipeline(node, fs.createWriteStream(filePath));
  return total;
}
