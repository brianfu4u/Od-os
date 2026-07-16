import type { PhotoEvidenceMetadata } from '@clearview/shared';
import { safeStorage } from './safe-storage';

const TERMINAL_KEY = 'clearview.photo-intake.terminal-id';
const SEQ_KEY = 'clearview.photo-intake.seq';
let volatileTerminalId: string | null = null;
let volatileSeq = 0;

function createTerminalId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `terminal-${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through to a non-sensitive random id */
  }
  return `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function parseStoredPhotoSeq(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Creates only structural envelope metadata. localStorage never sees image bytes, a filename, or a
 * preview; if Web Storage is unavailable, a process-local id/counter keeps the camera usable.
 */
export function nextPhotoMetadata(now = new Date()): Required<PhotoEvidenceMetadata> {
  let terminalId = safeStorage.get(TERMINAL_KEY) ?? volatileTerminalId;
  if (!terminalId) {
    terminalId = createTerminalId();
    volatileTerminalId = terminalId;
    safeStorage.set(TERMINAL_KEY, terminalId);
  }

  const stored = parseStoredPhotoSeq(safeStorage.get(SEQ_KEY));
  const seq = Math.max(stored, volatileSeq) + 1;
  volatileSeq = seq;
  safeStorage.set(SEQ_KEY, String(seq));

  return { terminalId, seq, occurredAt: now.toISOString() };
}
