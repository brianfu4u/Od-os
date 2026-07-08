/** Small display helpers shared by the command-center panels. */

export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return `${Math.round(x * 100)}%`;
}

/** HH:MM from an ISO timestamp (locale-stable, 24h). */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 1-2 char avatar initials from a display name. */
export function initials(name: string): string {
  const cleaned = name.replace(/[·•]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (/[一-鿿぀-ヿ]/.test(parts[parts.length - 1]!)) {
    return parts[parts.length - 1]!.slice(-1);
  }
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
