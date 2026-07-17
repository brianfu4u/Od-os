import { describe, expect, it } from 'vitest';
import { EvidenceExtractionError } from './evidence-extraction.types';
import {
  normalizeEvidenceExtractionOutput,
  validateEvidenceExtractionRequest,
} from './evidence-extraction.validation';

const valid = {
  schemaVersion: 1,
  summary: 'The note reports that room 3 is ready.',
  extractions: [
    {
      basis: 'reported_text',
      subjectHint: 'Room 3',
      predicate: 'readiness_reported',
      value: true,
      polarity: 'affirmed',
      observedAt: null,
    },
  ],
  ambiguities: [],
  llmConfidence: 0.83,
};

describe('EvidenceExtractionTemplateV1 validation', () => {
  it('accepts the verdict-free v1 output and normalizes timestamps', () => {
    const output = normalizeEvidenceExtractionOutput({
      ...valid,
      extractions: [{ ...valid.extractions[0], observedAt: '2026-07-17T01:02:03Z' }],
    });
    expect(output).toMatchObject({ schemaVersion: 1, llmConfidence: 0.83 });
    expect(output.extractions[0]!.observedAt).toBe('2026-07-17T01:02:03.000Z');
  });

  it.each([
    { verificationResult: 'consistent' },
    { verification_score: 0.9 },
    { nested: { verificationConfidence: 0.8 } },
    { extractions: [{ claimedState: 'done' }] },
    { flow_state: 'closed' },
    {
      extractions: [{ ...valid.extractions[0], predicate: 'verification_result' }],
    },
  ])('fails closed when provider JSON contains adjudication key %#', (hostile) => {
    try {
      normalizeEvidenceExtractionOutput({ ...valid, ...hostile });
      throw new Error('expected invalid_output');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceExtractionError);
      expect((error as EvidenceExtractionError).code).toBe('invalid_output');
    }
  });

  it('rejects unknown shape, overlong lists, nested values, and invalid confidence', () => {
    expect(() => normalizeEvidenceExtractionOutput({ ...valid, safeExtra: true })).toThrow();
    expect(() =>
      normalizeEvidenceExtractionOutput({
        ...valid,
        extractions: Array(21).fill(valid.extractions[0]),
      }),
    ).toThrow();
    expect(() =>
      normalizeEvidenceExtractionOutput({
        ...valid,
        extractions: [{ ...valid.extractions[0], value: { x: 1 } }],
      }),
    ).toThrow();
    expect(() => normalizeEvidenceExtractionOutput({ ...valid, llmConfidence: 1.1 })).toThrow();
  });

  it('accepts only a text reference request with a UUID and ISO timestamp', () => {
    expect(() =>
      validateEvidenceExtractionRequest({
        schemaVersion: 1,
        evidenceRef: {
          sourceTable: 'patient_scans',
          sourceId: '11111111-1111-1111-1111-111111111111',
          field: 'optional_note',
        },
        modality: 'text',
        occurredAt: '2026-07-17T01:02:03Z',
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceExtractionRequest({
        schemaVersion: 1,
        evidenceRef: {
          sourceTable: 'patient_scans',
          sourceId: 'not-a-uuid',
          field: 'optional_note',
        },
        modality: 'text',
        occurredAt: 'not-a-date',
      }),
    ).toThrow();
  });
});
