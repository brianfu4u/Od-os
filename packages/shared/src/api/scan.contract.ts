/**
 * Patient-scan contract (T-02, feat/business-flow-p0) — shapes shared by api + web.
 *
 * A scan is a NEUTRAL, append-only contact event. The collection layer assigns no business
 * semantics. Patient-key discipline (v1.1 必改 4): `patientCode` is the raw scanned input and is
 * always kept; `patientVisitId` is the preferred business key, backfilled when resolvable. A scan
 * is NEVER blocked — see 0015_patient_scan.sql.
 */

/** Whether the raw code was mapped to a business visit id. */
export const VISIT_LINK_STATUSES = ['resolved', 'unresolved'] as const;
export type VisitLinkStatus = (typeof VISIT_LINK_STATUSES)[number];

/**
 * Request body for a scan submission. At least one of `patientCode` / `patientVisitId` is required
 * (the API rejects a scan with neither — that is input validation, not a business rejection).
 * All other fields are optional and NEVER blocking.
 */
export interface SubmitScanInput {
  /** Raw scanned patient code. Kept verbatim. */
  patientCode?: string | null;
  /** Preferred business key, if the client already has it. */
  patientVisitId?: string | null;
  /** Optional client scan timestamp; server defaults to now(). */
  scannedAt?: string | null;
  /** Optional terminal/device identifier. */
  terminalId?: string | null;
  /** Optional voluntary note; never blocking. */
  optionalNote?: string | null;
  /** Optional attachment object ids; never blocking. */
  optionalAttachmentIds?: string[] | null;
}

/**
 * Server acknowledgement of a stored scan. Neutral — carries no business verdict.
 * `visitLinkStatus` reflects whether resolution succeeded, not whether the scan was "valid".
 */
export interface ScanAck {
  scanId: string;
  employeeId: string;
  patientCode: string | null;
  patientVisitId: string | null;
  visitLinkStatus: VisitLinkStatus;
  scannedAt: string;
}
