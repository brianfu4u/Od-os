# Clearview OD

**Real-time operating system for optometry (OD) eye clinics.** The clinic manager is
the *conductor*; the system listens to staff↔manager communications plus uploaded
documents/photos (not physical sensors), an LLM cross-verifies whether tasks are
actually complete, then advises across six domains (staff, patients, financial,
marketing, equipment, inventory). Built **ontology-first** (Palantir-style) and
**multi-tenant** from day one.

> Design source of truth lives in [`/docs`](./docs): the structure design, the dev
> plan, and the Sprint 0–1 ticket specs. The trilingual UI prototype is the frontend
> design contract.

---

## Monorepo layout

```
clearview-od/
├─ packages/
│  ├─ web/      Next.js (App Router) · Tailwind · next-intl (中/EN/日, default 中文)
│  ├─ api/      NestJS · Postgres (RLS + pgvector) · migrations/seed/tests
│  └─ shared/   TypeScript ontology types shared by web + api
├─ docs/        structure design · dev plan · ticket specs (source of truth)
├─ .github/     CI (lint/build/test + RLS isolation) and gated staging deploy
└─ docker-compose.yml   local Postgres (pgvector image)
```

## Prerequisites

- **Node 22+** and **pnpm 10** (`corepack enable` will provide pnpm).
- **Docker** (for the local Postgres + pgvector database).

## Quickstart

```bash
pnpm install
cp .env.example .env

# 1) start local Postgres (pgvector image) and set up the ontology core
docker compose up -d
pnpm db:migrate        # repeatable — safe to run again
pnpm db:seed           # synthetic, privacy-safe data for two tenants
pnpm db:test           # proves cross-tenant RLS isolation

# 2) run web + api together (one command)
pnpm dev
```

- Web: <http://localhost:3000> (redirects to `/zh` by default; switch 中文 / English / 日本語 top-right)
- API health: <http://localhost:3001/health>

## Scripts (run from the repo root)

| Command | What it does |
|---|---|
| `pnpm dev` | Runs `web` + `api` (and the shared type watcher) together via Turborepo. |
| `pnpm build` | Builds all packages. |
| `pnpm lint` | ESLint across all packages. |
| `pnpm test` | Unit tests (Vitest) across all packages. |
| `pnpm db:migrate` | Applies SQL migrations (idempotent/repeatable). |
| `pnpm db:seed` | Loads synthetic seed data for two tenants. |
| `pnpm db:reset` | **Dev only** — drops & recreates the schema. |
| `pnpm db:test` | Runs the cross-tenant RLS isolation test. |

## Environment variables

| Variable | Used by | Example |
|---|---|---|
| `DATABASE_URL` | migrations, seed, api | `postgresql://postgres:postgres@localhost:5432/clearview_od` |
| `API_PORT` | api | `3001` |
| `NEXT_PUBLIC_API_BASE_URL` | web | `http://localhost:3001` |

---

## S0-1 — Repo, CI/CD, environments ✔

- Monorepo with `web` / `api` / `shared`.
- One command (`pnpm dev`) runs web + api locally (documented above).
- **CI** (`.github/workflows/ci.yml`): every PR runs **lint → build → unit tests**;
  a second job runs migrations (twice, to prove repeatability) + seed + the RLS test
  against a `pgvector/pgvector` service container. Failures block merge (make these
  checks required in branch protection).
- **Staging deploy** (`.github/workflows/deploy-staging.yml`): on merge to `main`,
  deploys `web` to Vercel and publishes the `api` container. Both jobs are **gated**
  behind opt-in repo variables so nothing runs until infra is connected — see below.

### Enabling staging deploy

1. **Frontend (Vercel):** create a Vercel project from `packages/web`. Add repo
   secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and set the repo
   variable `ENABLE_VERCEL_DEPLOY=true`.
2. **Backend (container + managed Postgres):** provision a managed Postgres with
   **pgvector** (e.g. Neon or Supabase), set `DATABASE_URL` on the container host,
   and set the repo variable `ENABLE_API_DEPLOY=true` (image publishes to GHCR via
   `packages/api/Dockerfile`).

---

## S0-2 — Ontology core DB schema ✔

A **generic object store** (not per-type tables). Per-type fields live in
`properties` (JSONB); only the state triplet is promoted to columns.

- **`objects`** — `id, tenant_id, type, properties (jsonb)`, the **state triplet**
  `expected_state / claimed_state / verified_state + confidence`, and timestamps.
  Supports the 8 MVP types (Task, Communication, Document, Snapshot, Verification,
  Staff, Room, InventoryItem) and the wider ontology.
- **`links`** — `from_object → to_object` with a `relation` (assignedTo, partOf,
  uses, consumes, references, verifies, forPatient, forVisit …). A trigger enforces
  that both endpoints share the link's tenant.
- **`events`** and **`verification_ledger`** — **append-only** (INSERT-only),
  enforced by a trigger *and* by withheld UPDATE/DELETE grants.
- Every table carries `tenant_id` with **Row-Level Security** (`ENABLE` + `FORCE`).

### Multi-tenancy / RLS model

The API never queries as a superuser. Each tenant-scoped operation runs inside a
transaction that downgrades to the least-privilege `clearview_app` role and sets the
tenant for that transaction only:

```sql
BEGIN;
SET LOCAL ROLE clearview_app;                    -- non-owner, non-superuser → RLS applies
SELECT set_config('app.tenant_id', $tenant, true);  -- transaction-local
-- ... queries; policies restrict rows to tenant_id = app_current_tenant() ...
COMMIT;
```

`SET LOCAL` resets at transaction end, so pooled connections never leak tenant
context. When no tenant is set, policies **default-deny** (no rows). See
`packages/api/src/database/tenant-context.ts` and `db/migrations/0004_rls_and_roles.sql`.

The acceptance test (`pnpm db:test`) proves: tenants see only their own rows,
cross-tenant writes are rejected by `WITH CHECK`, updates to invisible rows affect
zero rows, default-deny holds with no tenant, and the append-only tables reject
UPDATE/DELETE.

> **pgvector note:** the extension is enabled defensively (skipped with a NOTICE on a
> vanilla Postgres). Use the `pgvector/pgvector` image (docker-compose) or a
> pgvector-capable managed Postgres for embeddings in Sprint 1.

---

## S1-1 — object API, events & realtime

The `api` exposes the ontology object API the frontend and later tickets consume.
**Multi-tenancy:** every request sends an `X-Tenant-Id` header (a UUID) — a **dev-only**
stand-in until auth/session lands in **S0-3**. The guard is hard-disabled when
`NODE_ENV=production`; S0-3 will derive the tenant from the authenticated session and
reject any client-supplied id. The header only *names* the tenant; all queries run
through `withTenant()`, so **RLS is the real isolation boundary**.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/objects` | Create (`type` required; per-type fields in `properties`). |
| `GET` | `/objects` | List/query — `?type=&limit=&offset=&includeArchived=`. |
| `GET` | `/objects/:id` | Fetch one. |
| `PATCH` | `/objects/:id` | Update the state triplet and/or shallow-merge `properties`. |
| `DELETE` | `/objects/:id` | **Soft delete** (see below). |
| `POST` | `/links` | Create a tenant-scoped link between two objects. |
| `GET` | `/objects/stream` | **SSE** stream of object changes for the tenant. |

- **Events-on-change:** every create/update/delete writes an append-only `events` row
  in the *same transaction* — the audit trail and the agentic-loop signal.
- **Soft delete (deliberate):** `DELETE` archives the object (`properties.archived=true`
  + `archivedAt`) and emits the reserved `object.archived` event. It never hard-deletes
  (the append-only `events` FK protects audited objects) and does **not** touch the state
  triplet — `verified_state` stays owned by cross-verification (S2).
- **Realtime:** an in-process bus fans changes to the SSE endpoint per tenant (swap for
  Postgres `LISTEN/NOTIFY` when the api runs multi-instance).

```bash
curl -X POST localhost:3001/objects -H 'content-type: application/json' \
  -H 'X-Tenant-Id: 11111111-1111-1111-1111-111111111111' \
  -d '{"type":"Task","properties":{"taskType":"room_turnover"},"expectedState":"ready"}'
```

Validated in-sandbox: the full object integration suite (CRUD, event-on-change,
cross-tenant isolation, archive) alongside the S0-2 RLS suite.

---

## S1-2 — staff report ingest (WeChat Mini Program terminal)

The staff terminal is a **WeChat Mini Program** (not a third-party IM). It POSTs
structured reports to **`POST /reports`**, which — via `withTenant()` — creates a
`Communication` object, resolves/provisions the author `Staff`, records events, and links
QR-scan evidence. **Idempotent** by `clientMessageId` (per tenant), so client retries
never duplicate.

Payload (`StaffReportInput` in `@clearview/shared`): `reportType` (clock_in / clock_out /
task_update / event / evidence / scan), `text`, structured `fields`, `attachments`
(image / audio / screenshot refs — upload is S1-3), and `scans` (`scannedObjectType` +
`scannedObjectId`/`code` + `at`). **QR scans are first-class evidence:** a resolved
`scannedObjectId` gets a `references` link to the scanned object for cross-verification (S2).

```bash
curl -X POST localhost:3001/reports -H 'content-type: application/json' \
  -H 'X-Tenant-Id: 11111111-1111-1111-1111-111111111111' \
  -d '{"clientMessageId":"m-1","reportType":"scan","staffHandle":"openid-a1",
       "scans":[{"scannedObjectType":"Visit","scannedObjectId":"<id>","at":"2026-07-07T09:00:00Z"}]}'
```

> **Auth is dev-only for now.** Tenant comes from the env-gated `X-Tenant-Id` header and
> the staff identity from `staffHandle` in the body. **TODO(S0-3):** both must derive from
> the `wx.login`/openid session and never be trusted from the client. The Mini Program is
> its own front-end workstream (Mini Program account; prod API domain likely needs ICP
> filing). Voice→text and QR-code resolution are separate follow-on tickets.

---

## Ground rules

- **Multi-tenant from day one** — `tenant_id` + RLS on every data table.
- **Synthetic, privacy-safe data only** — never real patient data (PHI) in dev.
- **Human-in-the-loop** — the AI proposes; the manager approves.
- **Narrow MVP scope** — only 5 task types (frozen in S0-7).
- **Trilingual UI**, default Chinese; `localStorage` is wrapped in try/catch so
  embedded/sandboxed views never crash (`packages/web/src/lib/safe-storage.ts`).
