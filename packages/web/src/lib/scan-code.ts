/**
 * T2 · scan payload normalization (pure, side-effect-free — unit-testable in node).
 *
 * A scanned QR/barcode payload can be a raw object UUID, a `clearview:<type>:<id>` scheme, a URL that
 * embeds the id/code, or a bare business code printed on a room/asset label. This normalizes any of
 * those to the single token we hand to GET /objects/resolve. The BACKEND is the authority on what
 * actually resolves (tenant-scoped, RLS) — this only extracts a clean token and rejects junk.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/**
 * Normalize a scanned payload to a resolvable token, or null when there's nothing usable
 * (empty, or absurdly long — a guard against pathological/binary payloads).
 */
export function parseScanCode(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > 512) return null;

  // clearview:<id>  or  clearview:<type>:<id>
  const scheme = /^clearview:(?:[a-z_]+:)?([^:\s]+)$/i.exec(s);
  if (scheme) return scheme[1]!.trim() || null;

  // URL forms: ?code= / ?object= / ?id=, or a path segment after /objects/
  try {
    const u = new URL(s);
    const q = u.searchParams.get('code') || u.searchParams.get('object') || u.searchParams.get('id');
    if (q && q.trim()) return q.trim();
    const parts = u.pathname.split('/').filter(Boolean);
    const oi = parts.lastIndexOf('objects');
    if (oi >= 0 && parts[oi + 1]) return decodeURIComponent(parts[oi + 1]!);
    // A URL with nothing useful → fall through and treat the whole string as a code.
  } catch {
    /* not a URL — treat as a bare code below */
  }

  return s;
}
