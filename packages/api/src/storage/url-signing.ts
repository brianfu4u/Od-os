import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC signing for dev signed-download URLs. Prod (COS/S3) uses the provider's native
 * presigned URLs instead; this keeps the dev LocalDiskStorageProvider honest about the
 * "download only via short-lived signed URL" contract.
 */
function secret(): string {
  return process.env.UPLOAD_URL_SECRET ?? 'dev-insecure-upload-secret-change-me';
}

export function signContentUrl(
  storageKey: string,
  contentType: string,
  ttlSeconds = 300,
  now: number = Date.now(),
): { url: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac('sha256', secret()).update(`${storageKey}:${contentType}:${exp}`).digest('hex');
  const q = new URLSearchParams({ key: storageKey, ct: contentType, exp: String(exp), sig });
  return { url: `/uploads/content?${q.toString()}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyContentSig(
  storageKey: string,
  contentType: string,
  exp: number,
  sig: string,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = createHmac('sha256', secret()).update(`${storageKey}:${contentType}:${exp}`).digest('hex');
  if (typeof sig !== 'string' || sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
