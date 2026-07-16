/**
 * T-16 integration (requires migrations through 0022): immutable event_log + RLS + minimized photo
 * payload. Storage behavior is covered by PhotoEvidenceService unit tests; this file exercises the
 * actual database defenses under clearview_app and the migration owner.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { closePool } from '../src/database/pool';
import { withTenant } from '../src/database/tenant-context';
import { EventLogRepository } from '../src/evidence/event-log.repository';

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function rejects(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    failed += 1;
    console.error(`  ✗ ${label} (expected rejection)`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new EventLogRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const sha256 = 'a'.repeat(64);

  try {
    console.log('T-16 event_log — neutral payload, append-only, RLS:');
    const event = await repo.appendPhoto(tenantA, {
      terminalId: 'ipad-front-1',
      sourceType: 'staff.terminal',
      seq: 17,
      occurredAt: '2026-07-16T03:00:00.000Z',
      subjectHints: { staffId: randomUUID() },
      payload: {
        storageKey: `tenant/${tenantA}/event-log/${randomUUID()}.jpg`,
        sha256,
        mime: 'image/jpeg',
        size: 12345,
      },
    });
    check(
      event.eventType === 'evidence.photo.received' && event.seq === 17,
      'append returns a neutral photo receipt',
    );

    const own = await withTenant(tenantA, async (client) =>
      client.query<{
        tenant_id: string;
        store_id: string;
        event_type: string;
        input_modality: string;
        payload: Record<string, unknown>;
        schema_version: number;
      }>(
        'SELECT tenant_id, store_id, event_type, input_modality, payload, schema_version FROM event_log WHERE event_id = $1',
        [event.eventId],
      ),
    );
    const row = own.rows[0]!;
    check(
      row.tenant_id === tenantA && row.store_id === tenantA,
      'tenant/store ids are server-bound to the same clinic',
    );
    check(
      row.event_type === 'evidence.photo.received' && row.input_modality === 'photo',
      'row records intake only',
    );
    check(row.schema_version === 1, 'schema_version is persisted');
    check(
      JSON.stringify(Object.keys(row.payload).sort()) ===
        JSON.stringify(['mime', 'sha256', 'size', 'storageKey']),
      'payload contains only pointer/hash/MIME/size (no binary or raw text)',
    );

    const cross = await withTenant(tenantB, async (client) =>
      client.query('SELECT event_id FROM event_log WHERE event_id = $1', [event.eventId]),
    );
    check(cross.rowCount === 0, 'tenant B cannot read tenant A event (RLS)');

    await rejects(
      withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO event_log (
             tenant_id, store_id, event_type, source_type, occurred_at, input_modality, payload
           ) VALUES ($1, $1, 'evidence.photo.received', 'staff.terminal', now(), 'photo', $2::jsonb)`,
          [
            tenantA,
            JSON.stringify({
              storageKey: `tenant/${tenantA}/event-log/${randomUUID()}.jpg`,
              sha256,
              mime: 'image/jpeg',
              size: 1,
              base64: '/9j/secret',
            }),
          ],
        );
      }),
      'DB rejects extra photo payload fields such as base64',
    );

    await rejects(
      admin.query(`UPDATE event_log SET seq = 18 WHERE event_id = $1`, [event.eventId]),
      'forbid_mutation trigger rejects UPDATE even for the migration owner',
    );
    await rejects(
      admin.query(`DELETE FROM event_log WHERE event_id = $1`, [event.eventId]),
      'forbid_mutation trigger rejects DELETE even for the migration owner',
    );

    const defenses = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              has_table_privilege('clearview_app', 'event_log', 'UPDATE') AS can_update,
              has_table_privilege('clearview_app', 'event_log', 'DELETE') AS can_delete
         FROM pg_class c WHERE c.oid = 'event_log'::regclass`,
    );
    check(
      defenses.rows[0]!.relrowsecurity && defenses.rows[0]!.relforcerowsecurity,
      'RLS and FORCE RLS are enabled',
    );
    check(
      !defenses.rows[0]!.can_update && !defenses.rows[0]!.can_delete,
      'app role has no UPDATE/DELETE grants',
    );

    const stillThere = await admin.query<{ seq: string }>(
      'SELECT seq FROM event_log WHERE event_id = $1',
      [event.eventId],
    );
    check(stillThere.rows[0]!.seq === '17', 'blocked mutations left the immutable row unchanged');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} T-16 event_log — ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
