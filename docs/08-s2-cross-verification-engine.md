# S2 实现规格 · 交叉验证引擎(核心资产)(for engineer)

## Goal & scope

**Goal — the core asset.** Given a **claim** (a report/communication asserting an object reached a state), reconcile it against **independent evidence** to produce a **verification**: a `verified_state` + `confidence`, appended to the immutable `verification_ledger`, reflected onto the object, and surfaced live on the command center. Fire **triggers** (Alerts) on conflict / low-confidence / missing-required / overdue. All inputs already exist: structured reports (S1-2), QR-scan + attachment evidence links (S1-2/S1-3), SOP timing, cross-object consistency.

**In scope:** the verification engine for the 5 MVP task types (room_turnover, pretest_done, dilation_started, inventory_reorder, equipment_calibration); scoring; state machine; triggers; ledger writes; events + SSE.

**Out of scope (later):** Recommendation generation & domain agents (S3), the LLM free-text/voice scorer (pluggable, ticket-later), the manager-facing action write-backs. This engine only decides *is the claim true, and how sure are we* — it does not act.

**Owner:** E2 · **Estimate:** 4–5 person-days · **Depends on:** S1-1, S1-2, S1-3 (all merged).

**Design tenet — deterministic first.** The MVP scorer is **rule-based and explainable** (auditable, testable), not a black-box LLM. That is exactly what makes cross-verification a *valuable asset*: every verdict returns its reason + evidence breakdown. An LLM scorer is a later pluggable add-on for free-text/voice nuance.

## Trigger & claim model (when it runs)

The engine is **event-driven**, re-entrant, and idempotent.

**Runs on:**
- `object.state.claimed` — a report/communication asserted a new claimed_state on a Task (or other operational object).
- `evidence.attached` — new evidence linked to an object → **re-score** (this is what flips conflict→verified when a photo arrives later).
- A periodic **sweep** — for time-based triggers (object past `expectedBy`, required evidence missing past deadline).

**A claim** = { object, claimedState, claimedBy (Communication/Staff), claimedAt }. The engine resolves the object's task type (`properties.taskType`) to load its SOP config: `expectedState`, `expectedDurationMin`, `requiredEvidence`, and a `confidenceThreshold` (from S0-7 config; sensible defaults until frozen).

**Re-scoring rule:** a later run supersedes the object's current `verified_state`/`confidence` but **never mutates prior ledger rows** — it appends a new one. The ledger is the append-only history; the object holds the latest.

## Evidence model (sources & how fetched)

For a claim on object X, gather evidence by walking ontology links (`references` → X) and X's own fields:

| Evidence type | Source | Strength |
|---|---|---|
| **QR scan** | scan events referencing X (visit code / equipment-asset tag) | **highest** — timestamped, proves presence, hard to fake |
| Snapshot / Document | attachments linked to the claim (S1-3), matched against `requiredEvidence` kinds | high (photo/screenshot) / medium (doc) |
| Corroborating communication | a second report/staff referencing the same object+state | medium |
| Timing | actual elapsed vs SOP `expectedDurationMin` / `expectedBy` | signal (too-fast or too-slow = suspicious) |
| Cross-object consistency | do linked objects contradict the claim? (e.g. room claimed ready but a Visit still occupying it) | signal / can flip to conflict |

Normalize each into `{ type, supports|contradicts, weight, sourceTrust, recency }`. Independence matters: two pieces from the *same* actor/source count less than two independent ones.

## Confidence scoring & required evidence

**Required-evidence gate (hard rule first):** each task type declares `requiredEvidence` (e.g. room_turnover requires a snapshot; equipment_calibration requires a doc; 'use equipment' requires an equipment-tag QR scan). If a required item is **missing** → state is capped at **Pending** (never Verified), regardless of score.

**Score (deterministic, explainable):**
```
confidence = clamp(
    base
  + Σ( weight × sourceTrust × recency )   over corroborating evidence
  − conflictPenalty            (contradictory evidence or cross-object contradiction)
  − missingRequiredPenalty     (required evidence absent)
  − timingAnomalyPenalty       (deviates from SOP timing)
, 0, 1)
```
Indicative weights (tune in config): QR scan 0.45 · matching snapshot 0.30 · corroborating comm 0.20 · doc 0.25; base 0.30 for a lone self-claim. Recency decays over time. **Return the full breakdown** (which items contributed what) — the reason string is built from it.

**Thresholds (per task type, default):** Verified ≥ 0.85 (and all required present, no contradiction); Conflict if any contradiction/timing-anomaly with missing corroboration; Pending if required missing or 0.5–0.85; Unverified if only a bare claim.

## Verified-state machine, triggers & ledger

**States:** `unverified → pending → verified` / `conflict` (re-scoring can move between pending/conflict/verified as evidence arrives).

**Triggers (create an Alert object + event) when:**
- verdict = **conflict**;
- confidence **below** the task type threshold;
- **required evidence missing** past its deadline (sweep);
- object past **`expectedBy`** still not verified (sweep).

Alerts carry {objectId, reason, evidence summary, severity}. (Recommendations that act on Alerts = S3; here we only raise them.)

**Ledger writes (the asset):** on each (re)scoring, **append** one `verification_ledger` row `{ tenantId, objectId, verifiedState, confidence, evidence(jsonb), reason }` — immutable, per S0-2 (append-only enforced). Then update the object's `verified_state` + `confidence` (the state triplet's verified slot) and emit **`object.state.verified`**; publish via SSE so the command center updates live. All within one `withTenant()` transaction; publish after commit.

## Worked example, tests & DoD

**Worked example (structure-design §4, must be reproduced by a test):**
```
09:20  claim room_turnover(Room 3)=ready  [comm only; required snapshot MISSING;
       prior checkout 2 min ago → timing anomaly]
   → required-missing gate → Pending; timing anomaly + no corroboration → CONFLICT, conf 0.76
   → ledger row #1 appended; object.verified_state=conflict; Alert raised; SSE → dashboard
09:34  evidence.attached: turnover snapshot linked to the task
   → re-score: required now present + snapshot(0.30) + timing OK → VERIFIED, conf 0.93
   → ledger row #2 appended; object.verified_state=verified; SSE → dashboard flips
```

**Tests**
- Unit: scorer breakdown (each evidence type contributes expected weight); required-evidence gate caps at Pending; timing-anomaly & cross-object-contradiction → conflict; threshold boundaries; determinism (same inputs → same score).
- Integration (pgvector service): claim → verify → ledger append + object.verified_state + `object.state.verified` event; re-score on evidence.attached (conflict→verified, TWO ledger rows, object updated); sweep raises overdue/missing-required Alerts; **cross-tenant isolation** (verify only sees own tenant's evidence).
- Realtime: verdict change is delivered to same-tenant SSE subscriber, not another tenant.

**Definition of Done**
- [ ] Deterministic, explainable scorer with a required-evidence gate and per-task-type thresholds.
- [ ] QR scan + attachment + corroborating comm + timing + cross-object consistency all factored, each with a returned breakdown/reason.
- [ ] Verdict appended to `verification_ledger` (immutable); object `verified_state`+`confidence` updated; `object.state.verified` emitted; SSE live.
- [ ] Triggers raise Alerts on conflict / low-confidence / missing-required / overdue.
- [ ] Re-scoring on new evidence works (Room-3 story test passes); idempotent; `withTenant()` only; cross-tenant + CI green.
- [ ] LLM scorer left as a clean pluggable seam (not implemented here).
