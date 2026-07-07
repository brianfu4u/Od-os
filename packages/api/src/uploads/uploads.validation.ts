import type { EvidenceKind } from '@clearview/shared';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_CONTENT_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
]);

/** Images → Snapshot; everything else → Document. */
export function detectKind(contentType: string): EvidenceKind {
  return contentType.startsWith('image/') ? 'Snapshot' : 'Document';
}

/** Returns an error message, or null when the upload is acceptable. */
export function validateUpload(contentType: string | undefined, size: number | undefined): string | null {
  if (!contentType) return 'content type is required';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return `unsupported content type: ${contentType}`;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'empty or invalid file';
  if (size > MAX_UPLOAD_BYTES) return `file exceeds the ${MAX_UPLOAD_BYTES}-byte limit`;
  return null;
}
