import { Logger } from '@nestjs/common';
import type { StoragePort } from './storage.provider';
import { cutoffIso, retentionDays } from './retention';

/** An evidence object whose stored bytes are past the retention window and should be purged. */
export interface ExpiredEvidence {
  tenantId: string;
  objectId: string;
  storageKey: string;
}

/**
 * Data access the cleanup needs, abstracted so it can run either as an owner-role maintenance script
 * (cross-tenant sweep — see db/cleanup.ts) or against a fake in unit tests. `listExpired` returns
 * only rows created before `cutoffIso` that still have bytes (not already purged).
 */
export interface CleanupStore {
  listExpired(cutoffIso: string): Promise<ExpiredEvidence[]>;
  markPurged(tenantId: string, objectId: string, purgedAtIso: string): Promise<void>;
}

/**
 * Portable, provider-agnostic retention cleanup: deletes the STORED BYTES of expired evidence via the
 * StoragePort (local disk or S3/COS) and marks the object purged (the row + audit trail are kept). A
 * per-file failure is logged and skipped — one bad key never aborts the whole sweep.
 */
export class StorageCleanupService {
  private readonly logger = new Logger(StorageCleanupService.name);

  constructor(
    private readonly storage: StoragePort,
    private readonly store: CleanupStore,
    private readonly days: number = retentionDays(),
  ) {}

  async run(now: Date = new Date()): Promise<{ scanned: number; deleted: number; errors: number }> {
    const cutoff = cutoffIso(now, this.days);
    const expired = await this.store.listExpired(cutoff);
    let deleted = 0;
    let errors = 0;
    for (const e of expired) {
      try {
        await this.storage.delete(e.storageKey);
        await this.store.markPurged(e.tenantId, e.objectId, now.toISOString());
        deleted += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn(`cleanup failed for ${e.storageKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`retention cleanup: scanned=${expired.length} deleted=${deleted} errors=${errors} (>${this.days}d)`);
    return { scanned: expired.length, deleted, errors };
  }
}
