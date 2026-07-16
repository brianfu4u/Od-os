import { describe, expect, it } from 'vitest';
import { StorageCleanupService, type CleanupStore, type ExpiredEvidence } from './storage-cleanup.service';
import { cutoffIso, isExpired } from './retention';
import type { StoragePort } from './storage.provider';

/**
 * P0-3 test (d): retention cleanup purges ONLY files older than the window and leaves newer ones. The
 * fake store filters by the real cutoff (via isExpired), and the fake StoragePort records which keys
 * were actually deleted + which objects were marked purged.
 */
const NOW = new Date('2026-07-16T00:00:00.000Z');
const DAYS = 90;

interface Item { objectId: string; storageKey: string; createdAt: string; purged?: boolean }

function makeStore(items: Item[]): { store: CleanupStore; items: Item[] } {
  const store: CleanupStore = {
    async listExpired(cutoff: string): Promise<ExpiredEvidence[]> {
      return items
        .filter((i) => !i.purged && new Date(i.createdAt).toISOString() < cutoff)
        .map((i) => ({ tenantId: 't1', objectId: i.objectId, storageKey: i.storageKey }));
    },
    async markPurged(_t: string, objectId: string): Promise<void> {
      const i = items.find((x) => x.objectId === objectId);
      if (i) i.purged = true;
    },
  };
  return { store, items };
}

function makeStorage(): { storage: StoragePort; deleted: string[] } {
  const deleted: string[] = [];
  const storage = { delete: async (key: string) => { deleted.push(key); } } as unknown as StoragePort;
  return { storage, deleted };
}

describe('retention helpers', () => {
  it('isExpired is true only strictly before the cutoff', () => {
    expect(isExpired('2026-01-01T00:00:00Z', NOW, DAYS)).toBe(true); // ~196d old
    expect(isExpired('2026-07-10T00:00:00Z', NOW, DAYS)).toBe(false); // 6d old
    expect(isExpired(NOW, NOW, DAYS)).toBe(false);
  });
  it('cutoffIso is now minus the window', () => {
    expect(cutoffIso(NOW, DAYS)).toBe('2026-04-17T00:00:00.000Z');
  });
});

describe('StorageCleanupService', () => {
  it('deletes only expired files and marks them purged, leaving newer ones', async () => {
    const old1: Item = { objectId: 'old-1', storageKey: 'tenant/t1/old-1.png', createdAt: '2026-01-01T00:00:00Z' };
    const old2: Item = { objectId: 'old-2', storageKey: 'tenant/t1/old-2.m4a', createdAt: '2026-02-01T00:00:00Z' };
    const fresh: Item = { objectId: 'new-1', storageKey: 'tenant/t1/new-1.png', createdAt: '2026-07-10T00:00:00Z' };
    const { store, items } = makeStore([old1, old2, fresh]);
    const { storage, deleted } = makeStorage();

    const result = await new StorageCleanupService(storage, store, DAYS).run(NOW);

    expect(result).toEqual({ scanned: 2, deleted: 2, errors: 0 });
    expect(deleted.sort()).toEqual(['tenant/t1/old-1.png', 'tenant/t1/old-2.m4a']);
    expect(items.find((i) => i.objectId === 'old-1')!.purged).toBe(true);
    expect(items.find((i) => i.objectId === 'new-1')!.purged).toBeUndefined();
  });

  it('counts per-file failures without aborting the sweep', async () => {
    const { store } = makeStore([
      { objectId: 'a', storageKey: 'boom', createdAt: '2026-01-01T00:00:00Z' },
      { objectId: 'b', storageKey: 'ok', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const deleted: string[] = [];
    const storage = {
      delete: async (key: string) => {
        if (key === 'boom') throw new Error('backend error');
        deleted.push(key);
      },
    } as unknown as StoragePort;

    const result = await new StorageCleanupService(storage, store, DAYS).run(NOW);
    expect(result).toEqual({ scanned: 2, deleted: 1, errors: 1 });
    expect(deleted).toEqual(['ok']);
  });

  it('is a no-op when nothing is expired', async () => {
    const { store } = makeStore([{ objectId: 'new', storageKey: 'k', createdAt: '2026-07-15T00:00:00Z' }]);
    const { storage, deleted } = makeStorage();
    const result = await new StorageCleanupService(storage, store, DAYS).run(NOW);
    expect(result).toEqual({ scanned: 0, deleted: 0, errors: 0 });
    expect(deleted).toEqual([]);
  });
});
