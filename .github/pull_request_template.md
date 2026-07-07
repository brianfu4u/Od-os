<!-- Clearview OD — PR template. Delete sections that don't apply. -->

## What & why

<!-- One or two sentences. Link the ticket (e.g. S0-2, S1-1). -->

Ticket:

## How to verify

<!-- Commands / steps a reviewer runs locally or in CI. -->

## Review checklist

**Multi-tenancy & RLS (non-negotiable)**

- [ ] Every tenant-scoped query goes through `withTenant()` — nothing queries as the DB owner/superuser in a way that bypasses RLS.
- [ ] Any new data table has `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and a `tenant_isolation` policy (`USING` + `WITH CHECK`).
- [ ] Append-only tables (`events`, `verification_ledger`) are never granted `UPDATE`/`DELETE`.

**Data & scope**

- [ ] Synthetic, privacy-safe data only — no real patient data (PHI).
- [ ] MVP scope respected (5 task types stay config in `properties`, not hardcoded).
- [ ] Human-in-the-loop preserved (no risky automation added).

**Quality**

- [ ] Shared contract (`@clearview/shared`) and README updated if interfaces/config changed.
- [ ] `pnpm lint`, `pnpm build`, `pnpm test` pass locally.
- [ ] CI is green (lint/build/test + migrations twice + seed + RLS isolation).
- [ ] Trilingual strings added for any new UI (中/EN/日, default 中文).
