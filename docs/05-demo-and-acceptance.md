# Clearview OD — Demo & Acceptance Checklist

A 5-minute, end-to-end walkthrough of the Phase-1 MVP: the six-domain command center on live
data + the staff console (WeChat Mini Program stand-in). **Synthetic, privacy-safe data only —
no real patient information (PHI).**

---

## 1. Run it locally

**Prereqs:** Node 20+, pnpm 10, and Postgres 16 (a local server, Docker, or the repo's
`docker-compose.yml`). Set `DATABASE_URL`, e.g.
`postgresql://postgres:postgres@localhost:5432/clearview_od`.

```bash
pnpm install
pnpm --filter @clearview/shared build

# database: schema + synthetic seed (tenant A = busy clinic, tenant B = second clinic)
pnpm db:migrate
pnpm db:seed

# API (NestJS) — dev-only tenant header enabled when NODE_ENV != production
NODE_ENV=development pnpm --filter @clearview/api start   # → http://localhost:3001

# Web (Next.js) in a second shell
pnpm --filter @clearview/web dev                          # → http://localhost:3000
```

Open **http://localhost:3000/zh** — the command center (default Chinese).
Staff console: **http://localhost:3000/zh/console**.

> Config: the web talks to `NEXT_PUBLIC_API_BASE` (default `http://localhost:3001`) as tenant
> `NEXT_PUBLIC_TENANT_ID` (default tenant A `11111111-1111-1111-1111-111111111111`). Dev auth is
> the `X-Tenant-Id` header; **production replaces it with a wx.login/openid session (S0-3)** — a
> client is never trusted to choose its tenant.

---

## 2. Light up the six domains

The command center reads live data, but the domain **cues** are produced by the recommendation
sweep. In the **staff console**, click **"Run recommendation sweep"** (or
`curl -XPOST localhost:3001/recommendations/sweep -H 'X-Tenant-Id: 11111111-1111-1111-1111-111111111111'`).
Then open the command center — the AI Co-Pilot feed now shows a ranked, evidence-backed cue in
**every one of the six domains**.

---

## 3. Acceptance checklist

| # | Check | How to see it |
|---|-------|---------------|
| 1 | **report → conflict → photo → verified** | In the console, pick/create a `room_turnover` task, send a **scan report** → the cross-verification ledger shows **conflict @0.50**; **upload a snapshot** linked to it → the evidence hook re-verifies → **verified @0.855**. (The seeded Room-3 story already shows this conflict→verified pair in the ledger panel.) |
| 2 | **a cue in each of the six domains** | After the sweep, the Co-Pilot feed shows cues tagged **patient_flow, staff, inventory, financial, marketing, equipment** — each with a reason, evidence chips, and a confidence bar. |
| 3 | **approve = intent only** | Click **Approve** on any cue → it leaves the open feed and a `recommendation.approved` event is recorded, but **no world state changes** (the underlying object is untouched). Write-backs are S4, behind this gate. |
| 4 | **tenant isolation** | Point the web at tenant B (`NEXT_PUBLIC_TENANT_ID=22222222-2222-2222-2222-222222222222`) or `curl … -H 'X-Tenant-Id: 2222…'` — you see only B's objects and **none of A's cues**. RLS (`withTenant()`) is the only data path. |
| 5 | **trilingual** | Top-right switcher: **中文 / English / 日本語**, default Chinese. Every tile, cue label, and ledger/ comms string localizes. |

---

## 4. What drives what (the loop)

```
staff console (mini-app stand-in)
   report / scan / upload  ─▶  cross-verify  ─▶  conflict / pending / verified  ─▶  Alert
                                                                                     │
recommendation sweep  ─▶  6 domain agents  ─▶  conductor (de-conflict · rank · cap)  ─▶  cues
   command center: podium tempo · six-domain tiles · Co-Pilot cue feed · ledger · live comms · loop strip (SSE-live)
   manager approves  ─▶  intent recorded (no world write until S4)
```

Deterministic throughout; the LLM scorer / re-ranker / phrasing are pluggable seams. Tenants A/B
are fully isolated; every mutation goes through `withTenant()`.
