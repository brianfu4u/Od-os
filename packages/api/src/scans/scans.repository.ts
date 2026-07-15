import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ScanAck, SubmitScanInput, VisitLinkStatus } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import type { SessionIdentity } from '../auth/session.types';

/** The caller has no resolvable Staff object in this tenant. */
export class NoStaffIdentityError extends Error {
  constructor() {
    super('no staff identity for the caller in this tenant');
    this.name = 'NoStaffIdentityError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolvedKey {
  patientCode: string | null;
  patientVisitId: string | null;
  visitLinkStatus: VisitLinkStatus;
}

interface ScanRow {
  id: string;
  scanned_at: string;
}

/**
 * T-05 data access for patient-contact SCANS. Runs inside withTenant() (atomic, RLS-scoped).
 *
 * The write is two-in-one and NEVER blocks a scan that has at least one key:
 *   1) INSERT an append-only patient_scans row (raw code kept verbatim; visit_id backfilled when
 *      resolvable — visit_link_status reflects resolution, NOT validity).
 *   2) INSERT an append-only `patient.scanned` event carrying the scan_id in the payload
 *      (the hard-link convention: payload jsonb references the ledger row so a future Correlator can
 *      trace the neutral contact event back to its rich scan row — zero migration).
 *
 * `code → visit_id` resolution (best-effort, tenant-scoped, RLS is the authority):
 *   - a client-supplied patientVisitId that names a real Visit/Patient object → resolved;
 *   - else a raw patientCode that IS a UUID of a real Visit/Patient object → resolved to that id;
 *   - else a raw patientCode that matches an object's business code
 *     (properties->>'code' / 'visitCode' / 'patientCode') → resolved to that object's id;
 *   - else → unresolved, and the row STILL persists (a scan is never a dead end).
 */
@Injectable()
export class ScansRepository {
  async submitScan(
    tenantId: string,
    identity: SessionIdentity | undefined,
    input: SubmitScanInput,
  ): Promise<ScanAck> {
    return withTenant(tenantId, async (c) => {
      const employeeId = await this.resolveStaffId(c, identity);
      if (!employeeId) throw new NoStaffIdentityError();

      const key = await this.resolvePatientKey(c, input);

      const inserted = await c.query<ScanRow>(
        `INSERT INTO patient_scans
           (tenant_id, employee_id, patient_code, patient_visit_id, visit_link_status,
            scanned_at, terminal_id, optional_note, optional_attachment_ids, employee_status_at_scan)
         VALUES ($1, $2, $3, $4, $5,
            COALESCE($6::timestamptz, now()), $7, $8, $9, $10)
         RETURNING id, scanned_at`,
        [
          tenantId,
          employeeId,
          key.patientCode,
          key.patientVisitId,
          key.visitLinkStatus,
          input.scannedAt ?? null,
          input.terminalId ?? null,
          input.optionalNote ?? null,
          input.optionalAttachmentIds && input.optionalAttachmentIds.length ? input.optionalAttachmentIds : null,
          await this.currentClaimedStatus(c, employeeId),
        ],
      );
      const scanId = inserted.rows[0]!.id;
      const scannedAt = inserted.rows[0]!.scanned_at;

      // Append-only NEUTRAL event, hard-linking the scan row via payload.scanId (Correlator anchor).
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
         VALUES ($1, $2, 'patient.scanned', $3::jsonb, $4)`,
        [
          tenantId,
          key.patientVisitId, // object_id is the resolved Visit when known, else NULL (nullable FK).
          JSON.stringify({
            scanId,
            patientCode: key.patientCode,
            patientVisitId: key.patientVisitId,
            visitLinkStatus: key.visitLinkStatus,
          }),
          'employee',
        ],
      );

      return {
        scanId,
        employeeId,
        patientCode: key.patientCode,
        patientVisitId: key.patientVisitId,
        visitLinkStatus: key.visitLinkStatus,
        scannedAt: new Date(scannedAt).toISOString(),
      };
    });
  }

  /** Best-effort code→visit resolution. Never throws for an unresolvable code — returns unresolved. */
  private async resolvePatientKey(c: PoolClient, input: SubmitScanInput): Promise<ResolvedKey> {
    const rawCode = typeof input.patientCode === 'string' && input.patientCode.trim() ? input.patientCode.trim() : null;
    const suppliedVisitId =
      typeof input.patientVisitId === 'string' && input.patientVisitId.trim() ? input.patientVisitId.trim() : null;

    // 1) client already gave a visit id → resolve only if it names a real Visit/Patient object.
    if (suppliedVisitId && UUID_RE.test(suppliedVisitId)) {
      const ok = await this.isVisitObject(c, suppliedVisitId);
      if (ok) return { patientCode: rawCode, patientVisitId: suppliedVisitId, visitLinkStatus: 'resolved' };
      // A supplied id that doesn't resolve: keep it as raw context but mark unresolved.
      return { patientCode: rawCode ?? suppliedVisitId, patientVisitId: null, visitLinkStatus: 'unresolved' };
    }

    // 2) raw code that is itself a UUID of a real Visit/Patient object.
    if (rawCode && UUID_RE.test(rawCode) && (await this.isVisitObject(c, rawCode))) {
      return { patientCode: rawCode, patientVisitId: rawCode, visitLinkStatus: 'resolved' };
    }

    // 3) raw code that matches an object's business code.
    if (rawCode) {
      const byCode = await c.query<{ id: string }>(
        `SELECT id FROM objects
          WHERE type IN ('Visit', 'Patient')
            AND (properties->>'code' = $1 OR properties->>'visitCode' = $1 OR properties->>'patientCode' = $1)
          LIMIT 1`,
        [rawCode],
      );
      if (byCode.rows[0]) {
        return { patientCode: rawCode, patientVisitId: byCode.rows[0].id, visitLinkStatus: 'resolved' };
      }
    }

    // 4) nothing resolved — persist raw code (or the supplied id as raw), unresolved.
    return { patientCode: rawCode ?? suppliedVisitId, patientVisitId: null, visitLinkStatus: 'unresolved' };
  }

  private async isVisitObject(c: PoolClient, id: string): Promise<boolean> {
    const res = await c.query(`SELECT 1 FROM objects WHERE id = $1 AND type IN ('Visit', 'Patient')`, [id]);
    return !!res.rows[0];
  }

  /** Snapshot the employee's currently-claimed status at scan time (optional context; may be null). */
  private async currentClaimedStatus(c: PoolClient, employeeId: string): Promise<string | null> {
    const res = await c.query<{ claimed_state: string | null }>(
      `SELECT claimed_state FROM objects WHERE id = $1 AND type = 'Staff'`,
      [employeeId],
    );
    return res.rows[0]?.claimed_state ?? null;
  }

  /** Mirror of TasksRepository.resolveStaffId — the server never trusts a client-supplied staff id. */
  private async resolveStaffId(c: PoolClient, identity: SessionIdentity | undefined): Promise<string | null> {
    if (!identity) return null;
    if (identity.staffId) {
      const ex = await c.query(`SELECT 1 FROM objects WHERE id = $1 AND type = 'Staff'`, [identity.staffId]);
      return ex.rows[0] ? identity.staffId : null;
    }
    if (identity.staffHandle) {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM objects WHERE type = 'Staff' AND properties->>'staffHandle' = $1 LIMIT 1`,
        [identity.staffHandle],
      );
      return res.rows[0]?.id ?? null;
    }
    return null;
  }
}
