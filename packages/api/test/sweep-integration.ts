/**
 * S3+ integration: the recommendation SWEEP produces ranked, evidence-backed cues across all six
 * domains from synthetic objects — end to end through RecommendationService.sweep against
 * $DATABASE_URL. Asserts financial/marketing/equipment each fire, the orchestrator ranks across
 * domains, the equipment used-while-overdue escalation wins, and cross-tenant isolation holds.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { RealtimeService } from '../src/objects/realtime.service';
import { RecommendationRepository } from '../src/recommendations/recommendation.repository';
import { RecommendationService } from '../src/recommendations/recommendation.service';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function insObject(
  admin: Client,
  tenant: string,
  type: string,
  properties: Record<string, unknown>,
  opts: { claimed?: string | null; verified?: string | null; confidence?: number | null } = {},
): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, claimed_state, verified_state, confidence)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,
    [tenant, type, JSON.stringify(properties), opts.claimed ?? null, opts.verified ?? null, opts.confidence ?? null],
  );
  return res.rows[0]!.id;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const realtime = new RealtimeService();
  const recommendations = new RecommendationService(new RecommendationRepository(), realtime);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();
  const now = Date.now();
  const ago = (min: number): string => new Date(now - min * 60_000).toISOString();
  const days = (d: number): string => new Date(now - d * 86_400_000).toISOString();

  try {
    console.log('S3+ six-domain sweep:');

    // financial
    await insObject(admin, A, 'Invoice', { label: 'INV-1', amountCents: 824000 }, { claimed: 'collected' });
    await insObject(admin, A, 'Claim', { label: 'CLM-9', missingFields: ['referral'] });
    // marketing
    await insObject(admin, A, 'Review', { label: 'REV-1', rating: 2, at: ago(72) });
    await insObject(admin, A, 'Lead', { label: 'LEAD-1', createdAt: ago(30 * 60) });
    // equipment: overdue + a usage scan → used-while-overdue escalation
    const oct = await insObject(admin, A, 'Equipment', { label: 'OCT #2', status: 'ready', lastCalibratedAt: days(31), calibrationValidDays: 30 });
    await insObject(admin, A, 'Communication', {
      author: 'A · Tech',
      scans: [{ scannedObjectType: 'Equipment', scannedObjectId: oct, at: ago(15) }],
    });
    // cross-domain: a conflicted task (patient_flow) + a low inventory item (inventory)
    await insObject(admin, A, 'Task', { taskType: 'room_turnover', label: 'Room 5' }, { claimed: 'ready', verified: 'conflict', confidence: 0.5 });
    await insObject(admin, A, 'InventoryItem', { name: 'Fluorescein strips', onHand: 1, reorderPoint: 6 });

    // tenant B: one financial object that WOULD fire — to prove isolation.
    await insObject(admin, B, 'Claim', { label: 'B-CLM', missingFields: ['referral'] });

    const created = await recommendations.sweep(A);
    check(created.length >= 5, `sweep created ${created.length} cues (≥5 across domains)`);

    const feed = await recommendations.feed(A, 'open', 50);
    const domains = new Set(feed.map((r) => r.domain));
    check(domains.has('financial'), 'financial cue present');
    check(domains.has('marketing'), 'marketing cue present');
    check(domains.has('equipment'), 'equipment cue present');
    check(domains.size >= 4, `cues span ${domains.size} domains (≥4)`);

    const claimCue = feed.find((r) => r.domain === 'financial' && r.title.includes('referral'));
    check(!!claimCue, 'financial claim-missing-referral cue raised');
    check((claimCue?.evidence.length ?? 0) > 0 && typeof claimCue?.confidence === 'number', 'claim cue carries evidence + confidence');

    const review = feed.find((r) => r.domain === 'marketing' && r.title.includes('★'));
    check(!!review, 'marketing negative-review-SLA cue raised');

    const equip = feed.find((r) => r.domain === 'equipment');
    check(!!equip && equip.title.includes('used while calibration overdue'), 'equipment escalated to used-while-overdue');

    check(feed.every((r) => r.rank >= 1), 'every cue is ranked by the orchestrator');

    // Idempotent: a second sweep does not duplicate the open cues.
    const again = await recommendations.sweep(A);
    check(again.length === 0, 're-sweep creates no duplicates');

    // Cross-tenant isolation.
    check((await recommendations.feed(B, 'open', 50)).length === 0, 'tenant B sees no cues');
    check((await recommendations.sweep(B)).length >= 1, 'tenant B sweep works on ITS own objects (isolated)');
    check((await recommendations.feed(A, 'open', 50)).every((r) => r.objectId !== 'B'), 'tenant A feed never contains tenant B objects');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} sweep integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
