# Known Issues — Compliance / Data Protection

This file is the engineering-side register of **known, accepted-for-now** compliance risks. It is a
living checklist for the product owner (Brian) to walk through with a business/legal compliance
advisor. Engineering records the technical facts and mitigations here; it does **not** make the legal
determination. Items whose resolution depends on a legal/regulatory reading are explicitly marked
**待商务/法务确认 (pending business/legal confirmation)** and must not be read as "already verified".

| ID | Title | Level | Status |
|----|-------|-------|--------|
| KI-001 | Sensitive skeleton source columns remain plaintext at rest | 中 (Medium) | Open — mitigated, physical purge deferred |

---

## KI-001 · Sensitive skeleton source columns remain plaintext at rest

**Recorded:** P1-6-d (存量脱敏回填 + 读路径收口)
**Level:** 中 (Medium)
**Status:** Open — mitigated at the API layer; physical purge of source columns deferred.

### What the issue is

The append-only skeleton tables keep the *originally written* sensitive raw content in plaintext,
physically, on disk, for the lifetime of the row:

- `patient_scans.patient_code` (raw scanned patient code, kept verbatim)
- `patient_scans.optional_note`
- `llm_analysis_log.input` (text analyzed by LLM1)
- `llm_analysis_log.output` (jsonb)

P1-6-b introduced a **redactable side-store** (`sensitive_payloads`) that mirrors this content, and the
retention sweep (P1-6-b/-d) redacts the *side-store* copy once it is older than the configured window.
P1-6-d additionally (a) backfilled existing rows into the side-store so the sweep reaches historical
data, and (b) closed the manager read paths (`attention.reveal`, `/listen/summary`) so they resolve
sensitive content **only** from the redactable side-store, never from the source column.

**However**, the source columns themselves are on **append-only** tables (`forbid_mutation()` trigger,
`GRANT SELECT, INSERT` only). By design (P0-1) they cannot be UPDATEd, DELETEd, or have a column
dropped — "数据库层约束是最后一道防线、不能被绕过". So even after the side-store copy is redacted, the
**plaintext still exists physically in the source column**. It is simply no longer *reachable through
the API* (no read path reads it for sensitive content, and it is masked/absent everywhere it surfaces).

### Impact scope

- All existing and future rows in `patient_scans` and `llm_analysis_log` that carry the fields above.
- Risk is **at-rest data** (DB dumps, backups, direct DB/superuser access), **not** the running API
  surface: from the application layer the plaintext is unreadable once the side-store copy is redacted.
- No employee-facing or manager-facing surface exposes the source-column plaintext after redaction.

### Current mitigations (already shipped)

1. **Read-path closure (P1-6-d, D-choice-1):** `attention.reveal` and `/listen/summary` read the raw
   content from `sensitive_payloads` (live payloads only); a redacted/absent payload returns
   `redacted` / no text. The plaintext source column is never surfaced by the API.
2. **Display masking (P1-6-f):** queue/board show `maskScanCode()` output (e.g. `PT-****`).
3. **Audited, manager-only reveal (P1-6-f):** the only raw-reveal endpoint is manager-gated and writes
   a `sensitive.raw.accessed` audit event.
4. **Retention sweep (P1-6-b/-d):** side-store copies are redacted after the retention window; backfill
   (E-1) ensures historical rows are covered.
5. **Provider downgrade switch (P1-6-c):** external providers can be disabled without deleting keys.

### Why not resolved now (chosen: D-choice-1, zero architecture change)

Physically purging the source columns would require either UPDATE-ing an append-only table, dropping a
column, or in-place encryption — each of which opens the append-only "last line of defence" that P0-1
mandates must never be bypassed, "哪怕是一次性的". D-choice-1 accepts the residual at-rest risk in
exchange for **not** opening that invariant, and records the residual here instead of hiding it in a
code comment.

> **待商务/法务确认:** Whether plaintext-at-rest in these source columns is acceptable under APPI (and
> any other applicable regime) is a **business/legal** determination. Engineering makes **no** claim
> that the current state is or is not APPI-compliant. This item exists so that judgement can be made
> explicitly with a compliance advisor.

### Follow-up plan

- **A1 (deferred):** If, and only if, the compliance advisor determines that plaintext-at-rest in the
  source columns does **not** satisfy APPI (or another applicable requirement), engineering will scope
  a **forward migration** to physically purge the historical source-column plaintext. That migration
  must be designed to satisfy the P0-1 append-only principle (e.g. a controlled, reviewed, one-way
  purge migration rather than an ad-hoc UPDATE), and will be raised as its own ticket.
- **Trigger:** legal/compliance advisor concludes source-column plaintext at rest is insufficient for
  APPI (or another regime).
- **Owner:** Brian (product) — owns the advisor conversation and the go/no-go on A1. Engineering
  executes a migration ticket only after the advisor's conclusion.

### Retention window note

The retention window (`RETENTION_RAW_CONTENT_DAYS`, default 30) is **provisional** and itself pending
APPI confirmation (see `docs/compliance/external-providers.md`). This is **待商务/法务确认**.
