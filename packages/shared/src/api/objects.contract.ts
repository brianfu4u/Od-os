/**
 * S1-1 object API contract (the S0-4 read/write shapes the frontend + later
 * tickets build against). Kept in @clearview/shared so api and web share one source.
 */

/** Create a new ontology object. `type` is required; per-type fields go in `properties`. */
export interface CreateObjectInput {
  type: string;
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
  verifiedState?: string | null;
  confidence?: number | null;
}

/** Partial update. Any provided state field is set; `properties` are shallow-merged. */
export interface UpdateObjectInput {
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
  verifiedState?: string | null;
  confidence?: number | null;
}

/** Filter for listing objects. Soft-deleted (archived) objects are excluded by default. */
export interface ObjectQuery {
  type?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface CreateLinkInput {
  fromObject: string;
  toObject: string;
  relation: string;
}

/** Realtime object-change notification streamed over SSE (GET /objects/stream). */
export type ObjectChangeKind = 'created' | 'updated' | 'archived' | 'verified';

export interface ObjectChangeEvent {
  kind: ObjectChangeKind;
  tenantId: string;
  objectId: string;
  type: string;
  /** ISO-8601 timestamp. */
  at: string;
}
