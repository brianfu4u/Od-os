import { Injectable } from '@nestjs/common';
import type { EvidenceItem, EvidenceType, TriggerReason, VerificationResult } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { getSopConfig } from './sop-config';
import type { Scorer, ScoreInput } from './scorer';

/** Per-type evidence strength in [0,1] (weight × sourceTrust, pre-recency). QR highest. */
const STRENGTH: Record<EvidenceType, number> = {
  qr_scan: 0.85,
  snapshot: 0.71,
  document: 0.55,
  communication: 0.35,
  cross_object: 0.6,
  timing: 0,
};

interface ObjRow {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  claimed_state: string | null;
  verified_state: string | null;
}

export interface VerifyOutcome {
  objectId: string;
  objectType: string;
  result: VerificationResult;
  alertId: string | null;
}

function evidence(type: EvidenceType, supports: boolean, ref: string, detail: string): EvidenceItem {
  return { type, supports, strength: STRENGTH[type] ?? 0.3, detail, ref };
}

@Injectable()
export class VerificationRepository {
  /** Gather evidence, score, and persist (object + ledger + alert + events) in one tenant tx. */
  async verify(tenantId: string, objectId: string, scorer: Scorer): Promise<VerifyOutcome | null> {
    return withTenant(tenantId, async (c) => {
      const objRes = await c.query<ObjRow>(
        `SELECT id, type, properties, claimed_state, verified_state FROM objects WHERE id = $1`,
        [objectId],
      );
      const obj = objRes.rows[0];
      if (!obj) return null;
      const props = obj.properties ?? {};

      const taskType = typeof props.taskType === 'string' ? props.taskType : undefined;
      const sop = getSopConfig(taskType, {
        requiredEvidence: Array.isArray(props.requiredEvidence) ? (props.requiredEvidence as string[]) : undefined,
        expectedDurationMin: typeof props.expectedDurationMin === 'number' ? props.expectedDurationMin : undefined,
      });

      const claimPresent = obj.claimed_state != null;
      const claimMatchesExpected = claimPresent && obj.claimed_state === sop.expectedState;
      const claimCommId = typeof props.claimedBy === 'string' ? props.claimedBy : null;

      const items: EvidenceItem[] = [];
      const presentKinds = new Set<string>();
      let crossObjectContradiction = false;

      // Evidence referencing X (from_object —references→ X): attachments, comms, QR scans.
      const inbound = await c.query<{ from_object: string; ftype: string; fprops: Record<string, unknown> }>(
        `SELECT l.from_object, o.type AS ftype, o.properties AS fprops
           FROM links l JOIN objects o ON o.id = l.from_object
          WHERE l.to_object = $1 AND l.relation = 'references'`,
        [objectId],
      );
      for (const row of inbound.rows) {
        const fprops = row.fprops ?? {};
        if (row.ftype === 'Snapshot') {
          items.push(evidence('snapshot', true, row.from_object, 'snapshot evidence'));
          presentKinds.add('snapshot');
        } else if (row.ftype === 'Document') {
          items.push(evidence('document', true, row.from_object, 'document evidence'));
          presentKinds.add('document');
        } else if (row.ftype === 'Communication') {
          const scans = Array.isArray(fprops.scans) ? (fprops.scans as Array<Record<string, unknown>>) : [];
          const isScan = scans.some((s) => s?.scannedObjectId === objectId);
          if (isScan) {
            items.push(evidence('qr_scan', true, row.from_object, 'QR scan referencing object'));
            presentKinds.add('qr_scan');
          } else if (row.from_object !== claimCommId) {
            items.push(evidence('communication', true, row.from_object, 'corroborating communication'));
            presentKinds.add('communication');
          }
        }
        if (fprops.blocksCompletion === true) {
          crossObjectContradiction = true;
          items.push(evidence('cross_object', false, row.from_object, 'linked object blocks completion'));
        }
      }

      // Cross-object contradiction from objects X references.
      const outbound = await c.query<{ to_object: string; tprops: Record<string, unknown> }>(
        `SELECT l.to_object, o.properties AS tprops FROM links l JOIN objects o ON o.id = l.to_object WHERE l.from_object = $1`,
        [objectId],
      );
      for (const row of outbound.rows) {
        if ((row.tprops ?? {}).blocksCompletion === true) {
          crossObjectContradiction = true;
          items.push(evidence('cross_object', false, row.to_object, 'referenced object blocks completion'));
        }
      }

      const requiredMissing = sop.requiredEvidence.filter((k) => !presentKinds.has(k));

      // Timing anomaly: claimed done faster than the SOP expects (suspiciously quick).
      let timingAnomaly = false;
      const startedAt = typeof props.startedAt === 'string' ? Date.parse(props.startedAt) : NaN;
      const claimedAt = typeof props.claimedAt === 'string' ? Date.parse(props.claimedAt) : NaN;
      if (sop.expectedDurationMin && !Number.isNaN(startedAt) && !Number.isNaN(claimedAt)) {
        const elapsedMin = (claimedAt - startedAt) / 60000;
        timingAnomaly = elapsedMin >= 0 && elapsedMin < sop.expectedDurationMin;
      }

      const input: ScoreInput = {
        claimPresent,
        claimMatchesExpected,
        evidence: items,
        requiredMissing,
        timingAnomaly,
        crossObjectContradiction,
        threshold: sop.confidenceThreshold,
      };
      const scored = scorer.score(input);

      // Overdue is a time-based trigger evaluated here (not in the pure scorer).
      const triggered: TriggerReason[] = [...scored.triggered];
      const dueBy = typeof props.dueBy === 'string' ? Date.parse(props.dueBy) : NaN;
      if (!Number.isNaN(dueBy) && Date.now() > dueBy && scored.verifiedState !== 'verified' && !triggered.includes('overdue')) {
        triggered.push('overdue');
      }
      const result: VerificationResult = { ...scored, triggered };

      // Persist: object's verified slot (S2 owns verified_state + confidence).
      await c.query(`UPDATE objects SET verified_state = $2, confidence = $3 WHERE id = $1`, [
        objectId,
        result.verifiedState,
        result.confidence,
      ]);
      // Append-only ledger row (immutable history).
      await c.query(
        `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, confidence, evidence, reason)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [tenantId, objectId, result.verifiedState, result.confidence, JSON.stringify(result.evidence), result.reason],
      );
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
         VALUES ($1, $2, 'object.state.verified', $3::jsonb, 'verification')`,
        [tenantId, objectId, JSON.stringify({ verifiedState: result.verifiedState, confidence: result.confidence })],
      );

      // Raise an Alert (object + link + event) when triggers fired.
      let alertId: string | null = null;
      if (triggered.length > 0) {
        const severity = triggered.includes('conflict') ? 'high' : 'medium';
        const alertRes = await c.query<{ id: string }>(
          `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Alert', $2::jsonb) RETURNING id`,
          [
            tenantId,
            JSON.stringify({
              objectId,
              reason: result.reason,
              severity,
              triggered,
              verifiedState: result.verifiedState,
              confidence: result.confidence,
            }),
          ],
        );
        alertId = alertRes.rows[0]!.id;
        await c.query(
          `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'references') ON CONFLICT DO NOTHING`,
          [tenantId, alertId, objectId],
        );
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'alert.raised', $3::jsonb, 'verification')`,
          [tenantId, alertId, JSON.stringify({ objectId, triggered, severity })],
        );
      }

      return { objectId, objectType: obj.type, result, alertId };
    });
  }

  /** Sweep candidates: Tasks not yet verified (time-based overdue/missing checks run in verify). */
  async findSweepCandidates(tenantId: string): Promise<string[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM objects WHERE type = 'Task' AND (verified_state IS DISTINCT FROM 'verified')`,
      );
      return res.rows.map((r) => r.id);
    });
  }
}
