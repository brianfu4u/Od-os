# Clearview OD — WeChat Mini Program API Client Contract

> **Status:** demo-ready. **Session auth (S0-3) landed** — see §2. The WeChat Mini Program is a
> **separate front-end workstream** that cannot be built or run in this repo's sandbox — it needs a
> registered Mini Program **AppID + AppSecret**, WeChat DevTools, and an **ICP-filed** production API
> domain (China). This document is the contract the Mini Program (and, today, the browser **staff
> console** at `/[locale]/console`) codes against.

---

## 1. Base URL & versioning

| Env | Base URL | Notes |
|-----|----------|-------|
| Dev (sandbox) | `http://localhost:3001` | `NEXT_PUBLIC_API_BASE` for the web app |
| Prod (later) | `https://api.<clinic-domain>` | Must be an **ICP-filed** HTTPS domain; add to the Mini Program's `request` allow-list in the WeChat console |

All request/response bodies are JSON (except `POST /uploads`, which is `multipart/form-data`).
The wire types are the single source of truth in **`@clearview/shared`**
(`reports.contract.ts`, `uploads.contract.ts`, `recommendation.contract.ts`,
`overview.contract.ts`, `objects.contract.ts`).

---

## 2. Authentication & tenancy — **read this first** (S0-3)

Both the **tenant** and the **staff/manager identity** come from an **authenticated session**.
Production **never** trusts a client-supplied identity.

### How a session is obtained
- **Staff (WeChat):** `wx.login()` → send `code` to **`POST /auth/staff/wx-login`** → the server does
  `code2session` → `openid` → looks up the staff's `{tenant, staffId}` and issues a session. (Requires
  `WX_APPID`/`WX_APPSECRET`; returns **501** until configured — see §7.) An unknown `openid` is **not**
  auto-registered — a manager/admin registers staff first.
- **Manager (Web):** manager login → session bound to `{tenant, role, managerId}`. (Prod email
  magic-link / SSO is a TODO; see §7.)
- **Dev-gated mock (non-production only, 404 in prod):** `POST /auth/staff/dev-login`
  `{ tenantId, handle, displayName? }` and `POST /auth/manager/dev-login` `{ tenantId, login, role? }`
  provision + issue a session for local/CI synthetic data — the mock of the wx.login flow.

### Using a session
Every data request carries the session as **`Authorization: Bearer <token>`**, the **`cv_session`**
httpOnly cookie, or — for SSE, which can't set headers — a **`?session=<token>`** query param (a bearer
credential in the query is fine; a self-reported identity is not). The guard resolves the session and
sets tenant + staff/manager on the request. `GET /auth/me` returns the resolved identity; `POST /auth/logout`
revokes the token.

### Production vs. dev
- **Production:** no valid session ⇒ **401**. `X-Tenant-Id` / `staffHandle` / `staffDisplayName` in the
  header or body are **ignored** — identity is only ever the session's.
- **Non-production only:** if there is no session, a **dev shim** accepts `X-Tenant-Id` (or `?tenantId=`)
  + an optional `X-Staff-Handle` (or body `staffHandle`) so the local harness/command-center keep working
  on synthetic data. A present-but-invalid token is rejected in every environment.

> ⚠️ Ops: the API connects to Postgres as the least-privilege **`clearview_login`** role (member of
> `clearview_app`, non-superuser, non-BYPASSRLS). Boot **refuses to start** if the DB role can bypass RLS.
> Set `APP_DATABASE_URL` (a clearview_login connection) in production.

---

## 3. Endpoints the Mini Program uses

### 3.1 `POST /reports` — the universal staff report
Clock-in/out, task updates, events, evidence notes, and **QR scans**. One call creates a
`Communication`, records events, and links QR scans as evidence, and (via the verification hook)
re-verifies any scanned/linked object. **Idempotent** by `clientMessageId`. **The author is the
session's staff** — the body's `staffHandle`/`staffDisplayName` are ignored in production.

Request — `StaffReportInput`:
```jsonc
{
  "clientMessageId": "wx-9f13...",     // REQUIRED, unique per tenant; retries reuse it
  "reportType": "scan",                 // clock_in|clock_out|task_update|event|evidence|scan
  "text": "3号房已为下一位患者备好",
  "fields": { "roomLabel": "Room 3" }, // optional, report-type specific
  "scans": [                            // QR/tag scans = FIRST-CLASS verification evidence
    { "scannedObjectType": "Task", "scannedObjectId": "<uuid>", "at": "2026-07-08T09:20:00Z" }
  ],
  "attachments": [                      // refs only; bytes go through POST /uploads
    { "kind": "image", "objectId": "<snapshot-uuid>", "caption": "turnover photo" }
  ],
  "at": "2026-07-08T09:20:01Z"
  // NOTE: staffHandle/staffDisplayName are legacy dev-shim fields — IGNORED in production.
}
```
Response — `StaffReportResult`: `{ communicationId, staffId, deduped }`
(`deduped: true` ⇒ this `clientMessageId` was already ingested; safe to retry).

> **Resolve scans to `scannedObjectId` when you can** (the app knows the object id behind a QR).
> A raw `code` is accepted too, but only a resolved id creates the `references` link that feeds
> cross-verification. QR resolution of raw codes is a follow-on ticket.

### 3.2 `POST /uploads` — evidence bytes (`wx.uploadFile`)
`multipart/form-data`; the file field **must** be named `file`. Images → `Snapshot`, other →
`Document`. Optional `linkTo` (subject object id) triggers **auto re-verification** of that object.
Tenant comes from the session.

| Field | Required | Notes |
|-------|----------|-------|
| `file` | ✓ | the bytes (≤ per-kind size cap; content-type allow-listed) |
| `kind` | – | `photo` \| `screenshot` \| `voice` \| `pdf` \| `document` |
| `linkTo` | – | subject object id → creates `references` link + re-verifies |
| `relation` | – | link relation (default `references`) |

Response — `UploadResult`: `{ objectId, objectType, kind, mime, size, storageKey, sha256, deduped }`.
Bytes are **never** returned inline and **never** stored in Postgres.

WeChat call shape:
```js
wx.uploadFile({
  url: `${BASE}/uploads`,
  filePath, name: 'file',
  header: { Authorization: `Bearer ${sessionToken}` }, // dev: X-Tenant-Id
  formData: { kind: 'photo', linkTo: taskId },
});
```

### 3.3 `GET /uploads/:id/url` — short-lived signed download
Returns `SignedUrlResult` `{ url, expiresAt }` **after an RLS check**. Downloads happen **only**
through these signed URLs (never a public path). In production the URL points at object storage
(Tencent COS / OSS / S3) presigned; in dev it's an HMAC-signed local route.

### 3.4 Objects (task lifecycle)
- `GET /objects?type=Task` — list (RLS-scoped). Also `type=Room|InventoryItem|Equipment|…`.
- `GET /objects/:id` — one object (state triplet + confidence + properties).
- `POST /objects` — create (e.g. a new turnover task).
- `PATCH /objects/:id` — partial update; a changed `claimedState` emits `object.state.claimed`
  → auto-verification.
- `POST /objects/:id/verify` — force a re-verification (used by the console; normally implicit).

### 3.5 Read models (also used by the command center)
- `GET /overview` — one aggregate: `{ tempo, counts, inventoryLow, metrics, ledger[], comms[] }`.
- `GET /recommendations?status=open` — ranked Co-Pilot cues (`RecommendationRecord[]`).
- `GET /recommendations/tempo` — `OperatingTempo` for the podium.
- `POST /recommendations/sweep` — run the six-domain sweep (advise-only).
- `POST /recommendations/:id/{approve|dismiss|snooze}` — **human-in-the-loop**; records intent +
  emits an event. **No world action runs until S4** (approve = intent only).
- `GET /objects/stream?session=<token>` — **SSE** change feed (dev: `?tenantId=<uuid>`).

---

## 4. The loop this contract drives

```
POST /reports (scan)  ─▶ verify ─▶ CONFLICT ─▶ Alert ─▶ agent ─▶ Co-Pilot cue ─▶ (manager approves)
POST /uploads (photo) ─▶ verify ─▶ VERIFIED  ─▶ ledger row ─▶ SSE ─▶ command center updates live
```
The §4 Room-3 story exactly: a fast "ready" claim with the required snapshot **missing** →
`conflict @0.50`; once the snapshot is uploaded (requirement satisfied) → `verified @0.855`.
A strong but **non-required** signal (a QR scan alone) does **not** clear a missing-snapshot
conflict — only the actual required evidence does.

---

## 5. Minimal client sketch (shared shape; see `packages/web/src/lib/api.ts`)

```ts
async function postReport(input: StaffReportInput): Promise<StaffReportResult> {
  const res = await request({           // wx.request in the Mini Program; fetch on web
    url: `${BASE}/reports`, method: 'POST',
    header: { Authorization: `Bearer ${sessionToken}` }, // dev: { 'X-Tenant-Id': tenantId }
    data: input,
  });
  if (res.statusCode >= 400) throw new Error(res.data?.message ?? res.statusCode);
  return res.data;
}
```

## 6. Errors
Standard HTTP status + a JSON `{ message }` (NestJS). `400` = bad/missing tenant (dev) or invalid body;
`401` = no/invalid session (production, or a bad token in any env); `404` = not found (or not visible
under RLS — indistinguishable by design; also dev-only endpoints in production); `501` = WeChat not configured.

## 7. Open items / follow-ons
- **S0-3 (this ticket): DONE (dev-gated).** Sessions for staff (WeChat) + manager; guard rejects
  client self-report in production; DB-role hardening + boot self-check. Remaining founder dependencies:
  **WX_APPID/WX_APPSECRET + ICP filing** for the real wx-login, **manager prod login** (email magic-link/SSO),
  and wiring the **web UI** to real sessions (dev shim covers dev today).
- **Session hardening:** store a **hash** of the session token (not the raw token); add refresh/rotation.
- **QR resolution**: resolve raw scanned `code`s to object ids server-side.
- **Voice→text**: `voice` attachments transcribed to `claimed_state`/text (deferred S1-5/S0-6).
- **Production storage**: swap `LocalDiskStorageProvider` → COS/OSS/S3 presigned (StoragePort).
- **Mini Program packaging**: AppID, request domain allow-list, ICP filing.
