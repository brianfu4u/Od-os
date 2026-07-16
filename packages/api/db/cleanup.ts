/**
 * P0-3 sub-issue 4: retention cleanup entrypoint. Purges the stored BYTES of evidence older than
 * FILE_RETENTION_DAYS (default 90) and marks each object purged (row + audit kept). Runnable on a
 * schedule by ops (e.g. a Render Cron Job): `pnpm --filter @clearview/api cleanup`.
 *
 * Uses the OWNER connection (DATABASE_URL) deliberately: the sweep is cross-tenant, which the
 * RLS-bound runtime role (clearview_login) cannot do — mirroring migrate/seed, which are also
 * owner-role maintenance tasks. The bytes are removed through the SAME StoragePort the app uses
 * (STORAGE_DRIVER=local|s3), so this works for local disk and S3/COS alike.
 */
import { Client } from 'pg';
import { clientConfig } from './env';
import { createStorageProvider } from '../src/storage/storage.factory';
import { StorageCleanupService, type CleanupStore, type ExpiredEvidence } from '../src/storage/storage-cleanup.service';
import { retentionDays } from '../src/storage/retention';

async function main(): Promise<void> {
  const client = new Client(clientConfig());
  await client.connect();
  try {
    const store: CleanupStore = {
      async listExpired(cutoff: string): Promise<ExpiredEvidence[]> {
        const res = await client.query<{ id: string; tenant_id: string; storage_key: string }>(
          `SELECT id, tenant_id, properties->>'storageKey' AS storage_key
             FROM objects
            WHERE type IN ('Snapshot','Document')
              AND properties->>'storageKey' IS NOT NULL
              AND COALESCE(properties->>'purged','') <> 'true'
              AND created_at < $1`,
          [cutoff],
        );
        return res.rows.map((r) => ({ tenantId: r.tenant_id, objectId: r.id, storageKey: r.storage_key }));
      },
      async markPurged(_tenantId: string, objectId: string, purgedAtIso: string): Promise<void> {
        await client.query(
          `UPDATE objects
              SET properties = properties || jsonb_build_object('purged', true, 'purgedAt', $2::text)
            WHERE id = $1`,
          [objectId, purgedAtIso],
        );
      },
    };

    const svc = new StorageCleanupService(createStorageProvider(), store, retentionDays());
    const result = await svc.run();
    console.log(`✔ cleanup complete — scanned ${result.scanned}, purged ${result.deleted}, errors ${result.errors}.`);
    process.exit(result.errors === 0 ? 0 : 1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
