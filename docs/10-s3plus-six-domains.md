# S3+ 实现规格 · 补齐六大域 agent(财务/营销/设备)(for engineer)

## Goal & scope

**Goal.** Round out the 360-degree coverage: add three more domain agents — **financial, marketing, equipment** — so all six command-center domains produce ranked, evidence-backed cues (matching the trilingual prototype). Reuse the S3 framework unchanged: DomainEventBus → agents → conductor orchestrator → Recommendation, and the /recommendations feed + SSE.

**In scope:** three new deterministic domain agents (detectors), their evidence + reason + confidence, seed data so each fires at least one demo cue, and the command-center tiles for these domains showing real metrics.

**Out of scope:** write-backs (S4); LLM phrasing (seam). **Advise-only, human-in-the-loop** (approve = intent only), `withTenant()` only — same invariants as S3.

**Owner:** E2 (+E3 for the three tiles) · **Est:** 3–4 person-days · **Depends on:** S3, S2, S0-7 (all merged).

**Pattern (same as existing 3 agents):** each agent is a set of pure detectors over ontology objects/events; on relevant events (or a periodic sweep) it emits candidate Recommendations `{ domain, title, why, evidence[], confidence, proposedActions[], addresses: alertId? }`; the orchestrator de-conflicts, ranks, caps, and persists. No agent writes world state.

## Financial agent

**Objects:** Invoice, Claim, Payment.

**Detectors (each → candidate cue with reason + evidence + confidence):**
- **Unposted charges/copays**: Invoice/Payment claimed collected but not verified-posted (state triplet: claimed=collected, verified≠posted) beyond a short window → cue 'N unposted copays — reconcile'.
- **Claim missing info**: Claim missing a required field (e.g. referral) → cue 'Claim #x missing referral — will delay reimbursement' (matches prototype). Evidence: the Claim object + the missing-field list.
- **Collections vs goal** (info): today collected far below expected pace → low-severity info cue.

**Tile metrics:** collected today, unposted count. **Status:** steady / watch / act by thresholds (config, per S0-7 style).

## Marketing agent

**Objects:** Review, Lead, Campaign.

**Detectors:**
- **Negative review breaching SLA**: Review with low rating (e.g. ≤2★) unanswered past the response SLA (age > SLA minutes) → cue 'N★ review Xm ago, unanswered (SLA<60m)' (matches prototype). Evidence: the Review + age; link to any related flow delay if present (cross-object).
- **Aging/unworked leads**: Lead with no follow-up past a threshold → cue 'K leads unworked > T'.
- **Campaign anomaly** (info): a campaign KPI drop/spike.

**Tile metrics:** new leads, negative-review count. **Actions proposed (intent only in S3):** draft reply / assign owner (no send).

## Equipment agent

**Objects:** Equipment (+ the equipment_calibration Task type and QR-scan usage events).

**Detectors (uses S0-7 config):**
- **Calibration overdue**: last calibration older than `calibrationValidDays` (S0-7 = 30) → cue 'OCT #2 calibration overdue — result validity at risk'. If bookings exist before the next window, propose 'block device · route to backup' (intent only). Matches prototype.
- **Used-while-overdue**: a QR usage scan on a device past its calibration window → conflict-flavored cue (result validity flag).
- **Device blocked / maintenance** (info).

**Tile metrics:** ready count (e.g. 6/7), due-calibration count. **Evidence:** device log + calibration date + any usage scan (QR = strong).

## Orchestrator, tiles & seed

- **Orchestrator:** no structural change — it now ranks candidates across all six domains. Verify cross-domain de-conflict still holds (e.g. equipment 'block device' vs an existing booking should annotate the trade-off, like the Jordan→pretest/optical case). Operating Tempo now factors all six domains.
- **Command center tiles:** wire the financial / marketing / equipment tiles to real metrics (from GET /overview or a per-domain read), with status colors; cues from these agents appear in the Co-Pilot feed with their source-agent tag — exactly as the prototype shows.
- **Seed:** extend the synthetic seed so each new domain has at least one object that fires a cue (a claim missing a referral; a 2★ review 41m old; an OCT #2 calibration 31 days old) — so the demo shows all six domains live. Keep it synthetic/privacy-safe.

## Tests & DoD

**Tests**
- Unit: each detector fires only on its condition, with correct reason/evidence/confidence; thresholds read from config.
- Integration (pg service): each of the 3 domains produces a ranked Recommendation end-to-end from seed; orchestrator ranks across all six; cross-tenant isolation (A never sees B's cues).
- Realtime: new cues delivered to same-tenant SSE only.
- Extend the HTTP smoke: after seed, GET /recommendations returns cues spanning ≥4 domains incl. at least one each from financial/marketing/equipment.

**Definition of Done**
- [ ] financial, marketing, equipment agents implemented as deterministic detectors feeding the orchestrator.
- [ ] Each emits reason + evidence + confidence; equipment uses S0-7 calibrationValidDays; marketing uses the review SLA.
- [ ] Command-center tiles for all six domains show real metrics + status; cues appear with source-agent tags.
- [ ] Seed fires ≥1 cue per new domain; HTTP smoke covers them.
- [ ] advise-only (approve = intent only); withTenant() only; cross-tenant + full CI green.
- [ ] Deterministic; LLM phrasing left as a seam.
