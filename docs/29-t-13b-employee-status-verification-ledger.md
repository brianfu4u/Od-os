# T-13B · Employee-status verification ledger and read bridge

## Purpose

T-13B creates the persistence boundary needed by a future deterministic employee-status classifier.
It does not implement that classifier and does not decide whether any employee claim is true.

## Physical separation

`employee_status_verification_ledger` is separate from both immutable claim history and the generic
S2 `verification_ledger`:

- employee claim vocabulary: `on_duty | busy | idle | rest | off_duty`
- employee consistency vocabulary: `consistent | inconsistent | insufficient_evidence`
- generic object verification vocabulary remains unchanged in its existing table

Each verification row references exactly one `employee_status_claims.id`. UPDATE and DELETE are
blocked by `forbid_mutation()`, and FORCE RLS scopes reads and inserts to the active tenant.

## Write bridge

`EmployeeStatusVerificationService.append()` is an internal strict boundary. It accepts a claim ID,
employee consistency result, deterministic `verificationScore`, minimized evidence references,
reason, and actor. Unknown fields are rejected, including `llmConfidence`; no LLM confidence can be
renamed or copied into the deterministic score slot. A NULL score means no deterministic score was
produced and is not replaced with an invented default.

The bridge contains no classifier, provider call, threshold, or employee-status business rule.

## T-06 read switch

The T-06 repository first selects the latest appended claim for each employee, then selects only the
latest verification ledger row attached to that exact claim. A new claim therefore has NULL
verification facts until a new ledger row is appended; it never inherits a prior claim's verdict.

The four T-06 pure rule functions and their configuration are unchanged. In particular, the existing
comparison remains `verificationScore < 0.60`, so 0.59 enters the attention queue and 0.60 does not.

## Migration and rollback

Migration 0023 creates the ledger, indexes, subject-integrity trigger, append-only trigger, grants,
and FORCE RLS. Legacy non-NULL claim verdicts are copied once into ledger rows with a migration
marker; claims are not mutated and NULL scores remain NULL. Re-running the migration does not append
duplicate backfill rows.

Rollback the application read switch and writer wiring first. The ledger is append-only evidence and
must not be deleted as an application rollback. A later reviewed migration may retire obsolete claim
columns after compatibility and retention decisions; T-13B deliberately does not alter them.
