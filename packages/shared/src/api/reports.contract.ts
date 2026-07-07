/**
 * S1-2 staff-report ingest contract. The WeChat Mini Program is the universal staff
 * terminal (clock-in, event reports, task completion, evidence, QR scans); it POSTs
 * these structured reports to POST /reports. Client-agnostic: a dev harness posts them
 * now; the Mini Program posts later over a wx.login-derived session (S0-3).
 *
 * Forward-compatible with the follow-on tickets: voice→text (audio attachments) and the
 * QR system (scan resolution). Do not narrow these shapes without checking those.
 */

export type StaffReportType =
  | 'clock_in'
  | 'clock_out'
  | 'task_update'
  | 'event'
  | 'evidence'
  | 'scan';

export interface ReportAttachment {
  /** image | audio | screenshot | … (open string for forward-compat). */
  kind: string;
  /** Storage reference/URI. Actual upload handling is S1-3; here it is just a ref. */
  ref: string;
  mimeType?: string;
  caption?: string;
}

/** A QR/tag scan — first-class evidence for cross-verification (S2). */
export interface ScanEvent {
  /** e.g. 'Visit' (patient visit code), 'Equipment', 'InventoryItem', 'Room'. */
  scannedObjectType: string;
  /** Resolved ontology object id, when known (a references link is created to it). */
  scannedObjectId?: string;
  /** Raw scanned code/tag when the id isn't resolved yet (QR resolution is a follow-on ticket). */
  code?: string;
  /** ISO timestamp of the scan. */
  at: string;
}

export interface StaffReportInput {
  /** Idempotency key from the client, unique per tenant. Retries reuse it. */
  clientMessageId: string;
  reportType: StaffReportType | string;
  text?: string;
  /** Structured, report-type-specific fields. */
  fields?: Record<string, unknown>;
  attachments?: ReportAttachment[];
  scans?: ScanEvent[];
  /** Client-reported time (ISO). The server also records receivedAt. */
  at?: string;
  /**
   * DEV-ONLY staff identity. In production this is derived from the wx.login/openid
   * session (S0-3) and MUST NOT be trusted from the client.
   */
  staffHandle?: string;
  staffDisplayName?: string;
}

export interface StaffReportResult {
  communicationId: string;
  staffId: string;
  /** True when this clientMessageId was already ingested (idempotent replay). */
  deduped: boolean;
}
