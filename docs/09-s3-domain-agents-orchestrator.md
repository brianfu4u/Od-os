# S3 实现规格 · 域智能体 + 指挥编排器(店长建议)(for engineer)

## Goal & scope

**Goal.** Turn S2 outputs (verifications + Alert objects + object states) into **ranked, evidence-backed manager cues** — the Co-Pilot feed the command center shows. This is the loop's Reason → Recommend stage, and it wires the event seam that closes Sense→Map→Verify→**Reason→Recommend**.

**In scope:** domain agents (candidate recommendations), the conductor orchestrator (de-conflict + rank + tempo), the Recommendation object, the read API + SSE, and the event seam that triggers agents (incl. the deferred `object.state.claimed` auto-verify wire from S2-Q2).

**Out of scope (later):** executing actions / write-backs to the world (S4 — here actions are only *proposed*, approve/dismiss just updates recommendation state); LLM phrasing of cues (deterministic first, LLM is a later pluggable polish); scheduled sweeps beyond what S2 already does.

**Design tenet:** human-in-the-loop. S3 **only proposes**; the manager approves/dismisses. No high-risk auto-execution. Deterministic rules first (explainable), consistent with S2.

**Owner:** E2 (+E3 renders cues in command center) · **Est:** 4–5 person-days · **Depends on:** S1-1, S2 (merged); consumes S0-7 config.

## Domain agents

One agent per domain (start with the three that the command-center prototype already shows cues for — **patient-flow, staff, inventory** — then equipment, financial, marketing). Each agent, on relevant events, reads its slice of the ontology and emits **candidate Recommendations** with a reason + evidence + confidence.

Each agent = a set of deterministic **detectors/functions** over ontology objects+events, e.g.:
- patient-flow: bottleneck forming (queue length + stage timing vs SOP), long-wait patient, predicted wait.
- staff: coverage gap (Shift/attendance vs assigned tasks), overdue task.
- inventory: stock-out forecast (onHand vs reorderPoint + usage).
- equipment: calibration overdue / device-blocked (from S2 Alerts).

Agents consume **S2 Alerts and verifications** as first-class inputs (an Alert = a ready-made trigger). Output shape per candidate: `{ domain, title, why, evidence[], confidence, proposedActions[], addresses: alertId? }`. Agents never write world state — they only produce candidates.

## Conductor orchestrator

The single voice to the manager. Takes all agents' candidates and:
1. **De-duplicates / de-conflicts** — collapse candidates about the same object; detect cross-domain conflicts (e.g. staff-agent says pull Jordan to pretest, but that empties optical) and annotate the trade-off on the cue.
2. **Ranks** by `severity × urgency × impact` (urgency from `expectedBy`/overdue; severity from Alert; impact configurable). Cap the active feed (e.g. top N) so the manager isn't flooded.
3. **Maintains Operating Tempo** — a rolled-up health score for the podium header (from open conflicts, overdue, on-time %).
4. Persists the surviving candidates as **Recommendation** objects, `addresses` → Alert, and emits `recommendation.created`.

Deterministic ranking now; the orchestrator is the seam where an LLM could later re-rank/plain-word the cues.

## Recommendation object, API & SSE

**Recommendation** (a generic `objects` type, per ontology):
```
properties: {
  domain, title, why,
  evidence: [ {kind, ref, note} ],      // links to the verification/scan/snapshot behind it
  confidence,
  actions: [ {label, actionType, riskTier: low|high, needsApproval} ],
  rank, status: open|approved|dismissed|snoozed,
  sourceAgent
}
links: Recommendation --addresses--> Alert;  --references--> the object(s)
```
**API (tenant-scoped, `withTenant()`):**
- `GET /recommendations?status=open&limit=` — ranked feed for the command center.
- `POST /recommendations/:id/approve|dismiss|snooze` — updates status, emits `recommendation.<action>` (approve does NOT execute the world action in S3 — it records intent + emits an event for S4/audit).
- SSE: `recommendation.created` / status changes pushed to the tenant's stream so the cue feed updates live.

This is exactly what the command-center prototype's AI Co-Pilot panel renders (title / why / evidence chips / confidence / approve·dismiss / source agent).

## Event seam (closes the loop)

Wire the event-driven loop (this absorbs the deferred S2-Q2 `object.state.claimed` wiring):
- `object.state.claimed` → call `VerificationService.verifyObject` (auto-verify on new claim) — the piece parked from S2.
- `object.state.verified` / `Alert.created` / `evidence.attached` → fan out to the relevant domain agent(s) → orchestrator → Recommendation.

Keep it a thin, testable subscriber (an EventBus/`LISTEN` consumer) so the flow is: report/scan → verify → alert → agent → orchestrator → ranked cue → SSE → dashboard. Idempotent; `withTenant()` only; publish after commit.

## Tests & DoD

**Tests**
- Unit: each detector fires on the right condition with a correct reason/evidence; orchestrator ranking order; de-conflict annotation (the Jordan→pretest vs optical trade-off case); feed cap.
- Integration (pgvector service): a conflict Alert from S2 → produces a ranked Recommendation with evidence links; approve/dismiss updates status + emits event; **cross-tenant** isolation (manager A never sees B's cues).
- End-to-end (extends the Room-3 test): staff reports + uploads photo → verify → (if conflict) Alert → patient-flow/staff agent → orchestrator → a cue appears in `GET /recommendations` with the verification as evidence.
- Realtime: `recommendation.created` delivered to same-tenant SSE subscriber only.

**Definition of Done**
- [ ] ≥3 domain agents (patient-flow, staff, inventory) emit candidate recommendations from Alerts/verifications with reason + evidence + confidence.
- [ ] Orchestrator de-conflicts, ranks (severity×urgency×impact), caps the feed, computes Operating Tempo, persists Recommendation objects.
- [ ] `GET /recommendations` ranked feed + approve/dismiss/snooze + SSE; matches the command-center Co-Pilot shape.
- [ ] Event seam wires claimed→verify and verified/alert→agent→cue; end-to-end test passes.
- [ ] Human-in-the-loop: approve records intent only (no world write in S3); `withTenant()` only; cross-tenant + CI green.
- [ ] Deterministic; LLM re-rank/phrasing left as a clean seam.
