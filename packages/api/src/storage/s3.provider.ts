import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import type { PutFileParams, SignedUrl, StoragePort } from './storage.provider';

/**
 * S3-compatible object storage (AWS S3 / Tencent Cloud COS / MinIO / any S3 API). Chosen over the
 * LocalDiskStorageProvider in production because Render's filesystem is ephemeral + multi-instance:
 * a local write is silently lost on the next deploy/restart and invisible to other instances. This
 * provider signs every request with AWS Signature V4 using only node:crypto + the global fetch —
 * NO extra SDK dependency — so it works against any S3-compatible endpoint by env config alone.
 *
 * Downloads are served via a native SigV4 presigned GET URL (getSignedUrl), never a public object.
 * Bucket provisioning + IAM credentials are an infra step (see PR "ops action required").
 */
export interface S3Config {
  endpoint: string; // e.g. https://cos.ap-guangzhou.myqcloud.com or http://localhost:9000
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (endpoint/bucket/key) — the compatible default (MinIO/COS). false → virtual-host. */
  forcePathStyle: boolean;
}

/** Reads + validates S3 config from env. Throws (fail-closed) when STORAGE_DRIVER=s3 but unset. */
export function s3ConfigFromEnv(): S3Config {
  const endpoint = process.env.STORAGE_S3_ENDPOINT;
  const region = process.env.STORAGE_S3_REGION;
  const bucket = process.env.STORAGE_S3_BUCKET;
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  const missing = Object.entries({ endpoint, region, bucket, accessKeyId, secretAccessKey })
    .filter(([, v]) => !v)
    .map(([k]) => `STORAGE_S3_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
  if (missing.length) {
    throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(', ')}`);
  }
  return {
    endpoint: endpoint!,
    region: region!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    forcePathStyle: (process.env.STORAGE_S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false',
  };
}

const UNSIGNED = 'UNSIGNED-PAYLOAD';

/** RFC-3986 encoding for a single path segment (S3 does not treat '/' specially inside a segment). */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
}

/** The absolute URL + Host header for a key, honoring path- vs virtual-host style. */
export function resolveEndpoint(cfg: S3Config, storageKey: string): { url: URL; host: string; canonicalUri: string } {
  const base = new URL(cfg.endpoint);
  const encodedKey = storageKey.split('/').map(encodeSegment).join('/');
  if (cfg.forcePathStyle) {
    const canonicalUri = `/${encodeSegment(cfg.bucket)}/${encodedKey}`;
    return { url: new URL(`${base.origin}${canonicalUri}`), host: base.host, canonicalUri };
  }
  const host = `${cfg.bucket}.${base.host}`;
  const canonicalUri = `/${encodedKey}`;
  return { url: new URL(`${base.protocol}//${host}${canonicalUri}`), host, canonicalUri };
}

/** Builds the SigV4 Authorization header for a header-signed request (PUT/GET/HEAD/DELETE). */
export function signRequest(
  cfg: S3Config,
  opts: { method: string; storageKey: string; payloadHash: string; contentType?: string; now?: Date },
): { url: string; headers: Record<string, string> } {
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const { url, host, canonicalUri } = resolveEndpoint(cfg, opts.storageKey);

  const baseHeaders: Record<string, string> = {
    host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) baseHeaders['content-type'] = opts.contentType;

  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${baseHeaders[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [opts.method, canonicalUri, '', canonicalHeaders, signedHeaders, opts.payloadHash].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(cfg.secretAccessKey, dateStamp, cfg.region), stringToSign).toString('hex');

  return {
    url: url.toString(),
    headers: {
      ...baseHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** Builds a SigV4 presigned GET URL (query-string signing) for a short-lived download. */
export function presignGetUrl(cfg: S3Config, storageKey: string, ttlSeconds: number, now: Date = new Date()): string {
  const { amzDate, dateStamp } = amzDates(now);
  const { url, host, canonicalUri } = resolveEndpoint(cfg, storageKey);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttlSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  // URLSearchParams sorts deterministically enough, but SigV4 requires strict key-sorted order.
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
    .join('&');

  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', UNSIGNED].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(cfg.secretAccessKey, dateStamp, cfg.region), stringToSign).toString('hex');

  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

@Injectable()
export class S3StorageProvider implements StoragePort {
  constructor(private readonly cfg: S3Config) {}

  async put(params: PutFileParams): Promise<void> {
    const signed = signRequest(this.cfg, {
      method: 'PUT',
      storageKey: params.storageKey,
      payloadHash: sha256Hex(params.bytes),
      contentType: params.contentType,
    });
    const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: params.bytes });
    if (!res.ok) throw new Error(`S3 put failed (${res.status}) for ${params.storageKey}`);
  }

  async getSignedUrl(storageKey: string, _contentType: string, ttlSeconds = 300): Promise<SignedUrl> {
    const url = presignGetUrl(this.cfg, storageKey, ttlSeconds);
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async head(storageKey: string): Promise<{ exists: boolean; size: number }> {
    const signed = signRequest(this.cfg, { method: 'HEAD', storageKey, payloadHash: sha256Hex('') });
    const res = await fetch(signed.url, { method: 'HEAD', headers: signed.headers });
    if (res.status === 404) return { exists: false, size: 0 };
    if (!res.ok) throw new Error(`S3 head failed (${res.status}) for ${storageKey}`);
    return { exists: true, size: Number(res.headers.get('content-length') ?? 0) };
  }

  async read(storageKey: string): Promise<Buffer> {
    const signed = signRequest(this.cfg, { method: 'GET', storageKey, payloadHash: sha256Hex('') });
    const res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
    if (!res.ok) throw new Error(`S3 read failed (${res.status}) for ${storageKey}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(storageKey: string): Promise<void> {
    const signed = signRequest(this.cfg, { method: 'DELETE', storageKey, payloadHash: sha256Hex('') });
    const res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
    // S3 DELETE is idempotent: 204 on success, 404 when already gone — both are fine.
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status}) for ${storageKey}`);
  }
}
