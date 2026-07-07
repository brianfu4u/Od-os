/**
 * Storage abstraction. Dev uses LocalDiskStorageProvider; production swaps in object
 * storage (Tencent COS / Aliyun OSS / S3), ideally with presigned direct upload, without
 * changing callers. Inject via the STORAGE_PROVIDER token.
 */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface PutFileParams {
  tenantId: string;
  /** Storage key (unique; the caller generates it). */
  key: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface StorageProvider {
  put(params: PutFileParams): Promise<{ storageRef: string }>;
  get(storageRef: string): Promise<Buffer>;
}
