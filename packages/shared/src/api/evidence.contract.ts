/** Neutral receipt for POST /evidence/photo. It acknowledges intake; it is not a verdict. */
export interface PhotoEvidenceReceipt {
  eventId: string;
  eventType: 'evidence.photo.received';
  terminalId: string | null;
  seq: number;
  occurredAt: string;
  receivedAt: string;
  sha256: string;
  size: number;
}

/** Multipart metadata sent alongside the JPEG captured by the staff terminal. */
export interface PhotoEvidenceMetadata {
  terminalId?: string;
  seq?: number;
  occurredAt?: string;
}
