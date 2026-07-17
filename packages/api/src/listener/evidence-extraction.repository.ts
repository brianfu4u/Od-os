import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { withTenant } from '../database/tenant-context';
import { SensitivePayloadsRepository } from '../retention/sensitive-payloads.repository';
import {
  EVIDENCE_EXTRACTION_PROMPT_VERSION,
  EvidenceExtractionError,
  type EvidenceExtractionErrorCode,
  type EvidenceExtractionOutputV1,
  type EvidenceExtractionRequestV1,
  type EvidenceExtractorPort,
} from './evidence-extraction.types';

const ALLOWED_TEXT_SOURCES = new Set([
  // T-13A has no public entry point and no automatic subscription. These are the only currently
  // retained text fields an authorized future caller may explicitly select.
  'patient_scans.optional_note',
  'llm_analysis_log.input',
]);

export interface PersistedExtractionEvent {
  eventId: string;
}

@Injectable()
export class EvidenceExtractionRepository {
  constructor(private readonly sensitive: SensitivePayloadsRepository) {}

  async loadText(tenantId: string, request: EvidenceExtractionRequestV1): Promise<string> {
    const ref = request.evidenceRef;
    if (!ALLOWED_TEXT_SOURCES.has(`${ref.sourceTable}.${ref.field}`)) {
      throw new EvidenceExtractionError('source_not_allowed');
    }
    return withTenant(tenantId, async (client) => {
      const payload = await this.sensitive.readLivePayloadState(
        client,
        tenantId,
        ref.sourceTable,
        ref.sourceId,
        ref.field,
      );
      if (payload.state === 'redacted') throw new EvidenceExtractionError('redacted_input');
      if (payload.state === 'missing') throw new EvidenceExtractionError('source_not_found');
      return payload.content;
    });
  }

  appendCompleted(
    tenantId: string,
    request: EvidenceExtractionRequestV1,
    extractor: EvidenceExtractorPort,
    output: EvidenceExtractionOutputV1,
  ): Promise<PersistedExtractionEvent> {
    return withTenant(tenantId, async (client) => {
      const eventId = await this.insertEvent(client, tenantId, request, {
        status: 'completed',
        adapter: extractor.name,
        model: extractor.model,
        promptVersion: EVIDENCE_EXTRACTION_PROMPT_VERSION,
        outputSchemaVersion: output.schemaVersion,
        llmConfidence: output.llmConfidence,
        extractionCount: output.extractions.length,
        evidenceRef: request.evidenceRef,
      });
      // Full translated content may still be sensitive. It lives only in the redactable side-store,
      // atomically with the immutable event skeleton.
      await this.sensitive.mirrorJson(
        client,
        tenantId,
        'event_log',
        eventId,
        'extraction_output',
        output,
      );
      return { eventId };
    });
  }

  appendFailed(
    tenantId: string,
    request: EvidenceExtractionRequestV1,
    extractor: EvidenceExtractorPort,
    errorCode: EvidenceExtractionErrorCode,
  ): Promise<PersistedExtractionEvent> {
    return withTenant(tenantId, async (client) => ({
      eventId: await this.insertEvent(client, tenantId, request, {
        status: 'failed',
        adapter: extractor.name,
        model: extractor.model,
        promptVersion: EVIDENCE_EXTRACTION_PROMPT_VERSION,
        outputSchemaVersion: 1,
        errorCode,
        evidenceRef: request.evidenceRef,
      }),
    }));
  }

  private async insertEvent(
    client: PoolClient,
    tenantId: string,
    request: EvidenceExtractionRequestV1,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const eventType =
      payload.status === 'completed'
        ? 'evidence.extraction.completed'
        : 'evidence.extraction.failed';
    const inserted = await client.query<{ event_id: string }>(
      `INSERT INTO event_log (
         tenant_id, store_id, terminal_id, source_type, event_type, seq,
         occurred_at, subject_hints, payload, input_modality, schema_version
       ) VALUES ($1, $1, $2, 'system.llm', $3, 0, $4, '{}'::jsonb, $5::jsonb, 'text', 1)
       RETURNING event_id`,
      [
        tenantId,
        request.terminalId ?? null,
        eventType,
        new Date(request.occurredAt).toISOString(),
        JSON.stringify(payload),
      ],
    );
    return inserted.rows[0]!.event_id;
  }
}
