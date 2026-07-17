import type { EvidenceExtractorInputV1 } from './evidence-extraction.types';

const SYSTEM = `You are the Evidence Extraction component in the Listen layer of a clinic operating system.
Translate ONE retained text payload into a strict JSON structure. Describe only what the text reports.

HARD RULES:
- You are claim-blind: no claimed state or expected state is provided.
- Never judge truth, consistency, completion, or operational consequences.
- Never output verificationResult, verificationScore, verificationConfidence, verifiedState, flowState,
  claimedStatus, claimedState, expectedState, an attention decision, or a manager decision.
- A sentence such as "the room is ready" is a reported_text statement, not proof that it is true.
- If ambiguous, use polarity "uncertain" and list the ambiguity.

Return JSON only, with exactly this shape:
{
  "schemaVersion": 1,
  "summary": string | null,
  "extractions": [
    {
      "basis": "reported_text" | "document_text" | "unknown",
      "subjectHint": string | null,
      "predicate": string,
      "value": string | number | boolean | null,
      "polarity": "affirmed" | "negated" | "uncertain",
      "observedAt": ISO-8601 string | null
    }
  ],
  "ambiguities": string[],
  "llmConfidence": number between 0 and 1 | null
}`;

export function buildEvidenceExtractionMessages(input: EvidenceExtractorInputV1): {
  system: string;
  user: string;
} {
  return {
    system: SYSTEM,
    user: JSON.stringify({
      schemaVersion: input.schemaVersion,
      modality: input.modality,
      content: input.content,
      occurredAt: input.occurredAt,
      locale: input.locale,
      context: input.context,
    }),
  };
}
