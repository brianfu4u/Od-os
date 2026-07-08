# S1-1 实现规格 · 对象 CRUD 服务与 API (for engineer)

## Goal & scope

**Goal.** A tenant-safe REST + realtime API over the ontology `objects` and `links`, where every write is recorded to the append-only `events` stream and pushed to subscribed clients. This is the backbone "Sense/Map" surface the rest of Sprint 1 builds on.

**In scope (MVP object types):** Task, Communication, Document, Snapshot, Staff, Room, InventoryItem. The store stays **generic** — no per-type tables; `type` + `properties` (JSONB) carry type-specific data (e.g. `taskType`, `requiredEvidence`).

**Out of scope for S1-1** (later tickets): LLM claim extraction (S1-4), entity resolution (S1-5), cross-verification + ledger writes (S2), pgvector embeddings (S1-5). Keep S1-1 to CRUD + events + realtime.

**Owner:** E1 · **Estimate:** 4 person-days · **Depends on:** S0-2 (done), S0-4 contract.

**Locked column names (do not drift):**
```
objects(id, tenant_id, type, properties jsonb, expected_state, claimed_state,
        verified_state, confidence, created_at, updated_at)
links(id, tenant_id, from_object, to_object, relation, created_at)
events(id, tenant_id, object_id, event_type, payload, actor, created_at)   -- append-only
```

## Hard rules (non-negotiable)

1. **`withTenant()` is the ONLY path** for tenant-scoped DB access (BEGIN; SET LOCAL ROLE clearview_app; set_config app.tenant_id). No handler may use the owner/superuser pool for tenant data — that would bypass RLS. Enforce via the PR checklist and, ideally, an ESLint rule banning direct `getPool().query` in feature modules.
2. **tenant_id always comes from the authenticated session** (RBAC middleware from S0-3), NEVER from the request body/query/params. Reject/ignore any client-supplied tenant_id.
3. **Every mutation writes an `events` row in the SAME transaction** as the change (so an event never exists without its change, and vice-versa).
4. **Realtime publish happens AFTER COMMIT**, never before (no phantom events on rollback).
5. Reuse `@clearview/shared` types as the single source; validate at the boundary; reject unknown fields; enforce `confidence ∈ [0,1]` and `verified_state ∈ VERIFIED_STATES` when present.
6. Implement exactly the **S0-4 OpenAPI contract** — the frontend (E3) is already building against its mock; do not drift field names or shapes.

## REST endpoints

All under tenant context; request/response bodies in camelCase per shared types.

**Objects**
- `POST /objects` — create. Body: `{ type, properties?, expectedState?, claimedState?, verifiedState?, confidence? }`. Emits `object.created`. Returns `OntologyObject`.
- `GET /objects/:id` — read one (404 if not visible under RLS).
- `GET /objects` — list/filter. Query: `type`, `taskType` (matches `properties->>'taskType'`), `updatedSince`, `limit` (default 50, max 200), `cursor`. Keyset pagination ordered by `(updated_at, id)`.
- `PATCH /objects/:id` — partial update. `properties` is **shallow-merged** (send `null` value to delete a key); state-triplet fields set when provided. Never allow `tenant_id`/`id`/timestamps to change. Emits `object.updated` plus a `object.state.<field>` event for each state field that actually changed (e.g. `object.state.claimed`).
- `DELETE /objects/:id` — **MVP: no hard delete.** Instead set a soft-archive (e.g. `properties.archived=true` or a dedicated state) and emit `object.archived`. Rationale: append-only ledger/events FK-reference objects; hard delete would break audit. (Document this decision in the PR.)

**Links**
- `POST /links` — `{ fromObject, toObject, relation }`. Same-tenant enforced by the DB trigger; validate `relation` against `LINK_RELATIONS` (allow free text but warn). Emits `link.created`.
- `GET /objects/:id/links` — query `direction=out|in|both` (default both), optional `relation`.
- `DELETE /links/:id` — emits `link.deleted`.

**Errors:** 400 validation, 401/403 auth (from S0-3), 404 not-visible, 409 conflict (e.g. duplicate link edge, archived-object write).

## Events on change

Every create/update/archive writes one append-only `events` row inside the mutation transaction:
```
{ tenantId, objectId, eventType, payload, actor }
```
- `actor` = the staff/user id (or 'system') from the session.
- `payload` = for create: the new object; for update: a minimal diff `{ changed: { field: {from,to} } }`; for state changes include the new state + confidence.

**Event types (reserve all now):** `object.created`, `object.updated`, `object.state.expected`, `object.state.claimed`, `object.state.verified`, `object.archived`, `link.created`, `link.deleted`.

> These events are the agentic loop's "Sense" input. S1-4/S1-5 will emit `object.state.claimed`; S2 cross-verification will emit `object.state.verified` and additionally append to `verification_ledger` (ledger writes are NOT part of S1-1).

## Realtime push

- Endpoint: `GET /stream` (WebSocket; SSE acceptable as v1). **Authenticate the socket** (same session/tenant as REST). A socket only ever receives its own tenant's events.
- Mechanism: after COMMIT, publish the event to that tenant's subscribers. Use Postgres `LISTEN/NOTIFY` (channel per tenant, or one channel with tenant filter) or an in-process event bus fired in an `AFTER COMMIT` hook. Do not publish from inside the transaction.
- Message shape: `{ type: eventType, object?: OntologyObject, link?: OntologyLink, at }`.
- Client (command center) subscribes on load; on reconnect it backfills via `GET /objects?updatedSince=<lastSeen>` so no change is missed.

**Isolation test (must pass):** a change in tenant A is delivered to an A-subscriber and is NEVER delivered to a B-subscriber.

## Tests & Definition of Done

**Unit**
- DTO validation: confidence bounds, verifiedState enum, unknown-field rejection, client tenant_id ignored.
- Event emission: each mutation produces the correct event type + payload.

**Integration** (against the `pgvector/pgvector:pg16` service, same harness as S0-2)
- CRUD round-trips for all 8 MVP types; PATCH shallow-merge; state-change emits `object.state.*`.
- List filter by `type` and `taskType`; keyset pagination.
- Cross-tenant: A cannot read/patch/delete B's object (reuse the RLS harness); cross-tenant link rejected by trigger.
- Archive path (no hard delete).

**Realtime**
- A-subscriber receives A's change; B-subscriber does not.

**Definition of Done (ticket acceptance)**
- [ ] All S0-4-contract read/write endpoints implemented; integration tests green in CI.
- [ ] Every object change produces an `events` row (same transaction).
- [ ] Frontend can subscribe via WebSocket/SSE and receive live changes.
- [ ] Multi-tenant isolation verified at the **API layer** (not just DB).
- [ ] `withTenant()` is the only tenant-data path (PR checklist ticked).
- [ ] Docs/contract + README updated; PR passes CI.
