/**
 * P0-3 sub-issue 4: file/transcription retention policy. Stored evidence (images, voice audio, docs)
 * accumulates forever otherwise — a privacy and cost liability. After the retention window a file's
 * BYTES are purged from storage; the object row is kept but marked purged (audit stays intact).
 *
 * The window is env-tunable via FILE_RETENTION_DAYS (default 90). For an S3 backend, ops SHOULD ALSO
 * configure native bucket lifecycle rules (the authoritative, provider-side mechanism); this
 * app-level path is the portable fallback that also covers local-disk and any provider without
 * lifecycle support. Kept as pure functions so the age decision is unit-testable without a DB.
 */
export const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window in days from FILE_RETENTION_DAYS (falls back to the default when unset/invalid). */
export function retentionDays(): number {
  const n = Number(process.env.FILE_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

/** ISO timestamp of the retention cutoff: anything created strictly before this is expired. */
export function cutoffIso(now: Date | number, days: number): string {
  const base = now instanceof Date ? now.getTime() : now;
  return new Date(base - days * DAY_MS).toISOString();
}

/** True when `createdAt` is older than `days` before `now`. */
export function isExpired(createdAt: Date | string | number, now: Date | number, days: number): boolean {
  const created = new Date(createdAt).getTime();
  const base = now instanceof Date ? now.getTime() : now;
  return created < base - days * DAY_MS;
}
