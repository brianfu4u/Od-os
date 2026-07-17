import { describe, expect, it, vi } from 'vitest';
import type { EvidenceExtractionRepository } from './evidence-extraction.repository';
import { EvidenceExtractionService } from './evidence-extraction.service';
import {
  EvidenceExtractionError,
  type EvidenceExtractionRequestV1,
  type EvidenceExtractorPort,
} from './evidence-extraction.types';

const request: EvidenceExtractionRequestV1 = {
  schemaVersion: 1,
  evidenceRef: {
    sourceTable: 'patient_scans',
    sourceId: '11111111-1111-1111-1111-111111111111',
    field: 'optional_note',
  },
  modality: 'text',
  occurredAt: '2026-07-17T01:02:03Z',
  terminalId: 'ipad-1',
  locale: 'zh',
};

const validOutput = {
  schemaVersion: 1,
  summary: '员工备注报告诊室已准备。',
  extractions: [
    {
      basis: 'reported_text',
      subjectHint: '3号房',
      predicate: 'readiness_reported',
      value: true,
      polarity: 'affirmed',
      observedAt: null,
    },
  ],
  ambiguities: [],
  llmConfidence: 0.8,
};

function setup(providerOutput: unknown = validOutput) {
  const extractor: EvidenceExtractorPort = {
    name: 'fake',
    model: 'fake-v1',
    extract: vi.fn().mockResolvedValue(providerOutput),
  };
  const repo = {
    loadText: vi.fn().mockResolvedValue('3号房已经准备好了'),
    appendCompleted: vi.fn().mockResolvedValue({ eventId: 'event-completed' }),
    appendFailed: vi.fn().mockResolvedValue({ eventId: 'event-failed' }),
  } as unknown as EvidenceExtractionRepository;
  return { extractor, repo, service: new EvidenceExtractionService(extractor, repo) };
}

describe('EvidenceExtractionService — fail closed, no adjudication', () => {
  it('passes only claim-blind text/context to the adapter and records a completed extraction', async () => {
    const { extractor, repo, service } = setup();
    const result = await service.extract('tenant-a', request);
    expect(result).toMatchObject({ status: 'completed', eventId: 'event-completed' });
    expect(extractor.extract).toHaveBeenCalledWith({
      schemaVersion: 1,
      modality: 'text',
      content: '3号房已经准备好了',
      occurredAt: '2026-07-17T01:02:03.000Z',
      locale: 'zh',
      context: { domain: null, taskType: null },
    });
    const adapterInput = vi.mocked(extractor.extract).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(adapterInput)).not.toMatch(/claimed|expected|verif|flowState/i);
    expect(repo.appendCompleted).toHaveBeenCalledOnce();
    expect(repo.appendFailed).not.toHaveBeenCalled();
  });

  it('turns a hostile verdict-bearing provider response into invalid_output with no completed row', async () => {
    const { repo, service } = setup({ ...validOutput, verificationResult: 'consistent' });
    const result = await service.extract('tenant-a', request);
    expect(result).toEqual({
      status: 'failed',
      eventId: 'event-failed',
      errorCode: 'invalid_output',
    });
    expect(repo.appendCompleted).not.toHaveBeenCalled();
    expect(repo.appendFailed).toHaveBeenCalledWith(
      'tenant-a',
      request,
      expect.anything(),
      'invalid_output',
    );
  });

  it.each(['provider_timeout', 'provider_error', 'provider_unavailable'] as const)(
    'records %s and never fabricates a fallback extraction',
    async (code) => {
      const { extractor, repo, service } = setup();
      vi.mocked(extractor.extract).mockRejectedValueOnce(new EvidenceExtractionError(code));
      const result = await service.extract('tenant-a', request);
      expect(result).toEqual({ status: 'failed', eventId: 'event-failed', errorCode: code });
      expect(repo.appendCompleted).not.toHaveBeenCalled();
    },
  );

  it.each(['redacted_input', 'source_not_found', 'source_not_allowed'] as const)(
    'records a safe failure when the source loader returns %s',
    async (code) => {
      const { extractor, repo, service } = setup();
      vi.mocked(repo.loadText).mockRejectedValueOnce(new EvidenceExtractionError(code));
      const result = await service.extract('tenant-a', request);
      expect(result).toEqual({ status: 'failed', eventId: 'event-failed', errorCode: code });
      expect(extractor.extract).not.toHaveBeenCalled();
      expect(repo.appendCompleted).not.toHaveBeenCalled();
    },
  );
});
