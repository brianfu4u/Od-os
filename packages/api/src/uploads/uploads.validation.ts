import type { EvidenceKind, EvidenceSubKind } from '@clearview/shared';

const MB = 1024 * 1024;
/** Per-category size caps (spec: image 10MB, audio 20MB, doc 20MB). */
export const SIZE_LIMITS: Record<'image' | 'audio' | 'doc', number> = {
  image: 10 * MB,
  audio: 20 * MB,
  doc: 20 * MB,
};

// Content-type allowlist → category. Audio set covers WeChat voice formats (amr/m4a/aac) AND the
// browser MediaRecorder outputs used by T3 terminal recording (webm/opus on Chrome/Android, mp4 on
// Safari).
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
  'audio/ogg': 'audio',
  'application/pdf': 'doc',
  'text/plain': 'doc',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
};

// Per-category filename-extension allowlist. A file whose extension is not listed for its declared
// category is rejected — a defense-in-depth check alongside the Content-Type allowlist so a caller
// can't smuggle an executable named `.png` past the MIME gate (or vice-versa).
const EXTENSIONS: Record<'image' | 'audio' | 'doc', ReadonlySet<string>> = {
  image: new Set(['jpg', 'jpeg', 'png', 'webp']),
  audio: new Set(['mp3', 'm4a', 'aac', 'amr', 'wav', 'webm', 'ogg', 'opus', 'mp4']),
  doc: new Set(['pdf', 'txt', 'doc', 'docx']),
};

/**
 * Categorize a Content-Type. Strips any parameters (e.g. `audio/webm;codecs=opus`, which is exactly
 * what MediaRecorder emits) and lower-cases before the allowlist lookup — a format兜底 so a valid
 * recording is never rejected over a codec suffix.
 */
export function classifyMime(mime: string | undefined): 'image' | 'audio' | 'doc' | null {
  if (!mime) return null;
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return MIME_CATEGORY[base] ?? null;
}

/** Lower-cased extension without the dot, or '' when the name has none. */
export function fileExtension(name: string | undefined): string {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Magic-byte sniff for content that must NEVER be stored regardless of a spoofed Content-Type:
 * native executables (Windows PE `MZ`, ELF, Mach-O) and shell scripts (`#!`). Returns true when the
 * leading bytes match one of these dangerous signatures. Deliberately conservative — it flags only
 * unambiguously-executable content, so it can never reject a legitimate (but hard-to-sniff) audio
 * clip like AMR/opus.
 */
export function looksExecutable(buffer: Buffer | undefined): boolean {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  if (b[0] === 0x4d && b[1] === 0x5a) return true; // 'MZ' — Windows PE / DOS
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // 0x7F 'ELF'
  if (b[0] === 0x23 && b[1] === 0x21) return true; // '#!' — script shebang
  const machO = b.readUInt32BE(0);
  if (machO === 0xfeedface || machO === 0xfeedfacf || machO === 0xcafebabe || machO === 0xcffaedfe) return true; // Mach-O
  return false;
}

/**
 * Returns an error message, or null when the upload is acceptable. Enforcement order (each BEFORE any
 * storage write): (1) Content-Type allowlist → category; (2) size present + within the per-category
 * cap; (3) filename extension allowed for that category; (4) magic-byte sniff rejects executables.
 * `originalName` / `buffer` are optional so existing MIME-only callers keep working.
 */
export function validateUpload(
  mime: string | undefined,
  size: number | undefined,
  originalName?: string,
  buffer?: Buffer,
): string | null {
  const category = classifyMime(mime);
  if (!category) return `unsupported content type: ${mime ?? '(none)'}`;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'empty or invalid file';
  if (size > SIZE_LIMITS[category]) return `file exceeds the ${SIZE_LIMITS[category]}-byte limit for ${category}`;
  if (originalName !== undefined) {
    const ext = fileExtension(originalName);
    if (!ext || !EXTENSIONS[category].has(ext)) {
      return `file extension ".${ext || '(none)'}" is not allowed for ${category}`;
    }
  }
  if (looksExecutable(buffer)) return 'file contents look like an executable and are not allowed';
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
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const category = classifyMime(mime);
  if (category === 'image') return 'photo';
  if (category === 'audio') return 'voice';
  if (base === 'application/pdf') return 'pdf';
  return 'document';
}
