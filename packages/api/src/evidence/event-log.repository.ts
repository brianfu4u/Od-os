import { Injectable } from '@nestjs/common';
import { withTenant } from '../database/tenant-context';

export interface AppendPhotoEventInput {
  terminalId: string | null;
  sourceType: 'staff.terminal' | 'manager.terminal';
  seq: number;
  occurredAt: string;
  subjectHints: Record<string, string>;
  payload: {
    storageKey: string;
    sha256: string;
    mime: 'image/jpeg';
    size: number;
  };
}

export interface EventLogRow {
  eventId: string;
  terminalId: string | null;
  eventType: 'evidence.photo.received';
  seq: number;
  occurredAt: string;
  receivedAt: string;
}

interface EventLogDbRow {
  event_id: string;
  terminal_id: string | null;
  event_type: 'evidence.photo.received';
  seq: string;
  occurred_at: string;
  received_at: string;
}

@Injectable()
export class EventLogRepository {
  appendPhoto(tenantId: string, input: AppendPhotoEventInput): Promise<EventLogRow> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<EventLogDbRow>(
        `INSERT INTO event_log (
           tenant_id, store_id, terminal_id, source_type, event_type, seq,
           occurred_at, subject_hints, payload, input_modality, schema_version
         ) VALUES ($1, $1, $2, $3, 'evidence.photo.received', $4, $5, $6::jsonb, $7::jsonb, 'photo', 1)
         RETURNING event_id, terminal_id, event_type, seq, occurred_at, received_at`,
        [
          tenantId,
          input.terminalId,
          input.sourceType,
          input.seq,
          input.occurredAt,
          JSON.stringify(input.subjectHints),
          JSON.stringify(input.payload),
        ],
      );
      return mapRow(result.rows[0]!);
    });
  }
}

function mapRow(row: EventLogDbRow): EventLogRow {
  return {
    eventId: row.event_id,
    terminalId: row.terminal_id,
    eventType: row.event_type,
    seq: Number(row.seq),
    occurredAt: new Date(row.occurred_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(),
  };
}
