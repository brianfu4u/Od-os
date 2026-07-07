/**
 * S1-3 upload contract. Files/photos/voice/screenshots uploaded by the WeChat Mini
 * Program become Snapshot (images) or Document (audio/pdf/doc) objects, linkable to the
 * Communication/Task they prove. Downloads are via short-lived signed URLs only.
 */

/** Ontology object TYPE for an upload. */
export type EvidenceKind = 'Snapshot' | 'Document';

/** Semantic sub-kind, stored in properties.kind (open for forward-compat, e.g. voice→text). */
export type EvidenceSubKind = 'photo' | 'screenshot' | 'voice' | 'pdf' | 'checklist' | 'document';

export interface UploadResult {
  objectId: string;
  objectType: EvidenceKind;
  /** Semantic kind in properties.kind (photo/screenshot/voice/pdf/…). */
  kind: EvidenceSubKind | string;
  mime: string;
  size: number;
  /** Tenant-prefixed object-storage key (never a public URL). */
  storageKey: string;
  originalName: string;
  sha256: string;
  /** True when identical bytes already existed for this tenant (dedup returned the existing object). */
  deduped: boolean;
}

export interface SignedUrlResult {
  /** Short-lived signed URL to download the bytes. */
  url: string;
  expiresAt: string;
}

/** Optional link target when linking evidence at upload time. */
export interface UploadLinkTarget {
  objectType?: string;
  id: string;
}
