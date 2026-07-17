# T-13A · EvidenceExtractionTemplateV1

## Purpose

T-13A adds an internal, text-only translation seam in the Listen layer. It turns one explicitly
selected retained text payload into structured reported-text extractions. It does not compare the
text with a claim, does not decide whether anything is true, and cannot write operational state.

There is no HTTP controller, event subscription, photo consumer, Correlator, or automatic call path
in this ticket. A future authorized caller must select the evidence reference explicitly.

## Input

The service request contains a server-resolved `(sourceTable, sourceId, field)` pointer, modality,
timestamp, optional terminal/locale, and optional non-adjudicative domain/task context. It does not
contain raw text, `claimId`, claimed state, expected state, or any verification field.

The service resolves raw text only through `sensitive_payloads`. A missing or redacted payload fails
closed; it never falls back to the append-only source column.

Currently allow-listed retained text fields:

- `patient_scans.optional_note`
- `llm_analysis_log.input`

## Output

`EvidenceExtractionOutputV1` contains:

- `schemaVersion: 1`
- a sensitive human summary
- up to 20 structured reported/document-text extraction items
- ambiguities
- `llmConfidence`, meaning confidence in translation only

The strict validator rejects the entire provider output if it contains any adjudication-shaped key,
including verification result/score/confidence, verified/flow state, claimed state/status, or expected
state. Unknown output keys and invalid shapes also fail closed.

## Persistence and privacy

Every valid attempt appends one immutable `event_log` skeleton:

- `evidence.extraction.completed`, or
- `evidence.extraction.failed`

The event payload contains only the evidence pointer, adapter/model, prompt/schema versions,
translation confidence/count, or a bounded failure code. Raw input and translated output never enter
the event payload. The full normalized output is written atomically to `sensitive_payloads` as
`(source_table='event_log', source_id=<event_id>, field='extraction_output')` and follows the existing
retention/redaction rules.

No `verification.completed` DomainEventBus event is published. T-06, the six domain agents,
recommendations, claims, verified state, and flow state are untouched.

## Provider behavior

DeepSeek reuses the current environment configuration and JSON endpoint. With no key, when external
providers are disabled, on timeout, or on provider/JSON failure, extraction fails closed. There is no
heuristic fallback because a fallback must not manufacture evidence observations.

Real-provider cost/latency testing and multimodal/photo extraction are separate deployment/future
tickets. Photos remain unconsumed until the Correlator supplies safe attribution.
