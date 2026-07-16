/**
 * P1-6-d · E-1 backfill + read-path closure (embedded Postgres).
 *
 * Proves:
 *   - the idempotent backfill script mirrors EXISTING source-column sensitive content into the
 *     redactable side-store (sensitive_payloads) for rows that have NO mirror yet;
 *   - it inherits created_at from the SOURCE row (so already-expired history is swept next run,
 *     not given a fresh lease);
 *   - it is IDEMPOTENT: a second run inserts NOTHING new, and it does NOT duplicate rows that were
 *     already dual-written by P1-6-b;
 *   - it NEVER touches the append-only source tables (patient_scans / llm_analysis_log stay byte-identical);
 *   - the /listen/summary read path (gatherAnalyses) resolves input text from the side-store LIVE copy
 *     and returns NO text once that copy is redacted (D-choice-1 read-path closure, KI-001), even though
 *     the plaintext still physically exists in llm_analysis_log.input.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { LlmListenerRepository } from '../src/listener/listener.repository';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

/** Run the backfill SQL directly against the test DB (mirrors what `pnpm db:backfill` runs). */
async function runBackfill(admin: Client): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(resolve(process.cwd(), 'db', 'backfill', '0001_backfill_sensitive_payloads.sql'), 'utf8');
  await admin.query(sql);
}

function mirrorCount(admin: Client, tenant: string, table: string, id: string, field: string): Promise<number> {
  return admin
    .query<{ n: string }>(
      `SELECT count(*)::int AS n FROM sensitive_payloads
        WHERE tenant_id=$1 AND source_table=$2 AND source_id=$3 AND field=$4`,
      [tenant, table, id, field],
    )
    .then((r) => Number(r.rows[0]!.n));
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const T = randomUUID();
  const emp = randomUUID();

  try {
    console.log('P1-6-d backfill + read-path closure:');

    // A staff object (FK target for patient_scans.employee_id).
    const staffRow = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Staff','{}'::jsonb) RETURNING id`,
      [T],
    );
    const staff = staffRow.rows[0]!.id;

    // ── HISTORICAL rows written BEFORE dual-write: source column set, NO side-store mirror. ──
    // An "old" scan (40 days ago) whose code should be swept on the very next sweep after backfill.
    const oldScan = await admin.query<{ id: string }>(
      `INSERT INTO patient_scans (tenant_id, employee_id, patient_code, optional_note, scanned_at, created_at)
       VALUES ($1,$2,'PT-OLD-1','note-old', now() - interval '40 days', now() - interval '40 days') RETURNING id`,
      [T, staff],
    );
    const oldScanId = oldScan.rows[0]!.id;
    // An LLM log with input (recent).
    const oldLog = await admin.query<{ id: string }>(
      `INSERT INTO llm_analysis_log (tenant_id, listener, prompt_version, applied_action, input, output, created_at)
       VALUES ($1,'heuristic','listen.analyze/v1','cues_only','patient said their eye hurts','{"a":1}'::jsonb, now() - interval '2 days') RETURNING id`,
      [T],
    );
    const oldLogId = oldLog.rows[0]!.id;

    // ── An ALREADY dual-written row (P1-6-b): source col + a live mirror already present. ──
    const newScan = await admin.query<{ id: string }>(
      `INSERT INTO patient_scans (tenant_id, employee_id, patient_code, scanned_at)
       VALUES ($1,$2,'PT-NEW-9', now()) RETURNING id`,
      [T, staff],
    );
    const newScanId = newScan.rows[0]!.id;
    await admin.query(
      `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content)
       VALUES ($1,'patient_scans',$2,'patient_code','PT-NEW-9')`,
      [T, newScanId],
    );

    check((await mirrorCount(admin, T, 'patient_scans', oldScanId, 'patient_code')) === 0, 'pre: historical scan has NO mirror yet');
    check((await mirrorCount(admin, T, 'patient_scans', newScanId, 'patient_code')) === 1, 'pre: already dual-written scan has 1 mirror');

    // ── run #1 ──
    await runBackfill(admin);
    check((await mirrorCount(admin, T, 'patient_scans', oldScanId, 'patient_code')) === 1, 'backfill: historical scan code now mirrored');
    check((await mirrorCount(admin, T, 'patient_scans', oldScanId, 'optional_note')) === 1, 'backfill: historical optional_note now mirrored');
    check((await mirrorCount(admin, T, 'llm_analysis_log', oldLogId, 'input')) === 1, 'backfill: historical llm input now mirrored');
    check((await mirrorCount(admin, T, 'llm_analysis_log', oldLogId, 'output')) === 1, 'backfill: historical llm output (jsonb) now mirrored');
    check((await mirrorCount(admin, T, 'patient_scans', newScanId, 'patient_code')) === 1, 'backfill: already dual-written row is NOT duplicated (still 1)');

    // created_at inherited from the source row (so old data is immediately sweep-eligible).
    const inherited = await admin.query<{ created_at: string }>(
      `SELECT created_at FROM sensitive_payloads WHERE tenant_id=$1 AND source_table='patient_scans' AND source_id=$2 AND field='patient_code'`,
      [T, oldScanId],
    );
    const ageDays = (Date.now() - new Date(inherited.rows[0]!.created_at).getTime()) / 86_400_000;
    check(ageDays > 39, `backfill: created_at inherited from source row (~40d old, got ${ageDays.toFixed(1)}d)`);

    // ── idempotence: run #2 inserts nothing new ──
    const before = await admin.query<{ n: string }>(`SELECT count(*)::int AS n FROM sensitive_payloads WHERE tenant_id=$1`, [T]);
    await runBackfill(admin);
    const after = await admin.query<{ n: string }>(`SELECT count(*)::int AS n FROM sensitive_payloads WHERE tenant_id=$1`, [T]);
    check(before.rows[0]!.n === after.rows[0]!.n, `idempotent: re-run adds nothing (${before.rows[0]!.n} → ${after.rows[0]!.n})`);

    // ── append-only source tables untouched by backfill ──
    const src = await admin.query<{ patient_code: string; note: string | null }>(
      `SELECT patient_code, optional_note AS note FROM patient_scans WHERE id=$1`, [oldScanId],
    );
    check(src.rows[0]!.patient_code === 'PT-OLD-1' && src.rows[0]!.note === 'note-old', 'backfill: source columns are byte-identical (append-only untouched)');

    // ── read-path closure: /listen/summary resolves input from side-store; redacted → no text ──
    const listenRepo = new LlmListenerRepository(new SensitivePayloadsRepository());
    const live = await listenRepo.gatherAnalyses(T, 72);
    const liveHit = live.find((e) => e.text === 'patient said their eye hurts');
    check(!!liveHit, 'summary: live input text resolves via the side-store LATERAL join');

    // redact the side-store copy (as the sweep does); source column stays plaintext.
    await admin.query(
      `UPDATE sensitive_payloads SET content=NULL, redacted_at=now()
        WHERE tenant_id=$1 AND source_table='llm_analysis_log' AND source_id=$2 AND field='input'`,
      [T, oldLogId],
    );
    const afterRedact = await listenRepo.gatherAnalyses(T, 72);
    const redEntry = afterRedact.find((e) => e.at && new Date(e.at).getTime() === new Date((live.find((x) => x.text === 'patient said their eye hurts')!).at).getTime());
    check(redEntry?.text === undefined, 'summary: redacted side-store copy → NO input text surfaced (D-choice-1)');
    check(!JSON.stringify(afterRedact).includes('patient said their eye hurts'), 'summary: source-column plaintext never leaks after redaction (KI-001)');
    const srcLog = await admin.query<{ input: string | null }>(`SELECT input FROM llm_analysis_log WHERE id=$1`, [oldLogId]);
    check(srcLog.rows[0]!.input === 'patient said their eye hurts', 'KI-001: llm source column plaintext intentionally still present but unreachable via API');
  } finally {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query(`DELETE FROM sensitive_payloads WHERE tenant_id=$1`, [T]);
    await admin.query(`DELETE FROM llm_analysis_log WHERE tenant_id=$1`, [T]);
    await admin.query(`DELETE FROM patient_scans WHERE tenant_id=$1`, [T]);
    await admin.query(`DELETE FROM objects WHERE tenant_id=$1`, [T]);
    await admin.query("SET session_replication_role = 'origin'");
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} backfill integration: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

void main();
