/**
 * T-13A · LLM evidence extraction is a Listen-layer translation seam, never a verifier.
 *
 * The request is claim-blind by construction: it carries only a server-resolved pointer to one
 * retained text payload plus non-adjudicative context. The model output can describe statements in
 * that text, but it has no field that can carry a verification verdict or change operational state.
 */

export const EVIDENCE_EXTRACTOR = 'EVIDENCE_EXTRACTOR';
export const EVIDENCE_EXTRACTION_PROMPT_VERSION = 'evidence.extract/v1';

export type EvidenceExtractionLocale = 'zh' | 'en' | 'ja';
export type EvidenceExtractionBasis = 'reported_text' | 'document_text' | 'unknown';
export type EvidenceExtractionPolarity = 'affirmed' | 'negated' | 'uncertain';

export interface EvidenceRefV1 {
  sourceTable: string;
  sourceId: string;
  field: string;
}

/** Internal service request. Raw text and claim/expected state are deliberately absent. */
export interface EvidenceExtractionRequestV1 {
  schemaVersion: 1;
  evidenceRef: EvidenceRefV1;
  modality: 'text';
  occurredAt: string;
  terminalId?: string | null;
  locale?: EvidenceExtractionLocale | null;
  context?: {
    domain?: string | null;
    taskType?: string | null;
  };
}

/** Adapter-only input, populated after a tenant-scoped sensitive-payload read. */
export interface EvidenceExtractorInputV1 {
  schemaVersion: 1;
  modality: 'text';
  content: string;
  occurredAt: string;
  locale: EvidenceExtractionLocale | null;
  context: {
    domain: string | null;
    taskType: string | null;
  };
}

export interface EvidenceExtractionItemV1 {
  basis: EvidenceExtractionBasis;
  subjectHint: string | null;
  predicate: string;
  value: string | number | boolean | null;
  polarity: EvidenceExtractionPolarity;
  observedAt: string | null;
}

export interface EvidenceExtractionOutputV1 {
  schemaVersion: 1;
  summary: string | null;
  extractions: EvidenceExtractionItemV1[];
  ambiguities: string[];
  /** Model confidence in its TRANSLATION only. Never a verification score. */
  llmConfidence: number | null;
}

/** Provider adapters are side-effect free and return untrusted JSON for normalization. */
export interface EvidenceExtractorPort {
  readonly name: string;
  readonly model: string | null;
  extract(input: EvidenceExtractorInputV1): Promise<unknown>;
}

export type EvidenceExtractionErrorCode =
  | 'source_not_allowed'
  | 'source_not_found'
  | 'redacted_input'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_error'
  | 'invalid_output';

export class EvidenceExtractionError extends Error {
  constructor(
    readonly code: EvidenceExtractionErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'EvidenceExtractionError';
  }
}

export type EvidenceExtractionRunResult =
  | {
      status: 'completed';
      eventId: string;
      output: EvidenceExtractionOutputV1;
    }
  | {
      status: 'failed';
      eventId: string;
      errorCode: EvidenceExtractionErrorCode;
    };
