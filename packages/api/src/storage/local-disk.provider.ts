import { Injectable } from '@nestjs/common';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { PutFileParams, StorageProvider } from './storage.provider';

/**
 * DEV storage: writes bytes under UPLOAD_DIR (default ./var/uploads/<tenant>/<key><ext>).
 * NOT for production — swap in an object-storage provider (COS/OSS/S3) with presigned
 * uploads. Kept behind the StorageProvider interface so callers don't change.
 */
@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir ?? process.env.UPLOAD_DIR ?? join(process.cwd(), 'var', 'uploads'));
  }

  async put(params: PutFileParams): Promise<{ storageRef: string }> {
    const ext = extname(params.filename) || '';
    const rel = join(params.tenantId, `${params.key}${ext}`);
    const abs = join(this.baseDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, params.bytes);
    return { storageRef: `local:${rel}` };
  }

  async get(storageRef: string): Promise<Buffer> {
    const rel = storageRef.replace(/^local:/, '');
    return readFileSync(join(this.baseDir, rel));
  }
}
