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
  // A Bearer session authenticates WITHOUT a self-reported X-Tenant-Id: hit a staff-accessible route
  // (/objects) to prove the session's tenant is resolved server-side from the token alone.
  const bySession = await fetch(`${base}/objects?type=Task`, { headers: { Authorization: `Bearer ${login.token}` } });
  check(bySession.ok, `GET /objects authorized by Bearer session, no X-Tenant-Id (got ${bySession.status})`);
  // #26 role hardening: /overview is a manager-only command-center view. A staff session must be
  // rejected with 403 (authenticated, but not authorized) — the server is the authorization boundary.
  const staffOnOverview = await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${login.token}` } });
  check(staffOnOverview.status === 403, `staff session on manager-only /overview → 403 (got ${staffOnOverview.status})`);
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

  // P1-6-0: /listen/* is MANAGER-ONLY (it exposes raw analyzed text). Prove a STAFF session is 403
  // BEFORE using a manager session for the real calls. This is a pure authorization boundary.
  const staffOnListenSummary = await fetch(`${base}/listen/summary?hours=24`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  check(staffOnListenSummary.status === 403, `P1-6-0: staff session on manager-only /listen/summary → 403 (got ${staffOnListenSummary.status})`);
  const staffOnListenAnalyze = await fetch(`${base}/listen/analyze`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ communicationId: report.communicationId }),
  });
  check(staffOnListenAnalyze.status === 403, `P1-6-0: staff session on manager-only /listen/analyze → 403 (got ${staffOnListenAnalyze.status})`);

  // The real listener calls run under a MANAGER session.
  const listenMgr = await (
    await fetch(`${base}/auth/manager/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant, login: 'smoke-mgr-listen', displayName: 'Smoke Mgr Listen' }),
    })
  ).json();
  check(!!listenMgr.token, 'POST /auth/manager/dev-login issues a manager session (listen layer)');
  const LH = { Authorization: `Bearer ${listenMgr.token}`, 'Content-Type': 'application/json' };
  const ana = await (
    await fetch(`${base}/listen/analyze`, {
      method: 'POST',
      headers: LH,
      body: JSON.stringify({ communicationId: report.communicationId }),
    })
  ).json();
  check(!!ana?.classification?.domain, 'POST /listen/analyze returns a classification (manager)');
  const summary = await (await fetch(`${base}/listen/summary?hours=24`, { headers: { Authorization: `Bearer ${listenMgr.token}` } })).json();
  check(typeof summary?.text === 'string' && (summary.count ?? 0) >= 1, `GET /listen/summary → ${summary?.count} events summarized (manager)`);

  // P1-6-b: POST /retention/sweep is MANAGER-ONLY (redacts sensitive raw content past the window).
  // A staff session must be 403; a manager session returns a numeric { redacted } count. With the
  // default 30-day window and freshly-seeded data, nothing is old enough yet → redacted === 0.
  const staffOnRetention = await fetch(`${base}/retention/sweep`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  check(staffOnRetention.status === 403, `P1-6-b: staff session on manager-only /retention/sweep → 403 (got ${staffOnRetention.status})`);
  const retResp = await fetch(`${base}/retention/sweep`, { method: 'POST', headers: LH });
  const ret = await retResp.json();
  check(retResp.status === 201 && typeof ret?.redacted === 'number', `P1-6-b: manager POST /retention/sweep → { redacted: ${ret?.redacted} }`);
  check(ret?.redacted === 0, 'P1-6-b: fresh data is within the retention window → 0 redacted');

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

  // ── flow-id manager three-state decision (single authority) over the wire ──
  log('\nflow decision (manager single authority):');
  const mgr = await (
    await fetch(`${base}/auth/manager/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant, login: 'smoke-mgr', displayName: 'Smoke Mgr' }),
    })
  ).json();
  check(!!mgr.token, 'POST /auth/manager/dev-login issues a manager session');
  const MH = { Authorization: `Bearer ${mgr.token}`, 'Content-Type': 'application/json' };
  const decide = (id, body) => fetch(`${base}/assignments/tasks/${id}/decide`, { method: 'POST', headers: MH, body: JSON.stringify(body) });

  const flowTask = await (
    await fetch(`${base}/assignments/tasks`, { method: 'POST', headers: MH, body: JSON.stringify({ label: 'Flow smoke task', taskType: 'prep' }) })
  ).json();
  check(!!flowTask.taskId, 'manager createTask returns a task (its own flow)');
  const fid = flowTask.taskId;

  // REJECT keeps the flow open (pending) with a structured reason — does NOT close it.
  const rej = await decide(fid, { decision: 'reject', rejectionReasonCategory: 'missing_evidence', rejectionReasonDetail: 'need the tray photo' });
  const rejBody = await rej.json();
  check(rej.ok && rejBody.flowState === 'pending' && rejBody.flowId === fid, `REJECT keeps flow pending, same flow_id (got ${rejBody.flowState})`);

  // REJECT without a valid category is refused (structured reason is required).
  const badRej = await decide(fid, { decision: 'reject' });
  check(badRej.status === 400, `REJECT without a category → 400 (got ${badRej.status})`);

  // The rejection reason is surfaced on the manager overview (same read projection the employee sees).
  const asg = await (await fetch(`${base}/assignments/overview`, { headers: { Authorization: `Bearer ${mgr.token}` } })).json();
  const asgTask = (asg.tasks || []).find((t) => t.taskId === fid);
  check(asgTask?.rejection?.category === 'missing_evidence', 'assignments/overview surfaces the structured rejection reason');

  // APPROVE closes the flow (terminal), and a closed flow can never be re-decided (→ 409).
  const app = await decide(fid, { decision: 'approve' });
  const appBody = await app.json();
  check(app.ok && appBody.flowState === 'closed', `APPROVE closes the flow (got ${appBody.flowState})`);
  const reApp = await decide(fid, { decision: 'approve' });
  check(reApp.status === 409, `APPROVE on a closed flow → 409 terminal (got ${reApp.status})`);

  // A staff session cannot decide — the endpoint is manager-only (→ 403).
  const staffDecide = await fetch(`${base}/assignments/tasks/${fid}/decide`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'shelve' }),
  });
  check(staffDecide.status === 403, `staff session on manager-only decide → 403 (got ${staffDecide.status})`);

  // ── T-04 employee status-claim + T-05 patient scan (business-flow P0, Stage 2) over the wire ──
  // Proves real Nest DI boot + module wiring for the two new staff endpoints, and the two core
  // principles end to end: a five-state claim is never rejected, and a scan is never blocked. The
  // staff-facing responses carry the CLAIM layer only (no verification field leaks over HTTP).
  log('\nemployee status-claim + patient scan (P0 stage 2):');
  const SH = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };

  // A well-formed five-state claim → 200/201, never a rejection path.
  const claimResp = await fetch(`${base}/employee-status/claims`, {
    method: 'POST',
    headers: SH,
    body: JSON.stringify({ claimedStatus: 'busy', note: 'smoke' }),
  });
  const claimBody = await claimResp.json();
  check(claimResp.ok && claimBody.claimedStatus === 'busy', `POST /employee-status/claims → ok, status=busy (got ${claimResp.status})`);
  // Field-projection guarantee over the wire: no verification key leaks to the employee.
  check(
    !('verificationResult' in claimBody) && !('verification_result' in claimBody) && !('verificationScore' in claimBody),
    'employee claim response carries no verification field (projection)',
  );

  const meStatus = await (await fetch(`${base}/employee-status/me`, { headers: { Authorization: `Bearer ${login.token}` } })).json();
  check(meStatus.claimedStatus === 'busy', 'GET /employee-status/me returns the latest claim (claim layer only)');

  // An unknown status code is input shape (400), NOT a business rejection of the employee.
  const badClaim = await fetch(`${base}/employee-status/claims`, { method: 'POST', headers: SH, body: JSON.stringify({ claimedStatus: 'lunch' }) });
  check(badClaim.status === 400, `POST /employee-status/claims with an unknown status → 400 input shape (got ${badClaim.status})`);

  // A scan with an unknown code is NEVER blocked — it stores as unresolved.
  const scanResp = await fetch(`${base}/scans`, { method: 'POST', headers: SH, body: JSON.stringify({ patientCode: `smoke-unknown-${Date.now()}` }) });
  const scanBody = await scanResp.json();
  check(scanResp.ok && scanBody.visitLinkStatus === 'unresolved', `POST /scans (unknown code) → ok, unresolved, never blocked (got ${scanResp.status})`);
  check(!!scanBody.scanId && !('verificationResult' in scanBody), 'scan ack carries a scan_id and no verdict (neutral)');

  // A scan with no key at all → 400 (the only hard rule; mirrors the DB CHECK).
  const emptyScan = await fetch(`${base}/scans`, { method: 'POST', headers: SH, body: JSON.stringify({}) });
  check(emptyScan.status === 400, `POST /scans with no key → 400 at-least-one-key (got ${emptyScan.status})`);

  ac.abort();
  await ssePromise;
  check(sseEvents >= 1, `SSE stream emitted ${sseEvents} change event(s) during the loop`);

  // ── attention queue (P0 stage 3): manager-only, read-only ──
  log('\nmanager attention queue (P0 stage 3):');
  // A manager session can read the queue; the shape is { items: [...] } and every item exposes only
  // the whitelisted, neutral keys — no employee-facing feedback / verdict / instruction field.
  const attnResp = await fetch(`${base}/attention/queue`, { headers: MH });
  const attnBody = await attnResp.json().catch(() => ({}));
  check(attnResp.ok && Array.isArray(attnBody.items), `GET /attention/queue (manager) → ok with items[] (got ${attnResp.status})`);
  const ALLOWED_ITEM_KEYS = ['employeeId', 'employeeName', 'evidenceSummary', 'generatedAt', 'id', 'kind', 'lastEventAt'];
  const badItem = (attnBody.items ?? []).find(
    (it) => JSON.stringify(Object.keys(it).sort()) !== JSON.stringify(ALLOWED_ITEM_KEYS),
  );
  check(!badItem, 'attention items expose exactly the whitelisted keys (no employee-facing feedback field)');
  // A staff session must NOT reach the manager-only queue.
  const staffOnAttn = await fetch(`${base}/attention/queue`, { headers: SH });
  check(staffOnAttn.status === 403, `staff session on manager-only /attention/queue → 403 (got ${staffOnAttn.status})`);

  // ── P1-6-f · scan-code masking + audited reveal ──
  log('\nP1-6-f reveal (scan-code masked in queue, audited reveal endpoint):');
  // Any surfaced scan code in the queue must already be MASKED — the raw value never rides the queue.
  const revealable = (attnBody.items ?? []).find((it) => it.evidenceSummary?.revealable === true);
  if (revealable) {
    check(
      typeof revealable.evidenceSummary.submitted === 'string' && revealable.evidenceSummary.submitted.includes('****'),
      `queue: revealable item's submitted is masked (got ${revealable.evidenceSummary.submitted})`,
    );
  }
  // reveal target: a revealable item if present, else any staff (exercises the endpoint + 200 shape).
  const revealStaffId = revealable?.employeeId ?? login.identity?.staffId;
  // A staff session must NOT reach the manager-only reveal endpoint.
  const staffOnReveal = await fetch(`${base}/attention/reveal-scan-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffId: revealStaffId }),
  });
  check(staffOnReveal.status === 403, `staff session on manager-only /attention/reveal-scan-code → 403 (got ${staffOnReveal.status})`);
  // A missing staffId is a 400 (body validation), never a silent 200.
  const revealNoBody = await fetch(`${base}/attention/reveal-scan-code`, { method: 'POST', headers: MH, body: JSON.stringify({}) });
  check(revealNoBody.status === 400, `manager reveal without staffId → 400 (got ${revealNoBody.status})`);
  // A manager reveal returns 200 with the { staffId, scanCode, scanAt } shape (scanCode may be null +
  // reason when absent — never a 404, so existence can't be probed via status codes).
  const revealResp = await fetch(`${base}/attention/reveal-scan-code`, { method: 'POST', headers: MH, body: JSON.stringify({ staffId: revealStaffId }) });
  const revealBody = await revealResp.json().catch(() => ({}));
  check(revealResp.status === 200, `manager reveal → 200 (got ${revealResp.status})`);
  check(
    'scanCode' in revealBody && (revealBody.scanCode === null ? typeof revealBody.reason === 'string' : typeof revealBody.scanCode === 'string'),
    'reveal response is { scanCode:string } or { scanCode:null, reason } (200-shaped, never 404)',
  );
  if (revealable) {
    check(typeof revealBody.scanCode === 'string' && !revealBody.scanCode.includes('****'), 'reveal returns the FULL raw code (not the masked form) for a revealable item');
  }

  // ── manager status board (T-09 · D1-A): manager-only, read-only whole-roster snapshot ──
  log('\nmanager status board (stage 4 · D1-A):');
  const boardResp = await fetch(`${base}/employee-status/board`, { headers: MH });
  const boardBody = await boardResp.json().catch(() => ({}));
  check(boardResp.ok && Array.isArray(boardBody.rows), `GET /employee-status/board (manager) → ok with rows[] (got ${boardResp.status})`);
  const ALLOWED_BOARD_KEYS = ['claimedStatus', 'employeeId', 'employeeName', 'lastEventAt', 'secondsSinceLastEvent'];
  const badBoardRow = (boardBody.rows ?? []).find(
    (r) => JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(ALLOWED_BOARD_KEYS),
  );
  check(!badBoardRow, 'board rows expose exactly the whitelisted keys (no verification / LLM / verdict field)');
  // A staff session must NOT reach the manager-only board (method-level @Roles('manager') override).
  const staffOnBoard = await fetch(`${base}/employee-status/board`, { headers: SH });
  check(staffOnBoard.status === 403, `staff session on manager-only /employee-status/board → 403 (got ${staffOnBoard.status})`);

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
