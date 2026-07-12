# Demo Dogfood · Staging Walkthrough Checklist (P2)

A step-by-step checklist for walking the **whole synthetic-clinic demo** on real devices before showing
a clinic. This is a **manual, human, on-staging** exercise (the CI sandbox cannot drive a real
Android Chrome / iOS Safari). It pairs with the small edge fixes in this PR.

> Data: **synthetic only, no PHI.** Secrets only via env.

## 0 · Prerequisites (ops/founder, once)
- [ ] `feat/t6-support` (#30) merged — so 「申请支援 / request support」 is part of the walkthrough.
- [ ] On Render, set `DEMO_SEED=true` + `DEMO_SEED_TENANT_ID=<synthetic uuid>` (and `MANAGER_SEED_LOGIN`/
      `MANAGER_SEED_PASSWORD` for the same tenant), then run `pnpm --filter @clearview/api seed:demo`.
- [ ] Confirm the deploy is live: `GET /health` returns `status: ok` and the expected `version.commit`.
- [ ] `GET /health/ready` returns `db.ok: true` (first hit after a cold start may be slow — see §C).

## A · Manager — command center (Android Chrome + iOS Safari)
- [ ] **Login**: open the web app → manager credential login (login id + password) succeeds; wrong password is rejected with a clear message.
- [ ] **Podium / KPIs**: tempo score + active tasks / on-time / conflicts / open cues render (non-zero from the seed).
- [ ] **Domain grid**: six domains show counts + status colors; drill-down opens a domain page.
- [ ] **Co-Pilot cues**: ranked cues list; **Approve / Undo / Dismiss / Snooze** each work and update the row.
- [ ] **Ledger**: cross-verification rows show claim → evidence → verdict with the four verdict colors.
- [ ] **Comms**: seeded reports appear; a `support_request` shows the rose 「申请支援」 badge + annotation.
- [ ] **Transcripts**: the voice sample renders (or a clearly-labelled degraded state when no STT key).
- [ ] **Ops panel**: version/db health/uptime + request/error/LLM/STT/sweep metrics + tenant activity.
- [ ] **Task assignment**: list of tenant tasks + assignee; assign/reassign to a staff; create a task.
- [ ] **Logout**: sign out returns to the login screen; back-nav does not leak an authed view.

## B · Staff — terminal (real phone)
- [ ] **Login**: staff login (staging password or dev) → terminal.
- [ ] **My tasks**: the tasks assigned by the seed (and any the manager just assigned) appear; picking one sets the subject.
- [ ] **Photo**: take/choose a photo as evidence → upload succeeds; linked object re-verifies.
- [ ] **Scan (Android Chrome)**: camera QR/barcode scan resolves to the right object.
- [ ] **Scan (iOS Safari)**: BarcodeDetector unsupported → **manual-code fallback is shown** (no crash/blank).
- [ ] **Record (Android Chrome)**: MediaRecorder captures audio → upload → transcription attempt.
- [ ] **Record (iOS Safari)**: if MediaRecorder/mime unsupported → **clear degraded message** (no crash); audio path still offers an alternative.
- [ ] **Request support**: pick type + note (optional linked object) → appears in the command center comms.
- [ ] **Report event**: submit a report → appears in comms; empty message is validated.
- [ ] **Verdict colors**: after evidence, the object shows verified / conflict / pending / unverified as expected.

## C · Cross-cutting
- [ ] **i18n**: switch zh / en / ja — no raw keys anywhere (see §Fixed: zh had 7 missing keys — fixed here).
- [ ] **Session expiry**: after the 12h token expires, the next action shows a clear "please sign in again" path (see Known limitations).
- [ ] **Cold start (Render free tier)**: the first request after idle may take ~30s; the offline banner + Retry should read as "waking up", not "broken".
- [ ] **Mobile layout**: no horizontal overflow / squeezed controls at 360–414px width (terminal cards, command-center panels).
- [ ] **Storage-blocked webview**: in a locked-down webview (storage disabled), the app degrades gracefully (safe-storage try/catch) and shows the storage-unavailable notice.

## Fixed in this PR (small, reviewable)
- **i18n parity (zh)** — the default demo locale `zh.json` was missing **7 keys** that `en`/`ja` already had:
  `app.subtitle` and the whole `storage.*` namespace (`label / note / available / unavailable / pick / saved`,
  used by `StoragePref`). Added trilingual-consistent zh values (pure addition; no existing zh value changed;
  zh/en/ja now have identical key sets — 332 leaf keys each).

## Static verification performed (in-sandbox, complements the manual walkthrough)
- **i18n parity**: zh / en / ja leaf-key sets are now identical (0 missing in any language).
- **Referenced keys resolve**: every static `t('…')` across 23 demo-path components maps to an existing message key.
- **Dynamic key coverage**: the `t(\`…\${x}\`)` lookups (`verify.*`, `ledger.states.*`, `results.*`, `cues.priority.*`,
  `feed.*`, `loop.stages.*`, `domains.*`, `agents.*`) are backed by complete enum namespaces; `comms.reportTypes.*`
  is guarded by `KNOWN_REPORT_TYPES`.

## Known limitations & candidate follow-up tickets (NOT fixed here — larger than an edge)
- **iOS Safari device paths** (MediaRecorder recording, BarcodeDetector scanning) can only be *confirmed on a real
  iPhone*. The degrade fallbacks exist in code (unsupported/denied/error + manual entry); this checklist verifies them on device.
- **Mid-session 401 → auto sign-out**: the session is validated on load, but a token that expires mid-session
  currently surfaces as a per-action error rather than auto-routing to login. Candidate ticket (behavior change, not an edge).
- **Cold-start hint copy**: the offline banner could distinguish "waking up (free-tier cold start)" from a hard
  outage. Candidate copy ticket.
- **`agents.${cue.sourceAgent}`**: confirm a cue's `sourceAgent` is always one of the six domain agents
  (the `agents` namespace covers exactly those six).
