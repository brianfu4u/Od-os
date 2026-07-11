/**
 * T3 · pure helpers for terminal audio recording (side-effect-free, unit-testable in node). The
 * MediaRecorder itself lives in the AudioRecorder component; this module only holds the format /
 * duration logic so it can be tested without a browser.
 */

/** Strip codec parameters + lower-case, e.g. `audio/webm;codecs=opus` → `audio/webm`. */
export function bareMime(mime: string): string {
  return (mime || '').split(';')[0]!.trim().toLowerCase();
}

/** mm:ss from milliseconds (clamped at 0). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** A filename extension for an audio MIME (used when wrapping the blob in a File). */
export function audioExt(mime: string): string {
  const b = bareMime(mime);
  if (b.includes('webm')) return 'webm';
  if (b.includes('mp4') || b.includes('m4a')) return 'm4a';
  if (b.includes('aac')) return 'aac';
  if (b.includes('ogg')) return 'ogg';
  if (b.includes('wav')) return 'wav';
  if (b.includes('mpeg') || b.includes('mp3')) return 'mp3';
  return 'webm';
}

/**
 * Candidate MediaRecorder mime types, most-preferred first. Chrome/Android support webm/opus; Safari
 * supports mp4. All of these are on the backend upload allow-list.
 */
export const PREFERRED_AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg'];

/**
 * Pick the first candidate the platform supports. `isSupported` is injected (MediaRecorder.isTypeSupported
 * in the component) so this stays pure/testable. Returns '' to let the browser choose its default.
 */
export function pickSupportedMime(
  isSupported: (mime: string) => boolean,
  candidates: string[] = PREFERRED_AUDIO_MIMES,
): string {
  for (const m of candidates) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* isTypeSupported can throw on some engines — treat as unsupported */
    }
  }
  return '';
}
