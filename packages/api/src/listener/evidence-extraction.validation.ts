import {
  EvidenceExtractionError,
  type EvidenceExtractionBasis,
  type EvidenceExtractionItemV1,
  type EvidenceExtractionOutputV1,
  type EvidenceExtractionPolarity,
  type EvidenceExtractionRequestV1,
} from './evidence-extraction.types';
import { MVP_TASK_TYPES } from '@clearview/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASES: EvidenceExtractionBasis[] = ['reported_text', 'document_text', 'unknown'];
const POLARITIES: EvidenceExtractionPolarity[] = ['affirmed', 'negated', 'uncertain'];
const LOCALES = ['zh', 'en', 'ja'];
const DOMAINS = [
  'patient_flow',
  'staff',
  'inventory',
  'equipment',
  'financial',
  'marketing',
  'general',
];
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'summary',
  'extractions',
  'ambiguities',
  'llmConfidence',
]);
const ITEM_KEYS = new Set(['basis', 'subjectHint', 'predicate', 'value', 'polarity', 'observedAt']);

/** Canonicalized key names that would cross the Listen → Verify moat. */
const FORBIDDEN_KEYS = new Set([
  'verificationresult',
  'verificationscore',
  'verificationconfidence',
  'verifiedstate',
  'flowstate',
  'claimedstatus',
  'claimedstate',
  'expectedstate',
]);

const canonicalKey = (key: string): string => key.replace(/[_-]/g, '').toLowerCase();

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  const obj = objectOf(value);
  if (!obj) return false;
  return Object.entries(obj).some(
    ([key, nested]) => FORBIDDEN_KEYS.has(canonicalKey(key)) || containsForbiddenKey(nested),
  );
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function nullableString(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function nullableIso(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= 500 ? value : undefined;
  return undefined;
}

/**
 * Strictly validate untrusted provider JSON. Unknown keys or adjudication-shaped keys fail the
 * entire run instead of being silently stripped and accidentally normalized into apparent fact.
 */
export function normalizeEvidenceExtractionOutput(raw: unknown): EvidenceExtractionOutputV1 {
  if (containsForbiddenKey(raw)) {
    throw new EvidenceExtractionError(
      'invalid_output',
      'provider output contains adjudication fields',
    );
  }
  const obj = objectOf(raw);
  if (!obj || !hasOnlyKeys(obj, TOP_LEVEL_KEYS) || obj.schemaVersion !== 1) {
    throw new EvidenceExtractionError('invalid_output', 'provider output does not match v1');
  }

  const summary = obj.summary === null ? null : nullableString(obj.summary, 500);
  if (summary === undefined) throw new EvidenceExtractionError('invalid_output', 'invalid summary');

  if (!Array.isArray(obj.extractions) || obj.extractions.length > 20) {
    throw new EvidenceExtractionError('invalid_output', 'invalid extractions');
  }
  const extractions: EvidenceExtractionItemV1[] = obj.extractions.map((rawItem) => {
    const item = objectOf(rawItem);
    if (!item || !hasOnlyKeys(item, ITEM_KEYS)) {
      throw new EvidenceExtractionError('invalid_output', 'invalid extraction item');
    }
    if (typeof item.basis !== 'string' || !BASES.includes(item.basis as EvidenceExtractionBasis)) {
      throw new EvidenceExtractionError('invalid_output', 'invalid basis');
    }
    const subjectHint = item.subjectHint === null ? null : nullableString(item.subjectHint, 200);
    const predicate = nullableString(item.predicate, 120);
    const value = scalar(item.value);
    if (
      subjectHint === undefined ||
      !predicate ||
      FORBIDDEN_KEYS.has(canonicalKey(predicate)) ||
      value === undefined ||
      typeof item.polarity !== 'string' ||
      !POLARITIES.includes(item.polarity as EvidenceExtractionPolarity)
    ) {
      throw new EvidenceExtractionError('invalid_output', 'invalid extraction item fields');
    }
    const observedAt = nullableIso(item.observedAt);
    if (observedAt === undefined) {
      throw new EvidenceExtractionError('invalid_output', 'invalid observedAt');
    }
    return {
      basis: item.basis as EvidenceExtractionBasis,
      subjectHint,
      predicate,
      value,
      polarity: item.polarity as EvidenceExtractionPolarity,
      observedAt,
    };
  });

  if (!Array.isArray(obj.ambiguities) || obj.ambiguities.length > 20) {
    throw new EvidenceExtractionError('invalid_output', 'invalid ambiguities');
  }
  const ambiguities = obj.ambiguities.map((value) => {
    const text = nullableString(value, 300);
    if (!text) throw new EvidenceExtractionError('invalid_output', 'invalid ambiguity');
    return text;
  });

  const llmConfidence = obj.llmConfidence;
  if (
    llmConfidence !== null &&
    (typeof llmConfidence !== 'number' ||
      !Number.isFinite(llmConfidence) ||
      llmConfidence < 0 ||
      llmConfidence > 1)
  ) {
    throw new EvidenceExtractionError('invalid_output', 'invalid llmConfidence');
  }

  return {
    schemaVersion: 1,
    summary,
    extractions,
    ambiguities,
    llmConfidence: llmConfidence === null ? null : (llmConfidence as number),
  };
}

export function validateEvidenceExtractionRequest(request: EvidenceExtractionRequestV1): void {
  if (
    request?.schemaVersion !== 1 ||
    request.modality !== 'text' ||
    !request.evidenceRef ||
    typeof request.evidenceRef.sourceTable !== 'string' ||
    typeof request.evidenceRef.field !== 'string' ||
    !UUID_RE.test(request.evidenceRef.sourceId)
  ) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid evidence reference');
  }
  const occurredAt = new Date(request.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid occurredAt');
  }
  if (
    request.terminalId !== undefined &&
    request.terminalId !== null &&
    (typeof request.terminalId !== 'string' ||
      request.terminalId.length < 1 ||
      request.terminalId.length > 128)
  ) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid terminalId');
  }
  if (
    request.locale !== undefined &&
    request.locale !== null &&
    !LOCALES.includes(request.locale)
  ) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid locale');
  }
  const domain = request.context?.domain;
  const taskType = request.context?.taskType;
  if (domain !== undefined && domain !== null && !DOMAINS.includes(domain)) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid domain context');
  }
  if (
    taskType !== undefined &&
    taskType !== null &&
    !(MVP_TASK_TYPES as readonly string[]).includes(taskType)
  ) {
    throw new EvidenceExtractionError('source_not_allowed', 'invalid task context');
  }
}
