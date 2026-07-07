import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PutFileParams, SignedUrl, StoragePort } from './storage.provider';
import { signContentUrl } from './url-signing';

/**
 * DEV storage: writes bytes under UPLOAD_DIR/<storageKey>. NOT for production — swap in an
 * object-storage StoragePort (Tencent COS / MinIO / S3) with native presigned URLs. Downloads
 * are served only through signed URLs (see url-signing), never a public path.
 */
@Injectable()
export class LocalDiskStorageProvider implements StoragePort {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir ?? process.env.UPLOAD_DIR ?? join(process.cwd(), 'var', 'uploads'));
  }

  private absolute(storageKey: string): string {
    if (storageKey.includes('..')) throw new Error('invalid storage key');
    return join(this.baseDir, storageKey);
  }

  async put(params: PutFileParams): Promise<void> {
    const abs = this.absolute(params.storageKey);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, params.bytes);
  }

  async getSignedUrl(storageKey: string, contentType: string, ttlSeconds = 300): Promise<SignedUrl> {
    return signContentUrl(storageKey, contentType, ttlSeconds);
  }

  async head(storageKey: string): Promise<{ exists: boolean; size: number }> {
    const abs = this.absolute(storageKey);
    if (!existsSync(abs)) return { exists: false, size: 0 };
    return { exists: true, size: statSync(abs).size };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFileSync(this.absolute(storageKey));
  }
}
