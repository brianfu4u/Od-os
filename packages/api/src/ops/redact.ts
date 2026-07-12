/**
 * Redaction for the observability layer — the single most likely place to leak a secret or PHI, so
 * it is closed off STRUCTURALLY here rather than by remembering to be careful at each log site.
 *
 * Rules:
 *  - Values under a sensitive-looking key (password / token / authorization / cookie / api key /
 *    secret / pepper / credential / session) are replaced with `[REDACTED]`.
 *  - Free-text strings are scrubbed of `Bearer <t>`, `cv_session=<t>`, and long opaque hex/base64
 *    blobs (a stray token in an error message never survives).
 *  - Recursion is depth- and size-bounded; strings are truncated. This runs on log/metric paths, so
 *    it must be cheap and never throw.
 *
 * The observability layer additionally NEVER logs request/response BODIES or query params, so PHI in
 * a payload cannot reach a log line regardless of this scrub — this is defence in depth.
 */

const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|pwd|token|authorization|auth|cookie|secret|api[-_]?key|apikey|pepper|credential|session|bearer)/i;

const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 512;

export const REDACTED = '[REDACTED]';

/** Scrub obvious credential patterns out of a free-text string. */
export function scrubString(input: string): string {
  let s = input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…` : input;
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/(cv_session|session|token|api[-_]?key|secret)=([^&\s;]+)/gi, '$1=[REDACTED]');
  // Long opaque blobs (>=24 chars of hex/base64url) — likely a token/hash/key.
  s = s.replace(/\b[A-Za-z0-9+/_-]{24,}\b/g, (m) => (/^[A-Za-z0-9+/_-]+$/.test(m) ? '[REDACTED]' : m));
  return s;
}

/** True when a key name looks like it holds a secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** Deep-redact an arbitrary value for safe structured logging. Never throws. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return undefined; // functions/symbols/bigint dropped
}

/** Extract a safe, redacted error descriptor (name + scrubbed message + optional status). */
export function safeError(err: unknown): { name: string; message: string; status?: number } {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return {
      name: err.name || 'Error',
      message: scrubString(err.message || ''),
      ...(typeof status === 'number' ? { status } : {}),
    };
  }
  return { name: 'NonError', message: scrubString(typeof err === 'string' ? err : JSON.stringify(err ?? null)) };
}
