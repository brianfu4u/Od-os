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

  // dev tenant guard: missing/invalid tenant → 400 (dev shim requires a tenant)
  const noTenant = await fetch(`${base}/overview`);
  check(noTenant.status === 400, `GET /overview without tenant → 400 (got ${noTenant.status})`);

  // S0-3: a dev-login session authenticates via Bearer token (no self-reported X-Tenant-Id).
  const login = await (
    await fetch(`${base}/auth/staff/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant, handle: 'smoke-staff', displayName: 'Smoke Staff' }),
    })
  ).json();
  check(!!login.token && !!login.identity?.staffId, 'POST /auth/staff/dev-login issues a staff session');
  const bySession = await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${login.token}` } });
  check(bySession.ok, `GET /overview authorized by Bearer session, no X-Tenant-Id (got ${bySession.status})`);
  const meResp = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${login.token}` } });
  const me = await meResp.json();
  check(me?.tenantId === tenant && me?.subject === 'staff', 'GET /auth/me returns the session identity');

  // P5: the staging manager login is gated OFF by default (no STAGING_LOGIN_ENABLED) → 404, so it is
  // never exposed unless explicitly turned on.
  const stagingOff = await fetch(`${base}/auth/manager/staging-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything' }),
  });
  check(stagingOff.status === 404, `manager staging-login is gated off by default → 404 (got ${stagingOff.status})`);

  // T1: the staff terminal's staging login is env-gated the same way → 404 when disabled, so staging
  // never exposes an unauthenticated staff login unless STAGING_LOGIN_ENABLED is explicitly set.
  const staffStagingOff = await fetch(`${base}/auth/staff/staging-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything', handle: 'nurse-a' }),
  });
  check(staffStagingOff.status === 404, `staff staging-login is gated off by default → 404 (got ${staffStagingOff.status})`);

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

  // ── LLM1 «Listen» layer: the report was analyzed asynchronously (report.received → LLM1) ──
  log('\nLLM1 listen layer:');
  const commObj = await (await fetch(`${base}/objects/${report.communicationId}`, { headers: H })).json();
  check(!!commObj?.properties?.llm?.classification, 'report auto-annotated by LLM1 (async, non-blocking)');
  const ana = await (
    await fetch(`${base}/listen/analyze`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ communicationId: report.communicationId }),
    })
  ).json();
  check(!!ana?.classification?.domain, 'POST /listen/analyze returns a classification');
  const summary = await (await fetch(`${base}/listen/summary?hours=24`, { headers: H })).json();
  check(typeof summary?.text === 'string' && (summary.count ?? 0) >= 1, `GET /listen/summary → ${summary?.count} events summarized`);

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

  // ── S3+ six-domain coverage: tile metrics + the recommendation sweep ──
  log('\nsix-domain sweep:');
  const m = ov2.metrics ?? {};
  check(m.unposted >= 1, `overview.metrics.unposted = ${m.unposted} (financial)`);
  check(m.negativeReviews >= 1, `overview.metrics.negativeReviews = ${m.negativeReviews} (marketing)`);
  check(m.calibrationDue >= 1, `overview.metrics.calibrationDue = ${m.calibrationDue} (equipment)`);
  check(m.collectedCents >= 1, `overview.metrics.collectedCents = ${m.collectedCents} (financial $${Math.round((m.collectedCents ?? 0) / 100)})`);

  const swept = await (await fetch(`${base}/recommendations/sweep`, { method: 'POST', headers: H })).json();
  check((swept.created ?? 0) >= 4, `POST /recommendations/sweep created ${swept.created} cues`);
  await sleep(200);
  const feed = await (await fetch(`${base}/recommendations?status=open&limit=50`, { headers: H })).json();
  const domains = new Set((Array.isArray(feed) ? feed : []).map((r) => r.domain));
  for (const d of ['patient_flow', 'staff', 'inventory', 'financial', 'marketing', 'equipment']) {
    check(domains.has(d), `sweep produced a ${d} cue`);
  }
  check(domains.size >= 6, `open cues span all ${domains.size} domains (≥6)`);

  // ── P2/S4 action write-back: approve executes a whitelisted internal action; high-risk is blocked ──
  log('\naction write-back (P2/S4):');
  const findCue = (pred) => (Array.isArray(feed) ? feed.find(pred) : undefined);
  const hasAction = (r, t) => (r.actions || []).some((a) => a.actionType === t);
  const actionsOf = async (id) => await (await fetch(`${base}/recommendations/${id}/actions`, { headers: H })).json();

  const invCue = findCue((r) => hasAction(r, 'inventory_reorder'));
  check(!!invCue, 'found an inventory_reorder cue to approve');
  if (invCue) {
    const before = (await (await fetch(`${base}/objects?type=Task`, { headers: H })).json()).length;
    const appr = await (await fetch(`${base}/recommendations/${invCue.id}/approve`, { method: 'POST', headers: H })).json();
    check(appr.execution?.state === 'executed', `approve inventory_reorder → executed (got ${appr.execution?.state})`);
    const after = (await (await fetch(`${base}/objects?type=Task`, { headers: H })).json()).length;
    check(after === before + 1, `a restock Task was created (${before} → ${after})`);
    const l1 = await actionsOf(invCue.id);
    check(Array.isArray(l1) && l1.filter((x) => x.result === 'executed').length === 1, 'action_log has exactly one executed row');
    await fetch(`${base}/recommendations/${invCue.id}/approve`, { method: 'POST', headers: H }); // re-approve
    const l2 = await actionsOf(invCue.id);
    check(l2.filter((x) => x.result === 'executed').length === 1, 'repeat approve is idempotent (still one executed row)');
  }

  const claimCue = findCue((r) => hasAction(r, 'submit_claim'));
  check(!!claimCue, 'found a high-risk (submit_claim) cue');
  if (claimCue) {
    const appr = await (await fetch(`${base}/recommendations/${claimCue.id}/approve`, { method: 'POST', headers: H })).json();
    check(appr.execution?.state === 'blocked_high_risk', `approve high-risk → blocked_high_risk (got ${appr.execution?.state})`);
    const lc = await actionsOf(claimCue.id);
    check(lc.some((x) => x.result === 'blocked_high_risk') && !lc.some((x) => x.result === 'executed'), 'high-risk recorded, never executed');
  }

  const eqCue = findCue((r) => hasAction(r, 'equipment_offline'));
  if (eqCue) {
    await fetch(`${base}/recommendations/${eqCue.id}/approve`, { method: 'POST', headers: H });
    const undo = await (await fetch(`${base}/recommendations/${eqCue.id}/undo`, { method: 'POST', headers: H })).json();
    check(undo.execution?.state === 'undone', `undo equipment_offline → undone (got ${undo.execution?.state})`);
    const le = await actionsOf(eqCue.id);
    check(le.some((x) => x.result === 'executed') && le.some((x) => x.result === 'undone'), 'action_log shows executed + undone');
  }

  // ── P3 drill-down: the object timeline powers the domain detail story ──
  const tl = await (await fetch(`${base}/objects/${taskId}/timeline`, { headers: H })).json();
  check(!!tl.object && tl.object.id === taskId, 'GET /objects/:id/timeline returns the object');
  check(Array.isArray(tl.events) && tl.events.length >= 1, `timeline has events (${tl.events?.length ?? 0})`);
  check(Array.isArray(tl.ledger) && tl.ledger.length >= 1, `timeline has verification-ledger rows (${tl.ledger?.length ?? 0})`);

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
