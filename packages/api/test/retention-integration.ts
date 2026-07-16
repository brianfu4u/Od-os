/**
 * P1-6-b · retention population + sweep (embedded Postgres).
 *
 * Proves:
 *   - population mirrors raw content into sensitive_payloads (text + jsonb), skipping null/empty;
 *   - the sweep redacts LIVE payloads older than the configured window, leaves younger ones,
 *     is idempotent, and is tenant-scoped (RLS) — one tenant's sweep never touches another's;
 *   - the sweep uses the 0020 redact-only primitive (content nulled, redacted_at stamped) and
 *     NEVER deletes a row (the audit fact of prior existence survives);
 *   - the append-only skeleton is untouched (this test writes only into the side-store).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

/** Count live (un-redacted) payloads for a tenant, RLS-scoped. */
async function liveCount(tenant: string): Promise<number> {
  return withTenant(tenant, async (c) => {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM sensitive_payloads WHERE redacted_at IS NULL`,
    );
    return Number(r.rows[0]!.n);
  });
}

/** Total payloads (live + redacted) for a tenant — proves rows are NEVER deleted. */
async function totalCount(tenant: string): Promise<number> {
  return withTenant(tenant, async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::int AS n FROM sensitive_payloads`);
    return Number(r.rows[0]!.n);
  });
}

/** Insert a payload with an explicit created_at (to simulate age), as owner, honoring RLS via tenant col. */
async function seedPayload(
  admin: Client,
  tenant: string,
  sourceId: string,
  field: string,
  content: string,
  ageDays: number,
): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content, created_at)
     VALUES ($1, 'llm_analysis_log', $2, $3, $4, now() - make_interval(days => $5))
     RETURNING id`,
    [tenant, sourceId, field, content, ageDays],
  );
  return r.rows[0]!.id;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new SensitivePayloadsRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('P1-6-b retention — population + sweep:');

    // ── population: mirrorText / mirrorJson inside a tenant transaction ──
    const srcId = randomUUID();
    await withTenant(A, async (c) => {
      await repo.mirrorText(c, A, 'patient_scans', srcId, 'patient_code', 'PT-RAW-001');
      await repo.mirrorText(c, A, 'patient_scans', srcId, 'optional_note', ''); // empty → skipped
      await repo.mirrorText(c, A, 'patient_scans', srcId, 'optional_note', null); // null → skipped
      await repo.mirrorJson(c, A, 'llm_analysis_log', srcId, 'output', { summary: 'x', claim: null });
      await repo.mirrorJson(c, A, 'llm_analysis_log', srcId, 'output', undefined); // undefined → skipped
    });
    check((await liveCount(A)) === 2, 'population: text + jsonb mirrored; null/empty skipped (2 live)');

    const stored = await withTenant(A, async (c) =>
      c.query<{ field: string; content: string | null; content_jsonb: unknown }>(
        `SELECT field, content, content_jsonb FROM sensitive_payloads WHERE source_id = $1 ORDER BY field`,
        [srcId],
      ),
    );
    check(
      stored.rows.some((r) => r.field === 'patient_code' && r.content === 'PT-RAW-001'),
      'population: raw patient_code content stored verbatim (live)',
    );
    check(
      stored.rows.some((r) => r.field === 'output' && r.content_jsonb !== null),
      'population: jsonb analysis stored in content_jsonb (live)',
    );

    // ── sweep window boundary: seed one OLD (40d) and one YOUNG (5d) payload; default window = 30d ──
    const oldId = await seedPayload(admin, A, randomUUID(), 'input', 'OLD-RAW', 40);
    const youngId = await seedPayload(admin, A, randomUUID(), 'input', 'YOUNG-RAW', 5);
    const liveBefore = await liveCount(A);

    const res1 = await repo.sweep(A, { RETENTION_RAW_CONTENT_DAYS: '30' });
    check(res1.redacted >= 1, `sweep redacted the >30d payload(s) (redacted=${res1.redacted})`);
    check((await liveCount(A)) === liveBefore - res1.redacted, 'sweep: live count drops by exactly redacted count');

    const oldRow = await withTenant(A, async (c) =>
      c.query<{ content: string | null; redacted_at: string | null }>(
        `SELECT content, redacted_at FROM sensitive_payloads WHERE id = $1`,
        [oldId],
      ),
    );
    check(oldRow.rows[0]!.content === null && oldRow.rows[0]!.redacted_at !== null,
      'sweep: old payload content nulled + redacted_at stamped (redact-only primitive)');

    const youngRow = await withTenant(A, async (c) =>
      c.query<{ content: string | null; redacted_at: string | null }>(
        `SELECT content, redacted_at FROM sensitive_payloads WHERE id = $1`,
        [youngId],
      ),
    );
    check(youngRow.rows[0]!.content === 'YOUNG-RAW' && youngRow.rows[0]!.redacted_at === null,
      'sweep: young (<30d) payload left intact');

    // ── idempotency: a second sweep redacts nothing new ──
    const res2 = await repo.sweep(A, { RETENTION_RAW_CONTENT_DAYS: '30' });
    check(res2.redacted === 0, 're-sweep is idempotent (0 newly redacted)');

    // ── rows are NEVER deleted — total count unchanged after redaction ──
    const totalA = await totalCount(A);
    check(totalA >= 4, `sweep never deletes rows — total payloads retained (total=${totalA})`);

    // ── tenant isolation: B seeds an old payload; A's sweep must NOT touch it ──
    await seedPayload(admin, B, randomUUID(), 'input', 'B-OLD-RAW', 40);
    const bLiveBefore = await liveCount(B);
    await repo.sweep(A, { RETENTION_RAW_CONTENT_DAYS: '30' }); // sweep tenant A again
    check((await liveCount(B)) === bLiveBefore, "tenant A's sweep does not redact tenant B's payloads (RLS)");

    const bRes = await repo.sweep(B, { RETENTION_RAW_CONTENT_DAYS: '30' });
    check(bRes.redacted === 1, "tenant B's own sweep redacts ITS old payload (isolated)");
  } finally {
    // The redact-only trigger blocks DELETE even for the owner; bypass it ONLY for test cleanup by
    // temporarily disabling triggers (owner/superuser), then restore. Matches the rls-isolation
    // cleanup pattern for this table.
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query(`DELETE FROM sensitive_payloads WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await admin.query("SET session_replication_role = 'origin'");
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} retention integration: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

void main();
