import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorageProvider } from './local-disk.provider';

/** P0-3 test (a) — local driver: upload/read/head/delete all round-trip via the StoragePort. */
describe('LocalDiskStorageProvider', () => {
  const base = mkdtempSync(join(tmpdir(), 'od-storage-'));
  const storage = new LocalDiskStorageProvider(base);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('puts, heads, reads and deletes bytes at a tenant-prefixed key', async () => {
    const key = 'tenant/t1/abc.bin';
    const bytes = Buffer.from('hello world');

    await storage.put({ storageKey: key, contentType: 'application/octet-stream', bytes });

    const head = await storage.head(key);
    expect(head).toEqual({ exists: true, size: bytes.length });
    expect((await storage.read(key)).equals(bytes)).toBe(true);

    await storage.delete(key);
    expect(await storage.head(key)).toEqual({ exists: false, size: 0 });
  });

  it('delete is idempotent (no throw when the key is already gone)', async () => {
    await expect(storage.delete('tenant/t1/missing.bin')).resolves.toBeUndefined();
  });

  it('rejects path traversal in the storage key', async () => {
    await expect(storage.head('../../etc/passwd')).rejects.toThrow(/invalid storage key/);
  });
});
