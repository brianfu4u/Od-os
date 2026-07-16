/**
 * Storage abstraction (StoragePort). Dev = LocalDiskStorageProvider; production swaps in
 * Tencent Cloud COS (China + WeChat), MinIO, or S3 — env-selected, no logic change.
 * Bytes NEVER go into Postgres, and downloads are ONLY via short-lived signed URLs.
 */
export const STORAGE_PORT = 'STORAGE_PORT';

export interface PutFileParams {
  /** Tenant-prefixed key: tenant/<tenantId>/<uuid><ext>. */
  storageKey: string;
  contentType: string;
  bytes: Buffer;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface StoragePort {
  put(params: PutFileParams): Promise<void>;
  /** Mints a short-lived signed download URL (called only after an RLS check). */
  getSignedUrl(storageKey: string, contentType: string, ttlSeconds?: number): Promise<SignedUrl>;
  head(storageKey: string): Promise<{ exists: boolean; size: number }>;
  /** Reads bytes back (used by the dev signed-content route; prod serves direct from COS). */
  read(storageKey: string): Promise<Buffer>;
  /** Deletes the stored object. A no-op (resolves) when the key does not exist (idempotent). */
  delete(storageKey: string): Promise<void>;
}
