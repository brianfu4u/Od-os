/**
 * S1-3 upload contract. Files/photos uploaded by the WeChat Mini Program (evidence:
 * photo / screenshot / voice) become Snapshot (images) or Document (everything else)
 * objects, optionally linked to the Communication/Task they support.
 */
export type EvidenceKind = 'Snapshot' | 'Document';

export interface UploadResult {
  objectId: string;
  kind: EvidenceKind;
  /** Backend storage reference (opaque; dev: local:…, prod: object-storage key/URL). */
  storageRef: string;
  /** Tenant-scoped URL to stream the bytes back. */
  url: string;
  mimeType: string;
  size: number;
  filename: string;
}
