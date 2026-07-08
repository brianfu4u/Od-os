# Clearview OD — WeChat Mini Program API Client Contract

> **Status:** demo-ready (dev auth). The WeChat Mini Program is a **separate front-end
> workstream** that cannot be built or run in this repo's sandbox — it needs a registered
> Mini Program **AppID**, WeChat DevTools, and an **ICP-filed** production API domain (China).
> This document is the contract the Mini Program (and, today, the browser **staff console** at
> `/[locale]/console`) codes against. Both post the **identical** payloads; only auth differs.

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

## 2. Authentication & tenancy — **read this first**

The tenant **and** the staff identity are security-critical. They are resolved **differently**
in dev vs. production, and production must **never** trust the client.

### Dev (today)
- Tenant travels as the **`X-Tenant-Id`** header (a UUID). For SSE (`EventSource` can't set
  headers) it may also travel as a **`?tenantId=`** query param.
- Staff identity is supplied in the report body as `staffHandle` / `staffDisplayName`.
- This path is **hard-disabled when `NODE_ENV=production`** — the `TenantGuard` throws.

> ⚠️ **DEV ONLY.** A client-supplied tenant after only a UUID format check is a cross-tenant
> leak vector with real data. Fine for synthetic dev data; unacceptable in production.

### Production (S0-3 — to build)
1. Mini Program calls `wx.login()` → gets a `code`.
2. Client sends `code` to a new endpoint `POST /auth/session` (S0-3).
3. Server exchanges `code` with WeChat (`jscode2session`) → `openid`, mints a **server session**
   (httpOnly cookie or bearer token).
4. **Every** subsequent request derives the **tenant** and the **staff object** from that session.
   The client cannot choose a tenant or spoof a staff member. `X-Tenant-Id` / `staffHandle` are
   ignored/rejected.

Until S0-3 ships, keep the dev headers behind `NODE_ENV !== 'production'` (already enforced).

---

## 3. Endpoints the Mini Program uses

### 3.1 `POST /reports` — the universal staff report
Clock-in/out, task updates, events, evidence notes, and **QR scans**. One call creates a
`Communication`, resolves/provisions the `Staff`, links QR scans as evidence, and (via the
verification hook) re-verifies any scanned/linked object. **Idempotent** by `clientMessageId`.

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
  "at": "2026-07-08T09:20:01Z",
  "staffHandle": "front_desk",          // DEV ONLY — prod derives Staff from the session
  "staffDisplayName": "A · Front Desk"  // DEV ONLY
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
  header: { /* prod: session cookie/token; dev: 'X-Tenant-Id' */ },
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
- `GET /overview` — one aggregate: `{ tempo, counts, inventoryLow, ledger[], comms[] }`.
- `GET /recommendations?status=open` — ranked Co-Pilot cues (`RecommendationRecord[]`).
- `GET /recommendations/tempo` — `OperatingTempo` for the podium.
- `POST /recommendations/:id/{approve|dismiss|snooze}` — **human-in-the-loop**; records intent +
  emits an event. **No world action runs until S4** (approve = intent only).
- `GET /objects/stream?tenantId=<uuid>` — **SSE** change feed (command center; not the Mini Program).

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
    header: authHeader(),               // prod: session; dev: { 'X-Tenant-Id': tenantId }
    data: input,
  });
  if (res.statusCode >= 400) throw new Error(res.data?.message ?? res.statusCode);
  return res.data;
}
```

## 6. Errors
Standard HTTP status + a JSON `{ message }` (NestJS). `400` = bad/missing tenant or invalid body;
`404` = not found (or not visible under RLS — indistinguishable by design); `401` = the dev header
path is disabled (production without a session).

## 7. Open items / follow-ons
- **S0-3**: `POST /auth/session` (wx.login→openid→session); bind the provisional Staff to the
  verified `openid`; stop trusting `X-Tenant-Id`/`staffHandle`.
- **QR resolution**: resolve raw scanned `code`s to object ids server-side.
- **Voice→text**: `voice` attachments transcribed to `claimed_state`/text (deferred S1-5/S0-6).
- **Production storage**: swap `LocalDiskStorageProvider` → COS/OSS/S3 presigned (StoragePort).
- **Mini Program packaging**: AppID, request domain allow-list, ICP filing.
