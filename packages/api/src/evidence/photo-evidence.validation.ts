import type { SessionIdentity } from '../auth/session.types';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TERMINAL_ID_MAX = 128;

export interface PhotoFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface RawPhotoMetadata {
  terminalId?: unknown;
  seq?: unknown;
  occurredAt?: unknown;
}

export interface ValidPhotoMetadata {
  terminalId: string | null;
  seq: number;
  occurredAt: string;
}

/** T-16 intentionally accepts only metadata-free JPEG output from the embedded camera. */
export function validatePhotoFile(file: PhotoFileInput | undefined): string | null {
  if (!file) return 'multipart field "file" is required';
  const mime = file.mimetype.split(';')[0]!.trim().toLowerCase();
  if (mime !== 'image/jpeg') return 'photo intake accepts JPEG images only';
  const size = file.buffer?.length;
  if (!Number.isFinite(size) || size <= 0) return 'empty or invalid photo';
  if (size > MAX_IMAGE_BYTES) return `photo exceeds the ${MAX_IMAGE_BYTES}-byte limit`;
  const extension = file.originalname.slice(file.originalname.lastIndexOf('.') + 1).toLowerCase();
  if (extension !== 'jpg' && extension !== 'jpeg')
    return 'photo filename must end in .jpg or .jpeg';
  if (
    file.buffer.length < 4 ||
    file.buffer[0] !== 0xff ||
    file.buffer[1] !== 0xd8 ||
    file.buffer[2] !== 0xff
  ) {
    return 'photo bytes do not match JPEG';
  }
  return null;
}

export function parsePhotoMetadata(
  raw: RawPhotoMetadata | undefined,
  now = new Date(),
): {
  value?: ValidPhotoMetadata;
  error?: string;
} {
  const terminalRaw = raw?.terminalId;
  let terminalId: string | null = null;
  if (terminalRaw !== undefined) {
    if (typeof terminalRaw !== 'string') return { error: 'terminalId must be a string' };
    terminalId = terminalRaw.trim();
    if (!terminalId || terminalId.length > TERMINAL_ID_MAX || hasControlCharacters(terminalId)) {
      return { error: `terminalId must be 1-${TERMINAL_ID_MAX} printable characters` };
    }
  }

  const seqRaw = raw?.seq;
  let seq = 0;
  if (seqRaw !== undefined) {
    const text =
      typeof seqRaw === 'number' ? String(seqRaw) : typeof seqRaw === 'string' ? seqRaw.trim() : '';
    if (!/^\d+$/.test(text)) return { error: 'seq must be a non-negative integer' };
    seq = Number(text);
    if (!Number.isSafeInteger(seq)) return { error: 'seq exceeds the safe integer range' };
  }

  let occurredAt = now.toISOString();
  if (raw?.occurredAt !== undefined) {
    if (typeof raw.occurredAt !== 'string') return { error: 'occurredAt must be an ISO timestamp' };
    const parsed = new Date(raw.occurredAt);
    if (!Number.isFinite(parsed.getTime())) return { error: 'occurredAt must be an ISO timestamp' };
    occurredAt = parsed.toISOString();
  }
  return { value: { terminalId, seq, occurredAt } };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function sourceTypeFor(identity: SessionIdentity): 'staff.terminal' | 'manager.terminal' {
  return identity.subject === 'manager' ? 'manager.terminal' : 'staff.terminal';
}

/** Only server-derived stable ids become hints. Never copy handles, names, form fields, or raw text. */
export function subjectHintsFor(identity: SessionIdentity): Record<string, string> {
  if (identity.staffId) return { staffId: identity.staffId };
  if (identity.managerId) return { managerId: identity.managerId };
  return {};
}
