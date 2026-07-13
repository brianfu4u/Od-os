import { Injectable } from '@nestjs/common';
import type { EvidenceItem, EvidenceType, TriggerReason, VerificationResult } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { getSopConfig } from './sop-config';
import { insertLearningFeedback, readLearnedTaskParams } from '../learning/learning.sql';
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
      // P4/S8 read-back: the effective config layers DEFAULT_SOP < tenant-LEARNED overrides <
      // per-object overrides (object always wins). Learned weights merge key-by-key with the
      // defaults so a single tuned kind never wipes the rest.
      const learned = taskType ? await readLearnedTaskParams(c, taskType) : null;
      const perObjWeights =
        props.evidenceWeights && typeof props.evidenceWeights === 'object' && !Array.isArray(props.evidenceWeights)
          ? (props.evidenceWeights as Record<string, number>)
          : undefined;
      const mergedWeights = {
        ...(getSopConfig(taskType).evidenceWeights ?? {}),
        ...(learned?.weights ?? {}),
        ...(perObjWeights ?? {}),
      };
      const sop = getSopConfig(taskType, {
        requiredEvidence: Array.isArray(props.requiredEvidence) ? (props.requiredEvidence as string[]) : undefined,
        expectedDurationMin: typeof props.expectedDurationMin === 'number' ? props.expectedDurationMin : undefined,
        evidenceWeights: mergedWeights,
        confidenceThreshold: typeof props.confidenceThreshold === 'number' ? props.confidenceThreshold : learned?.threshold,
        baseSelfClaim: typeof props.baseSelfClaim === 'number' ? props.baseSelfClaim : learned?.base,
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
        // S0-7: fold the task's per-kind weights and self-claim base into the pure scorer.
        weights: sop.evidenceWeights,
        baseSelfClaim: sop.baseSelfClaim,
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

      // ── Resubmission (回退重提), closed-loop step 6 ──────────────────────────────────────────
      // When the DETERMINISTIC engine returns a non-verified verdict for a Task that the staff
      // CLAIMED done, and the shortfall is actionable by the staff (a required evidence kind is
      // missing, or the evidence conflicts), record an append-only `task.resubmission.requested`
      // event. This is the signal the staff console reads to know "add the missing evidence and
      // resubmit". It is pure audit trail: it does NOT touch verified_state (S2 owns that), creates
      // no world state, and re-uses the existing events table (no migration). The staff attaching
      // fresh evidence already re-triggers verifyObject() (reports.service), so a satisfied resubmit
      // simply stops emitting this event → the loop closes.
      const needsResubmission =
        obj.type === 'Task' &&
        claimPresent &&
        result.verifiedState !== 'verified' &&
        (requiredMissing.length > 0 || triggered.includes('conflict'));
      if (needsResubmission) {
        const attemptRes = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.requested'`,
          [objectId],
        );
        const attempt = Number(attemptRes.rows[0]?.n ?? 0) + 1;
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
           VALUES ($1, $2, 'task.resubmission.requested', $3::jsonb, 'verification')`,
          [
            tenantId,
            objectId,
            JSON.stringify({
              verifiedState: result.verifiedState,
              requiredMissing,
              reason: result.reason,
              attempt,
            }),
          ],
        );
      }

      return { objectId, objectType: obj.type, result, alertId };
    });
  }

  /**
   * P4/S8: a human manually corrects the verdict (e.g. a "conflict" was actually fine, or a
   * "verified" wasn't really done). Updates the object's verified_state, appends an immutable ledger
   * row (manual correction), and captures a `verdict_correction` feedback signal carrying the
   * evidence kinds that were on record — the learner uses the correction direction to tune weights.
   * Human-in-the-loop + auditable; it does NOT re-run the scorer.
   */
  async correctVerdict(
    tenantId: string,
    objectId: string,
    toState: string,
    reason: string,
  ): Promise<{ objectId: string; fromState: string | null; toState: string } | null> {
    return withTenant(tenantId, async (c) => {
      const objRes = await c.query<{ properties: Record<string, unknown>; verified_state: string | null; confidence: string | null }>(
        `SELECT properties, verified_state, confidence FROM objects WHERE id = $1`,
        [objectId],
      );
      const obj = objRes.rows[0];
      if (!obj) return null;
      const fromState = obj.verified_state;
      const taskType = typeof obj.properties?.taskType === 'string' ? (obj.properties.taskType as string) : null;
      const confidence = obj.confidence == null ? 0.5 : Number(obj.confidence);

      // Evidence kinds on record (from the latest ledger row) — the signal context for the learner.
      const led = await c.query<{ evidence: unknown }>(
        `SELECT evidence FROM verification_ledger WHERE object_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [objectId],
      );
      const evArr = Array.isArray(led.rows[0]?.evidence) ? (led.rows[0]!.evidence as Array<Record<string, unknown>>) : [];
      const evidenceKinds = [
        ...new Set(
          evArr
            .map((e) => (typeof e.type === 'string' ? e.type : typeof e.kind === 'string' ? (e.kind as string) : null))
            .filter((x): x is string => !!x),
        ),
      ];

      await c.query(`UPDATE objects SET verified_state = $2 WHERE id = $1`, [objectId, toState]);
      await c.query(
        `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, confidence, evidence, reason)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [tenantId, objectId, toState, confidence, JSON.stringify(evArr), `manual correction: ${reason}`],
      );
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.state.corrected', $3::jsonb, 'manager')`,
        [tenantId, objectId, JSON.stringify({ fromState, toState, reason })],
      );
      await insertLearningFeedback(c, tenantId, {
        kind: 'verdict_correction',
        taskType,
        objectId,
        fromState,
        toState,
        evidenceKinds,
        payload: { reason },
      });
      return { objectId, fromState, toState };
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
