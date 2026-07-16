import { Logger } from '@nestjs/common';
import type { StoragePort } from './storage.provider';
import { LocalDiskStorageProvider } from './local-disk.provider';
import { S3StorageProvider, s3ConfigFromEnv } from './s3.provider';

/**
 * Selects the storage backend from STORAGE_DRIVER at boot:
 *   - `local` (default): LocalDiskStorageProvider — dev/test/back-compat. NOT safe on Render's
 *     ephemeral, multi-instance filesystem.
 *   - `s3`: S3StorageProvider — AWS S3 / Tencent COS / MinIO via S3-compatible API (env-configured).
 *
 * Default stays `local` so nothing changes for existing dev/CI. Production must set STORAGE_DRIVER=s3
 * plus the STORAGE_S3_* vars (see s3ConfigFromEnv) AFTER the bucket + credentials are provisioned.
 */
export function createStorageProvider(): StoragePort {
  const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
  const log = new Logger('StorageProvider');
  if (driver === 's3') {
    const cfg = s3ConfigFromEnv();
    log.log(`storage driver: s3 (bucket=${cfg.bucket}, region=${cfg.region}, pathStyle=${cfg.forcePathStyle})`);
    return new S3StorageProvider(cfg);
  }
  log.log('storage driver: local (LocalDiskStorageProvider)');
  return new LocalDiskStorageProvider();
}
