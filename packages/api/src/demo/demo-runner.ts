/**
 * Demo-seed CORE (importable, no env/exit side effects — the CLI wrapper is db/seed-demo.ts, the
 * integration test imports runDemoSeed directly). Executes the pure plan under withTenant/RLS: writes
 * ONLY claims + evidence + links + append-only events, then derives verdicts through the REAL S2
 * engine. It NEVER writes verified_state and NEVER touches another tenant / truncates.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../database/tenant-context';
import { VerificationRepository } from '../verification/verification.repository';
import { DeterministicScorer, type Scorer } from '../verification/scorer';
import { buildDemoPlan, type DemoPlan } from './demo-plan';

const ISO = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

interface UpsertResult {
  id: string;
  created: boolean;
}

/** Find-or-create an object by its stable seedKey (tenant-scoped by RLS). Never writes verified_state. */
async function upsertObject(
  c: PoolClient,
  tenantId: string,
  seedKey: string,
  type: string,
  properties: Record<string, unknown>,
  states: { claimed?: string | null; expected?: string | null } = {},
): Promise<UpsertResult> {
  const props = { ...properties, seedKey };
  const claimed = states.claimed ?? null;
  const expected = states.expected ?? null;
  const found = await c.query<{ id: string }>(
    `SELECT id FROM objects WHERE type = $1 AND properties->>'seedKey' = $2 LIMIT 1`,
    [type, seedKey],
  );
  if (found.rows[0]) {
    const id = found.rows[0].id;
    await c.query(`UPDATE objects SET properties = $2::jsonb, claimed_state = $3, expected_state = $4 WHERE id = $1`, [
      id,
      JSON.stringify(props),
      claimed,
      expected,
    ]);
    return { id, created: false };
  }
  const ins = await c.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state, claimed_state)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
    [tenantId, type, JSON.stringify(props), expected, claimed],
  );
  return { id: ins.rows[0]!.id, created: true };
}

async function upsertLink(c: PoolClient, tenantId: string, from: string, to: string, relation: string): Promise<void> {
  await c.query(
    `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, from_object, to_object, relation) DO NOTHING`,
    [tenantId, from, to, relation],
  );
}

async function event(
  c: PoolClient,
  tenantId: string,
  objectId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await c.query(`INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, 'demo-seed')`, [
    tenantId,
    objectId,
    eventType,
    JSON.stringify(payload),
  ]);
}

/** Write the plan (objects + links + claims + append-only events) in ONE tenant tx. seedKey → id. */
export async function seedPlan(tenantId: string, plan: DemoPlan): Promise<Map<string, string>> {
  return withTenant(tenantId, async (c) => {
    const ids = new Map<string, string>();

    for (const s of plan.staff) {
      const r = await upsertObject(c, tenantId, s.seedKey, 'Staff', { staffHandle: s.staffHandle, displayName: s.displayName, role: s.role });
      ids.set(s.seedKey, r.id);
      if (r.created) await event(c, tenantId, r.id, 'object.created', { type: 'Staff' });
    }
    for (const room of plan.rooms) {
      const r = await upsertObject(c, tenantId, room.seedKey, 'Room', { code: room.code, label: room.label }, { expected: 'ready' });
      ids.set(room.seedKey, r.id);
      if (r.created) await event(c, tenantId, r.id, 'object.created', { type: 'Room' });
    }
    for (const eq of plan.equipment) {
      const r = await upsertObject(c, tenantId, eq.seedKey, 'Equipment', { code: eq.code, label: eq.label, status: eq.status });
      ids.set(eq.seedKey, r.id);
      if (r.created) await event(c, tenantId, r.id, 'object.created', { type: 'Equipment' });
    }

    for (const t of plan.tasks) {
      const props: Record<string, unknown> = { taskType: t.taskType, label: t.label, requiredEvidence: t.requiredEvidence };
      if (t.timing) {
        props.startedAt = ISO(t.timing.startedMinAgo);
        props.claimedAt = ISO(t.timing.claimedMinAgo);
        props.expectedDurationMin = t.timing.expectedDurationMin;
      }
      const r = await upsertObject(c, tenantId, t.seedKey, 'Task', props, { claimed: t.claim, expected: t.expectedState });
      ids.set(t.seedKey, r.id);
      if (r.created) {
        await event(c, tenantId, r.id, 'object.created', { type: 'Task', taskType: t.taskType });
        if (t.claim !== null) await event(c, tenantId, r.id, 'object.state.claimed', { claimedState: t.claim, by: 'demo-seed' });
      }

      for (const ev of t.attach) {
        const type = ev.kind === 'snapshot' ? 'Snapshot' : 'Document';
        const er = await upsertObject(c, tenantId, ev.seedKey, type, { kind: ev.kind, caption: ev.caption, uri: `synthetic://${ev.kind}/${ev.seedKey}` });
        ids.set(ev.seedKey, er.id);
        if (er.created) await event(c, tenantId, er.id, 'object.created', { type });
        await upsertLink(c, tenantId, er.id, r.id, 'references'); // evidence —references→ task
      }
      if (t.assignToStaffKey) {
        const staffId = ids.get(t.assignToStaffKey);
        if (staffId) await upsertLink(c, tenantId, staffId, r.id, 'assignedTo'); // staff —assignedTo→ task
      }
      if (t.roomKey) {
        const roomId = ids.get(t.roomKey);
        if (roomId) await upsertLink(c, tenantId, r.id, roomId, 'references'); // task —references→ room
      }
    }

    for (const cm of plan.comms) {
      const r = await upsertObject(c, tenantId, cm.seedKey, 'Communication', { channel: 'wecom', author: cm.author, text: cm.text, at: ISO(15) });
      ids.set(cm.seedKey, r.id);
      if (r.created) await event(c, tenantId, r.id, 'object.created', { type: 'Communication' });
      const taskId = cm.refsTaskKey ? ids.get(cm.refsTaskKey) : undefined;
      if (taskId) await upsertLink(c, tenantId, r.id, taskId, 'references');
      const roomId = cm.refsRoomKey ? ids.get(cm.refsRoomKey) : undefined;
      if (roomId) await upsertLink(c, tenantId, r.id, roomId, 'references');
    }
    for (const v of plan.voice) {
      const r = await upsertObject(c, tenantId, v.seedKey, 'Document', {
        kind: 'voice',
        transcript: v.transcript,
        transcriptStatus: 'done',
        language: v.language,
        synthetic: true,
      });
      ids.set(v.seedKey, r.id);
      if (r.created) await event(c, tenantId, r.id, 'object.created', { type: 'Document', kind: 'voice' });
      const taskId = v.refsTaskKey ? ids.get(v.refsTaskKey) : undefined;
      if (taskId) await upsertLink(c, tenantId, r.id, taskId, 'references');
    }

    return ids;
  });
}

/** Reset = ARCHIVE (soft-delete) this tenant's demo objects. Never truncates, never crosses tenants. */
export async function archiveDemoData(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query(
      `UPDATE objects SET properties = properties || '{"archived":true}'::jsonb
        WHERE (properties->>'seedKey') LIKE 'demo:%' AND (properties->>'archived') IS DISTINCT FROM 'true'`,
    );
    const n = res.rowCount ?? 0;
    await event(c, tenantId, null, 'demo.reset', { archived: n });
    return n;
  });
}

export async function verifiedStateOf(tenantId: string, id: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ verified_state: string | null }>(`SELECT verified_state FROM objects WHERE id = $1`, [id]);
    return r.rows[0]?.verified_state ?? null;
  });
}

export interface DemoVerdict {
  seedKey: string;
  label: string;
  target: string;
  got: string;
  skipped: boolean;
}
export interface DemoSeedResult {
  seeded: number;
  tally: Record<string, number>;
  verdicts: DemoVerdict[];
  ids: Map<string, string>;
}

/**
 * Seed the demo tenant and derive verdicts via the REAL S2 engine. Idempotent: re-runs upsert (no
 * duplicate objects) and SKIP re-verifying an already-verified task (no duplicate ledger rows /
 * Alerts). Verdicts are produced by VerificationRepository.verify — this function never writes
 * verified_state itself.
 */
export async function runDemoSeed(tenantId: string, opts: { reset?: boolean; scorer?: Scorer } = {}): Promise<DemoSeedResult> {
  if (opts.reset) await archiveDemoData(tenantId);
  const plan = buildDemoPlan();
  const ids = await seedPlan(tenantId, plan);

  const repo = new VerificationRepository();
  const scorer = opts.scorer ?? new DeterministicScorer();
  const tally: Record<string, number> = {};
  const verdicts: DemoVerdict[] = [];
  for (const t of plan.tasks) {
    const taskId = ids.get(t.seedKey);
    if (!taskId) continue;
    const already = await verifiedStateOf(tenantId, taskId);
    let got: string;
    let skipped: boolean;
    if (already == null) {
      const out = await repo.verify(tenantId, taskId, scorer);
      got = out?.result.verifiedState ?? 'n/a';
      skipped = false;
    } else {
      got = already;
      skipped = true;
    }
    tally[got] = (tally[got] ?? 0) + 1;
    verdicts.push({ seedKey: t.seedKey, label: t.label, target: t.targetVerdict, got, skipped });
  }
  return { seeded: ids.size, tally, verdicts, ids };
}
