# S1-3 实现规格 · 证据上传(Document/Snapshot 存储)(for engineer)

## Goal & scope

**Goal.** Make evidence real: upload photos / screenshots / voice audio / documents to object storage, create the matching ontology object (**Snapshot** or **Document**), and link it to the report (Communication) or Task it proves. This turns the *attachment refs* that S1-2's `POST /reports` already carries into stored, retrievable, tenant-isolated evidence — the raw material the S2 cross-verification engine consumes.

**In scope:** upload endpoint(s), object-storage adapter, Snapshot/Document object creation, signed download URLs, linking evidence to Communication/Task, events + realtime, validation & tenant isolation.

**Out of scope (separate, schema-compatible follow-on tickets):** voice→text transcription (kind='voice' is stored now, transcribed later), QR-code resolution, malware scanning. No cross-verification logic here (that's S2).

**Owner:** E1 (E3 wires the Mini Program / command center later) · **Estimate:** 2–3 person-days · **Depends on:** S0-2, S1-1, S1-2.

**Reuse the locked contracts:** objects/links/events columns from S0-2; `withTenant()` from S1-1; the report/attachment shape from S1-2. No new table required — uploads are generic `objects` (type Snapshot/Document); optional index on `properties->>'sha256'` for dedup (migration 0006 if added).

## Upload flow & endpoints

**Recommended pattern: upload-first, then reference.** The client (dev harness now; WeChat Mini Program later via `wx.uploadFile`) uploads the file, gets back an object id, then includes that id in the report — or links it to an existing Communication/Task.

**Endpoints** (all tenant-scoped; camelCase per shared types):
- `POST /uploads` — multipart (`file` + fields: `kind?`, `linkTo?` {objectType,id}, `relation?` default `references`). Server: (1) validate mime/size; (2) stream bytes to object storage at a **tenant-prefixed key** (NOT into Postgres) — done OUTSIDE any DB tx; (3) then in a short `withTenant()` tx: create the Snapshot/Document object + emit `object.created`, and if `linkTo` given, create a `references` link + emit `link.created` (and `evidence.attached`). Returns the object.
- `GET /uploads/:id/url` (or `GET /objects/:id/content`) — returns a **short-lived signed download URL** after an RLS-checked `withTenant()` lookup. Never return a raw/public bucket URL.
- Linking after the fact: reuse `POST /links` from S1-1 ({fromObject: uploadId, toObject: taskId, relation:'references'}).

**Type mapping (by mime):** `image/*` → **Snapshot** (properties.kind = photo | screenshot); `audio/*` → **Document** (kind='voice'; transcription later); `application/pdf` and doc types → **Document** (kind='pdf'|'checklist'|...). Store on the object: `properties = { kind, mime, size, storageKey, originalName, sha256 }`.

**Storage adapter:** define a small `StoragePort` interface (put, getSignedUrl, head) so dev uses Supabase Storage / MinIO and prod uses **Tencent Cloud COS** (China + WeChat) — swappable by env, no logic change.

**Integration with S1-2 /reports:** support both orders — (a) *upload-first*: client uploads → gets ids → posts report with attachment ids (recommended); (b) *report-then-attach*: post report → upload with `linkTo` = that Communication. The report resolver creates `references` links for resolved attachment ids exactly like it does for author/QR targets.

## Security, validation & tenant isolation

- **Tenant isolation:** storage keys are prefixed `tenant/<tenant_id>/...`; downloads only via signed URLs minted **after** a `withTenant()` RLS check confirms the object belongs to the caller's tenant. A caller can never fetch another tenant's bytes.
- **Validation:** allowlist mime types (images: jpeg/png/webp; audio: mp3/m4a/aac/amr — WeChat voice formats; docs: pdf and common office/text). Reject others. Max size per kind (e.g. image 10 MB, audio 20 MB, doc 20 MB). Reject empty/oversize with 400/413.
- **Integrity/dedup:** compute `sha256`; optionally dedup identical bytes per tenant (return the existing object).
- **Privacy:** strip image EXIF GPS/metadata on ingest (clinic/patient privacy). Synthetic data only in dev; **never real PHI**.
- **Auth:** same dev-only stand-in as S1-2 (env-gated) with TODO(S0-3): production identity + tenant come from the wx.login/openid session, never client-supplied.
- **Forward (not MVP):** malware/AV scan on upload; presigned direct-to-COS upload (client → COS) as the scale optimization so bytes don't transit our API.

## Events & realtime

Emit append-only `events` in the same tx as the object/link write:
- `object.created` — the new Snapshot/Document.
- `link.created` + **`evidence.attached`** (reserve this type) — when the upload is linked to a Communication/Task, so downstream knows 'new evidence arrived for X'.

**Realtime:** publish these via the S1-1 SSE stream (after commit, tenant-filtered) so the command center shows evidence landing live. This is what makes the structure-design §4 story work: staff uploads the Room-3 turnover photo → `evidence.attached` fires → (S2 later) re-scores conflict → verified, visible on the manager dashboard in real time.

## Tests & Definition of Done

**Unit:** mime/size validation; tenant-prefixed key generation; sha256; type→object mapping.

**Integration** (pgvector service + a storage mock/MinIO):
- Upload image → Snapshot object created with storageKey + mime + sha256; `GET url` returns a signed, expiring URL that works.
- Cross-tenant download blocked (tenant B cannot fetch tenant A's upload).
- Link-on-upload creates a `references` link + `evidence.attached` event; report-then-attach flow also works.
- Disallowed mime and oversize rejected.
- Audio upload stored as Document kind='voice' (no transcription yet).

**Realtime:** uploading evidence linked to a Task emits an event received by a same-tenant subscriber, not by another tenant's.

**Definition of Done (ticket acceptance):**
- [ ] Upload returns a retrievable stored ref; creates the correct object (Snapshot/Document) with kind/mime/size/storageKey/sha256.
- [ ] Can link to a Communication or Task (`references`) at upload time or after.
- [ ] Size/type validation + basic security; tenant-isolated keys; download only via short-lived signed URL after RLS check.
- [ ] Events emitted; command center receives evidence-arrival via SSE.
- [ ] `withTenant()` is the only tenant-data path; integration + cross-tenant tests green in CI.
- [ ] Storage adapter is env-swappable (dev vs COS); README + contract updated.
