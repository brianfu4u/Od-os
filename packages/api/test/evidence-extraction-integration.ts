/**
 * T-13A integration (migrations through 0022): side-store-only source reads, immutable minimized
 * audit events, atomic sensitive output, RLS, redaction fail-closed, and zero Verify/Agent effects.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { closePool } from '../src/database/pool';
import { withTenant } from '../src/database/tenant-context';
import { EvidenceExtractionRepository } from '../src/listener/evidence-extraction.repository';
import { EvidenceExtractionService } from '../src/listener/evidence-extraction.service';
import type {
  EvidenceExtractionRequestV1,
  EvidenceExtractorPort,
} from '../src/listener/evidence-extraction.types';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';

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

const output = {
  schemaVersion: 1,
  summary: '备注报告3号房已经准备。',
  extractions: [
    {
      basis: 'reported_text',
      subjectHint: '3号房',
      predicate: 'readiness_reported',
      value: true,
      polarity: 'affirmed',
      observedAt: null,
    },
  ],
  ambiguities: [],
  llmConfidence: 0.82,
};

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const sensitive = new SensitivePayloadsRepository();
  const repository = new EvidenceExtractionRepository(sensitive);
  const extractor: EvidenceExtractorPort = {
    name: 'synthetic-test',
    model: 'synthetic-v1',
    extract: async () => output,
  };
  const service = new EvidenceExtractionService(extractor, repository);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const employeeId = randomUUID();
  const scanId = randomUUID();
  const rawText = '3号房已经准备好了，请下一位患者进入';

  const request: EvidenceExtractionRequestV1 = {
    schemaVersion: 1,
    evidenceRef: { sourceTable: 'patient_scans', sourceId: scanId, field: 'optional_note' },
    modality: 'text',
    occurredAt: '2026-07-17T01:02:03Z',
    terminalId: 'ipad-front-1',
    locale: 'zh',
  };

  try {
    console.log('T-13A evidence extraction — fail closed, minimized audit, RLS:');
    await admin.query(
      `INSERT INTO objects (id, tenant_id, type, properties, claimed_state, verified_state, verification_score)
       VALUES ($1, $2, 'Staff', '{}'::jsonb, 'busy', NULL, NULL)`,
      [employeeId, tenantA],
    );
    await admin.query(
      `INSERT INTO patient_scans
         (id, tenant_id, employee_id, patient_code, scanned_at, optional_note)
       VALUES ($1, $2, $3, 'synthetic-code', now(), $4)`,
      [scanId, tenantA, employeeId, rawText],
    );
    await admin.query(
      `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content)
       VALUES ($1, 'patient_scans', $2, 'optional_note', $3)`,
      [tenantA, scanId, rawText],
    );

    const before = await admin.query<{
      claimed_state: string | null;
      verified_state: string | null;
      verification_score: string | null;
    }>(`SELECT claimed_state, verified_state, verification_score FROM objects WHERE id = $1`, [
      employeeId,
    ]);

    const result = await service.extract(tenantA, request);
    check(result.status === 'completed', 'explicit retained-text request completes');
    const eventId = result.eventId;

    const event = await withTenant(tenantA, async (client) =>
      client.query<{
        event_type: string;
        source_type: string;
        input_modality: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, source_type, input_modality, payload
           FROM event_log WHERE event_id = $1`,
        [eventId],
      ),
    );
    const eventRow = event.rows[0]!;
    check(
      eventRow.event_type === 'evidence.extraction.completed' &&
        eventRow.source_type === 'system.llm' &&
        eventRow.input_modality === 'text',
      'completed attempt is an event_log skeleton, not a verification event',
    );
    const serializedPayload = JSON.stringify(eventRow.payload);
    check(!serializedPayload.includes(rawText), 'event payload contains no raw source text');
    check(
      !/verificationResult|verificationScore|verifiedState|flowState|claimedState/i.test(
        serializedPayload,
      ),
      'event payload contains no adjudication/state fields',
    );

    const storedOutput = await withTenant(tenantA, async (client) =>
      client.query<{ content_jsonb: Record<string, unknown>; content: string | null }>(
        `SELECT content_jsonb, content FROM sensitive_payloads
          WHERE source_table = 'event_log' AND source_id = $1 AND field = 'extraction_output'`,
        [eventId],
      ),
    );
    check(
      storedOutput.rows[0]!.content === null &&
        storedOutput.rows[0]!.content_jsonb.llmConfidence === 0.82,
      'full extraction lives only in the redactable side-store',
    );

    const crossEvent = await withTenant(tenantB, async (client) =>
      client.query('SELECT event_id FROM event_log WHERE event_id = $1', [eventId]),
    );
    const crossOutput = await withTenant(tenantB, async (client) =>
      client.query('SELECT id FROM sensitive_payloads WHERE source_id = $1', [eventId]),
    );
    check(
      crossEvent.rowCount === 0 && crossOutput.rowCount === 0,
      'tenant B cannot read tenant A audit/output',
    );

    const crossRun = await service.extract(tenantB, request);
    check(
      crossRun.status === 'failed' && crossRun.errorCode === 'source_not_found',
      'tenant B cannot resolve tenant A source through the side-store',
    );

    await admin.query(
      `UPDATE sensitive_payloads SET content = NULL, content_jsonb = NULL, redacted_at = now()
        WHERE tenant_id = $1 AND source_table = 'patient_scans' AND source_id = $2
          AND field = 'optional_note'`,
      [tenantA, scanId],
    );
    const redacted = await service.extract(tenantA, request);
    check(
      redacted.status === 'failed' && redacted.errorCode === 'redacted_input',
      'redacted input fails closed without source-column fallback',
    );

    const after = await admin.query<{
      claimed_state: string | null;
      verified_state: string | null;
      verification_score: string | null;
    }>(`SELECT claimed_state, verified_state, verification_score FROM objects WHERE id = $1`, [
      employeeId,
    ]);
    check(
      JSON.stringify(after.rows[0]) === JSON.stringify(before.rows[0]),
      'claim and verification state are byte-for-byte unchanged',
    );
    const sideEffects = await admin.query<{ events: string; recommendations: string }>(
      `SELECT
         (SELECT count(*)::text FROM events WHERE tenant_id = $1) AS events,
         (SELECT count(*)::text FROM objects WHERE tenant_id = $1 AND type = 'Recommendation') AS recommendations`,
      [tenantA],
    );
    check(
      sideEffects.rows[0]!.events === '0' && sideEffects.rows[0]!.recommendations === '0',
      'no DomainEventBus-backed event, Agent, or Recommendation side effect is persisted',
    );

    await rejects(
      admin.query(`UPDATE event_log SET seq = 1 WHERE event_id = $1`, [eventId]),
      'completed extraction event is append-only',
    );
    await rejects(
      admin.query(`DELETE FROM event_log WHERE event_id = $1`, [eventId]),
      'completed extraction event cannot be deleted',
    );

    const failingSensitive = {
      readLivePayloadState: sensitive.readLivePayloadState.bind(sensitive),
      mirrorJson: async () => {
        throw new Error('synthetic side-store failure');
      },
    } as unknown as SensitivePayloadsRepository;
    const atomicRepo = new EvidenceExtractionRepository(failingSensitive);
    await rejects(
      atomicRepo.appendCompleted(tenantA, request, extractor, output as never),
      'side-store failure rejects the completed append',
    );
    const atomicCheck = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_log
        WHERE tenant_id = $1 AND event_type = 'evidence.extraction.completed'`,
      [tenantA],
    );
    check(atomicCheck.rows[0]!.n === '1', 'failed side-store write rolls back its event skeleton');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(
    `\n${failed === 0 ? '✔' : '✖'} T-13A evidence extraction — ${passed} passed, ${failed} failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
