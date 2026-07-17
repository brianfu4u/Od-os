import { Inject, Injectable, Logger } from '@nestjs/common';
import { EvidenceExtractionRepository } from './evidence-extraction.repository';
import {
  EVIDENCE_EXTRACTOR,
  EvidenceExtractionError,
  type EvidenceExtractionErrorCode,
  type EvidenceExtractionRequestV1,
  type EvidenceExtractionRunResult,
  type EvidenceExtractorPort,
} from './evidence-extraction.types';
import {
  normalizeEvidenceExtractionOutput,
  validateEvidenceExtractionRequest,
} from './evidence-extraction.validation';

/**
 * Internal-only T-13A service. There is deliberately no controller and no event subscription:
 * future Correlator code must explicitly select an authorized evidence reference before calling it.
 */
@Injectable()
export class EvidenceExtractionService {
  private readonly logger = new Logger(EvidenceExtractionService.name);

  constructor(
    @Inject(EVIDENCE_EXTRACTOR) private readonly extractor: EvidenceExtractorPort,
    private readonly repository: EvidenceExtractionRepository,
  ) {}

  async extract(
    tenantId: string,
    request: EvidenceExtractionRequestV1,
  ): Promise<EvidenceExtractionRunResult> {
    try {
      validateEvidenceExtractionRequest(request);
      const content = await this.repository.loadText(tenantId, request);
      const raw = await this.extractor.extract({
        schemaVersion: 1,
        modality: 'text',
        content,
        occurredAt: new Date(request.occurredAt).toISOString(),
        locale: request.locale ?? null,
        context: {
          domain: request.context?.domain ?? null,
          taskType: request.context?.taskType ?? null,
        },
      });
      const output = normalizeEvidenceExtractionOutput(raw);
      const event = await this.repository.appendCompleted(
        tenantId,
        request,
        this.extractor,
        output,
      );
      return { status: 'completed', eventId: event.eventId, output };
    } catch (error) {
      const errorCode = this.toErrorCode(error);
      // Log only the bounded code + source pointer. Provider messages/raw text may contain PHI.
      this.logger.warn(
        `evidence extraction failed (${errorCode}) for ${request.evidenceRef?.sourceTable ?? 'unknown'}:${request.evidenceRef?.sourceId ?? 'unknown'}`,
      );
      // A malformed request may lack a safe event shape. Valid requests fail closed with a durable
      // audit event; malformed internal calls are rejected without attempting an invalid DB insert.
      try {
        validateEvidenceExtractionRequest(request);
      } catch {
        throw error instanceof EvidenceExtractionError
          ? error
          : new EvidenceExtractionError(errorCode);
      }
      const event = await this.repository.appendFailed(
        tenantId,
        request,
        this.extractor,
        errorCode,
      );
      return { status: 'failed', eventId: event.eventId, errorCode };
    }
  }

  private toErrorCode(error: unknown): EvidenceExtractionErrorCode {
    return error instanceof EvidenceExtractionError ? error.code : 'provider_error';
  }
}
