/**
 * Synthetic, privacy-safe seed data (NO PHI). Runs as the DB owner (bypasses RLS)
 * and populates two tenants so multi-tenant behaviour is visible immediately.
 * Tenant A reproduces the "Room 3 turnover" cross-verification story from
 * docs/01-structure-design.md §4 (conflict @0.50 → verified @0.855 in the ledger).
 */
import { Client } from 'pg';
import type { MvpTaskType } from '@clearview/shared';
import { requireDatabaseUrl } from './env';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

type Triplet = {
  properties?: Record<string, unknown>;
  expected?: string | null;
  claimed?: string | null;
  verified?: string | null;
  confidence?: number | null;
};

async function insObject(
  client: Client,
  tenantId: string,
  type: string,
  opts: Triplet = {},
): Promise<string> {
  const { properties = {}, expected = null, claimed = null, verified = null, confidence = null } =
    opts;
  const res = await client.query<{ id: string }>(
    `INSERT INTO objects
       (tenant_id, type, properties, expected_state, claimed_state, verified_state, confidence)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING id`,
    [tenantId, type, JSON.stringify(properties), expected, claimed, verified, confidence],
  );
  return res.rows[0]!.id;
}

async function link(
  client: Client,
  tenantId: string,
  from: string,
  to: string,
  relation: string,
): Promise<void> {
  await client.query(
    `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4)`,
    [tenantId, from, to, relation],
  );
}

async function event(
  client: Client,
  tenantId: string,
  objectId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  actor: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [tenantId, objectId, eventType, JSON.stringify(payload), actor],
  );
}

async function ledger(
  client: Client,
  tenantId: string,
  objectId: string,
  verifiedState: string,
  confidence: number,
  evidence: unknown,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, confidence, evidence, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [tenantId, objectId, verifiedState, confidence, JSON.stringify(evidence), reason],
  );
}

async function seedTenantA(client: Client): Promise<void> {
  const t = TENANT_A;

  const staffFront = await insObject(client, t, 'Staff', {
    properties: { role: 'front_desk', displayName: 'A · Front Desk' },
  });
  const staffTech = await insObject(client, t, 'Staff', {
    properties: { role: 'tech', displayName: 'A · Tech' },
  });

  const room3 = await insObject(client, t, 'Room', {
    properties: { label: 'Room 3' },
    expected: 'ready',
    claimed: 'ready',
    verified: 'conflict',
    confidence: 0.5,
  });

  const solution = await insObject(client, t, 'InventoryItem', {
    properties: { sku: 'CLS-500', name: 'Contact lens solution', onHand: 3, reorderPoint: 5 },
  });

  const roomTurnover: MvpTaskType = 'room_turnover';
  const taskTurnover = await insObject(client, t, 'Task', {
    properties: { taskType: roomTurnover, requiredEvidence: ['snapshot'], expectedDurationMin: 6 },
    expected: 'ready',
    claimed: 'ready',
    verified: 'conflict',
    confidence: 0.5,
  });

  const reorder: MvpTaskType = 'inventory_reorder';
  const taskReorder = await insObject(client, t, 'Task', {
    properties: { taskType: reorder, requiredEvidence: ['document'] },
    expected: 'ordered',
    claimed: null,
    verified: 'unverified',
    confidence: null,
  });

  const comm = await insObject(client, t, 'Communication', {
    properties: {
      channel: 'wecom',
      author: 'A · Front Desk',
      text: '3号房已为下一位患者备好',
      at: '09:20',
    },
  });

  const snapshot = await insObject(client, t, 'Snapshot', {
    properties: { kind: 'photo', caption: 'Room 3 tidied', uri: 'synthetic://snapshot/roomturn-1' },
  });

  const doc = await insObject(client, t, 'Document', {
    properties: { kind: 'reorder_form', uri: 'synthetic://doc/reorder-1' },
  });

  const verification = await insObject(client, t, 'Verification', {
    properties: { method: 'cross-verify' },
    verified: 'verified',
    confidence: 0.855,
  });

  // relations
  await link(client, t, staffTech, taskTurnover, 'assignedTo');
  await link(client, t, taskTurnover, room3, 'references');
  await link(client, t, taskReorder, solution, 'consumes');
  await link(client, t, comm, room3, 'references');
  await link(client, t, comm, taskTurnover, 'references');
  await link(client, t, snapshot, taskTurnover, 'references');
  await link(client, t, doc, taskReorder, 'references');
  await link(client, t, verification, taskTurnover, 'verifies');
  void staffFront; // present in the graph for later role/RBAC seeding

  // append-only event stream
  await event(client, t, taskTurnover, 'object.created', { type: 'Task', taskType: roomTurnover }, 'system');
  await event(
    client,
    t,
    taskTurnover,
    'object.state.claimed',
    { claimedState: 'ready', by: 'A · Front Desk', at: '09:20' },
    'A · Front Desk',
  );

  // verification ledger — the truth accrues over time (conflict → verified)
  await ledger(
    client,
    t,
    taskTurnover,
    'conflict',
    0.5,
    [{ kind: 'communication', ref: comm }],
    'Required snapshot missing; prior patient checked out <6min ago (timing anomaly).',
  );
  await ledger(
    client,
    t,
    taskTurnover,
    'verified',
    0.855,
    [
      { kind: 'communication', ref: comm },
      { kind: 'snapshot', ref: snapshot },
    ],
    'Snapshot uploaded and matches SOP; re-scored to verified.',
  );

  // ── Six-domain demo objects (S3+): each fires at least one recommendation-sweep cue ──
  const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
  const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

  // Financial: a collected-but-unposted copay ($8,240) + a claim missing its referral.
  await insObject(client, t, 'Invoice', {
    properties: { label: 'INV-3007', kind: 'copay', amountCents: 824000 },
    claimed: 'collected',
  });
  await insObject(client, t, 'Claim', {
    properties: { label: 'CLM-2041', payer: 'VisionCare', missingFields: ['referral'] },
  });

  // Marketing: a 2★ review past the 60-min response SLA + a web lead unworked > 24h.
  await insObject(client, t, 'Review', {
    properties: { label: 'REV-51', rating: 2, source: 'google', text: '等候太久,前台态度冷淡。', at: ago(72) },
  });
  await insObject(client, t, 'Lead', {
    properties: { label: 'LEAD-88', source: 'web', createdAt: ago(30 * 60) },
  });
  await insObject(client, t, 'Campaign', {
    properties: { label: 'Spring Dry-Eye', channel: 'email' },
  });

  // Equipment: OCT #2 is 31 days past its 30-day calibration window AND was just scanned in use
  // (→ the stronger "used while overdue" cue); a second device is freshly calibrated.
  const oct2 = await insObject(client, t, 'Equipment', {
    properties: { label: 'OCT #2', status: 'ready', lastCalibratedAt: daysAgo(31), calibrationValidDays: 30 },
  });
  await insObject(client, t, 'Equipment', {
    properties: { label: 'Auto-refractor', status: 'ready', lastCalibratedAt: daysAgo(5), calibrationValidDays: 30 },
  });
  const octScan = await insObject(client, t, 'Communication', {
    properties: {
      channel: 'wecom',
      author: 'A · Tech',
      text: 'OCT #2 用于 10:15 检查',
      at: '10:15',
      scans: [{ scannedObjectType: 'Equipment', scannedObjectId: oct2, at: ago(20) }],
    },
  });
  await link(client, t, octScan, oct2, 'references');

  // Staff: an OVERDUE pretest task (past due, still pending) + its overdue Alert → the staff
  // agent proposes a reassignment on the next sweep (the sixth domain to light up). The Alert is
  // seeded directly (the static seed doesn't run the verifier) exactly as the engine would raise it.
  const overduePretest = await insObject(client, t, 'Task', {
    properties: {
      taskType: 'pretest_done',
      label: 'Pretest · Bay 2',
      requiredEvidence: ['document'],
      dueBy: daysAgo(1),
      reassignTo: 'A · Tech',
    },
    expected: 'done',
    claimed: 'done',
    verified: 'pending',
    confidence: 0.5,
  });
  await insObject(client, t, 'Alert', {
    properties: {
      objectId: overduePretest,
      reason: 'Past its due time and not yet verified; required document still missing.',
      severity: 'medium',
      triggered: ['overdue', 'missing_required'],
      verifiedState: 'pending',
      confidence: 0.5,
    },
  });
  await link(client, t, staffTech, overduePretest, 'assignedTo');
}

async function seedTenantB(client: Client): Promise<void> {
  const t = TENANT_B;
  const manager = await insObject(client, t, 'Staff', {
    properties: { role: 'manager', displayName: 'B · Manager' },
  });
  const room = await insObject(client, t, 'Room', {
    properties: { label: 'Room 1' },
    expected: 'ready',
  });
  const calibration: MvpTaskType = 'equipment_calibration';
  const task = await insObject(client, t, 'Task', {
    properties: { taskType: calibration, requiredEvidence: ['document'] },
    expected: 'calibrated',
    claimed: 'calibrated',
    verified: 'pending',
    confidence: 0.5,
  });
  await link(client, t, manager, task, 'assignedTo');
  await link(client, t, task, room, 'references');
  await event(client, t, task, 'object.created', { type: 'Task', taskType: calibration }, 'system');
}

async function main(): Promise<void> {
  const connectionString = requireDatabaseUrl();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    console.log('↺ truncating ontology tables …');
    await client.query(
      'TRUNCATE objects, links, events, verification_ledger RESTART IDENTITY CASCADE',
    );
    console.log('🌱 seeding tenant A (busy clinic) …');
    await seedTenantA(client);
    console.log('🌱 seeding tenant B (second clinic) …');
    await seedTenantB(client);

    const counts = await client.query<{ tenant_id: string; n: string }>(
      'SELECT tenant_id, count(*)::text AS n FROM objects GROUP BY tenant_id ORDER BY tenant_id',
    );
    console.log('\n✔ seed complete. Objects per tenant:');
    for (const row of counts.rows) {
      console.log(`   ${row.tenant_id} → ${row.n} objects`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
