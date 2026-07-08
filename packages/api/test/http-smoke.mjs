/**
 * Full-app HTTP smoke: exercises the compiled API over the wire so real Nest DI boot and the
 * end-to-end agentic loop are covered (the unit/integration tests hand-wire services and would
 * miss DI/module wiring bugs — this is how we caught the storage-provider DI break).
 *
 * Assumes a compiled API is reachable at API_BASE and a fresh migrate+seed has run. Does NOT
 * manage Postgres or boot the API — the caller (CI steps, or pgtest/smoke-api.mjs in the
 * sandbox) does that, then calls runHttpSmoke() so the assertions live in exactly one place.
 *
 * Loop covered: POST /objects (fresh turnover) → POST /reports (scan) → verify → CONFLICT → cue
 * → approve → POST /uploads (snapshot) → re-verify → VERIFIED; plus /overview aggregate, the
 * dev tenant-guard 400, and an SSE stream emitting change events.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runHttpSmoke({
  base = process.env.API_BASE ?? 'http://localhost:3001',
  tenant = process.env.SMOKE_TENANT_ID ?? '11111111-1111-1111-1111-111111111111',
  log = console.log,
} = {}) {
  const H = { 'X-Tenant-Id': tenant };
  let passed = 0;
  let failed = 0;
  const check = (cond, label) => {
    log(`  ${cond ? '✓' : '✗'} ${label}`);
    cond ? (passed += 1) : (failed += 1);
  };

  // wait for the API to accept connections
  let booted = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) {
        booted = true;
        break;
      }
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  check(booted, 'API booted and /health responds');
  if (!booted) return { passed, failed };

  log('\noverview + loop:');
  const ov1 = await (await fetch(`${base}/overview`, { headers: H })).json();
  check(typeof ov1.tempo?.score === 'number', `GET /overview → tempo.score = ${ov1.tempo?.score}`);
  check(ov1.inventoryLow >= 1, `overview.inventoryLow = ${ov1.inventoryLow}`);
  check(ov1.ledger.length >= 2, `overview.ledger seeded entries = ${ov1.ledger.length}`);
  check(ov1.comms.length >= 1, `overview.comms = ${ov1.comms.length}`);

  // dev tenant guard: missing/invalid tenant → 400
  const noTenant = await fetch(`${base}/overview`);
  check(noTenant.status === 400, `GET /overview without tenant → 400 (got ${noTenant.status})`);

  const tasks = await (await fetch(`${base}/objects?type=Task`, { headers: H })).json();
  check(Array.isArray(tasks) && tasks.length >= 1, `GET /objects?type=Task → ${tasks.length} task(s)`);

  // Fresh, unresolved Room-3 turnover: claimed "ready" only 2 min after start (SOP 6 min) and
  // the required snapshot not yet attached → §4 conflict (timing anomaly overrides the
  // required-missing cap) → patient-flow cue.
  const now = Date.now();
  const created = await (
    await fetch(`${base}/objects`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'Task',
        claimedState: 'ready',
        properties: {
          taskType: 'room_turnover',
          requiredEvidence: ['snapshot'],
          expectedDurationMin: 6,
          startedAt: new Date(now - 2 * 60_000).toISOString(),
          claimedAt: new Date(now).toISOString(),
          label: 'Room 3 (smoke)',
        },
      }),
    })
  ).json();
  const taskId = created.id;
  check(!!taskId, 'POST /objects created a fresh turnover task');

  // SSE stream (query-param tenant, since EventSource/servers can't send custom headers)
  let sseEvents = 0;
  const ac = new AbortController();
  const ssePromise = (async () => {
    try {
      const res = await fetch(`${base}/objects/stream?tenantId=${tenant}`, {
        headers: { Accept: 'text/event-stream' },
        signal: ac.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseEvents += (dec.decode(value).match(/data:/g) || []).length;
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(300);

  // drive the loop: a staff report that scans the task → triggers verification
  const report = await (
    await fetch(`${base}/reports`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientMessageId: `smoke-${Date.now()}`,
        reportType: 'scan',
        text: 'Room 3 scanned at turnover',
        staffHandle: 'front_desk',
        staffDisplayName: 'A · Front Desk',
        at: new Date().toISOString(),
        scans: [{ scannedObjectType: 'Task', scannedObjectId: taskId, at: new Date().toISOString() }],
      }),
    })
  ).json();
  check(!!report.communicationId, 'POST /reports created a Communication');

  await sleep(600); // verify → agents → recommendations fan out
  const recs = await (await fetch(`${base}/recommendations?status=open`, { headers: H })).json();
  const cue = Array.isArray(recs) ? recs.find((r) => r.objectId === taskId) : undefined;
  check(!!cue, `GET /recommendations → cue raised for the conflicted task (${Array.isArray(recs) ? recs.length : 0} open)`);
  if (cue) {
    check(typeof cue.confidence === 'number' && Array.isArray(cue.evidence), 'cue has confidence + evidence');
    const approved = await (await fetch(`${base}/recommendations/${cue.id}/approve`, { method: 'POST', headers: H })).json();
    check(approved.status === 'approved', 'POST /recommendations/:id/approve → approved (intent only)');
    const openAfter = await (await fetch(`${base}/recommendations?status=open`, { headers: H })).json();
    check(!openAfter.some((r) => r.id === cue.id), 'approved cue left the open feed');
  }

  // §4 resolution: upload the required snapshot → evidence hook re-verifies → verified.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'room3.png');
  form.append('linkTo', taskId);
  form.append('kind', 'photo');
  const uploaded = await (await fetch(`${base}/uploads`, { method: 'POST', headers: H, body: form })).json();
  check(!!uploaded.objectId, 'POST /uploads stored a Snapshot');
  await sleep(400);
  const task2 = await (await fetch(`${base}/objects/${taskId}`, { headers: H })).json();
  check(task2.verifiedState === 'verified', `snapshot attached → task re-verified to verified (got ${task2.verifiedState})`);

  const ov2 = await (await fetch(`${base}/overview`, { headers: H })).json();
  check(ov2.ledger.length > ov1.ledger.length, `overview.ledger grew after the loop (${ov1.ledger.length} → ${ov2.ledger.length})`);
  check(ov2.comms.length > ov1.comms.length, `overview.comms grew (${ov1.comms.length} → ${ov2.comms.length})`);

  ac.abort();
  await ssePromise;
  check(sseEvents >= 1, `SSE stream emitted ${sseEvents} change event(s) during the loop`);

  return { passed, failed };
}

// Run directly (CI): assumes API_BASE is already up + seeded.
if (import.meta.url === `file://${process.argv[1]}`) {
  runHttpSmoke()
    .then(({ passed, failed }) => {
      console.log(`\n${failed === 0 ? '✔ API SMOKE PASSED' : '✖ API SMOKE FAILED'} — ${passed} passed, ${failed} failed.`);
      process.exit(failed === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error('smoke FAILED:', err?.stack ?? err);
      process.exit(1);
    });
}
