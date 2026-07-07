import type { EvidenceKind, EvidenceSubKind } from '@clearview/shared';

const MB = 1024 * 1024;
/** Per-category size caps (spec: image 10MB, audio 20MB, doc 20MB). */
export const SIZE_LIMITS: Record<'image' | 'audio' | 'doc', number> = {
  image: 10 * MB,
  audio: 20 * MB,
  doc: 20 * MB,
};

// Content-type allowlist → category. Audio set covers WeChat voice formats (amr/m4a/aac).
const MIME_CATEGORY: Record<string, 'image' | 'audio' | 'doc'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/amr': 'audio',
  'audio/x-m4a': 'audio',
  'audio/wav': 'audio',
  'audio/webm': 'audio',
  'application/pdf': 'doc',
  'text/plain': 'doc',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
};

export function classifyMime(mime: string | undefined): 'image' | 'audio' | 'doc' | null {
  if (!mime) return null;
  return MIME_CATEGORY[mime] ?? null;
}

/** Returns an error message, or null when the upload is acceptable. */
export function validateUpload(mime: string | undefined, size: number | undefined): string | null {
  const category = classifyMime(mime);
  if (!category) return `unsupported content type: ${mime ?? '(none)'}`;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'empty or invalid file';
  if (size > SIZE_LIMITS[category]) return `file exceeds the ${SIZE_LIMITS[category]}-byte limit for ${category}`;
  return null;
}

/** Images → Snapshot; audio/pdf/doc → Document. */
export function detectObjectType(mime: string): EvidenceKind {
  return classifyMime(mime) === 'image' ? 'Snapshot' : 'Document';
}

const VALID_SUBKINDS = new Set<string>(['photo', 'screenshot', 'voice', 'pdf', 'checklist', 'document']);

/** Semantic sub-kind stored in properties.kind; a valid client `hint` wins (e.g. screenshot). */
export function detectSubKind(mime: string, hint?: string): EvidenceSubKind | string {
  if (hint && VALID_SUBKINDS.has(hint)) return hint;
  const category = classifyMime(mime);
  if (category === 'image') return 'photo';
  if (category === 'audio') return 'voice';
  if (mime === 'application/pdf') return 'pdf';
  return 'document';
}
