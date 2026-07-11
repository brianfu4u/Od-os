/**
 * P5.1 · Production security hardening — pure, side-effect-free resolvers + a fail-closed boot guard.
 *
 * Two gates that MUST close before any real (PHI) data is connected, enforced STRUCTURALLY
 * ("fail-closed"), not by "remembering to set an env var":
 *   1. DB TLS: production connects to Postgres with verification (rejectUnauthorized=true ⇒ chain +
 *      hostname checked). DATABASE_CA_CERT is an OPTIONAL override — when absent, the connection
 *      verifies against the system/public CA store (Render/Neon/Supabase work out of the box); set
 *      it only for a self-hosted/private CA to pin the trust chain. Production NEVER falls back to
 *      rejectUnauthorized=false.
 *   2. CORS: production uses an explicit allow-list from the environment. No "*" wildcard, no
 *      reflecting arbitrary Origins.
 * `assertProductionSecurity()` refuses to boot when production is misconfigured (TLS explicitly
 * disabled, or an empty/invalid CORS allow-list) so a misconfig is a hard failure, not a silent
 * downgrade. A missing CA is NOT a misconfig — public-CA verification is the safe default.
 *
 * These functions take `env` explicitly (default `process.env`) so they are deterministically
 * unit-testable in node without mutating global state — and they touch ONLY the DB connection layer
 * and CORS bootstrap; the RLS / withTenant / clearview_app model is untouched.
 */

type Env = Record<string, string | undefined>;

/** pg SSL config we emit — either off (dev local) or an object; we NEVER emit a bare `true`/`false`. */
export type DbSslConfig = undefined | { rejectUnauthorized: boolean; ca?: string };

export interface CorsResolved {
  /** An explicit allow-list (prod), `true` to reflect the request origin (dev), or `false` to deny all. */
  origin: boolean | string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
}

const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Tenant-Id'];

function isProd(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return null;
  }
}

function isLocalHost(host: string | null): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || (host?.endsWith('.local') ?? false);
}

/** Parse a comma-separated origin allow-list. Accepts the documented `CORS_ORIGIN` and, as an alias, `CORS_ALLOWED_ORIGINS`. */
export function parseCorsAllowList(env: Env = process.env): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS ?? env.CORS_ORIGIN ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when `o` is a bare origin (scheme://host[:port]) with no path/query — i.e. `o === new URL(o).origin`. */
export function isValidOrigin(o: string): boolean {
  try {
    return new URL(o).origin === o;
  } catch {
    return false;
  }
}

/**
 * Resolve the pg `ssl` config for a connection.
 *  - Production: ALWAYS verifies — `{ rejectUnauthorized: true, ca? }`. With no CA it verifies against
 *    the system/public CA store; a provided `DATABASE_CA_CERT` (PEM) pins a specific CA (self-hosted/
 *    private). There is deliberately no production code path that yields `rejectUnauthorized: false`.
 *  - Dev/test: honor a provided CA (verify), else keep the convenient behavior — off for localhost,
 *    and accept managed-provider certs (`rejectUnauthorized: false`) for a hosted synthetic DB.
 *    `DATABASE_SSL=false` forces off (local only).
 */
export function resolveDbSsl(connectionString: string, env: Env = process.env): DbSslConfig {
  const ca = env.DATABASE_CA_CERT?.trim() || undefined;

  if (isProd(env)) {
    // verify-full: rejectUnauthorized=true makes tls.connect check the chain; pg sets servername
    // from the host, so the hostname is verified too. CA is optional (public-CA store by default).
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }

  if (env.DATABASE_SSL === 'false') return undefined;
  if (ca) return { rejectUnauthorized: true, ca };
  if (env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  const host = hostOf(connectionString);
  return isLocalHost(host) ? undefined : { rejectUnauthorized: false };
}

/**
 * Resolve CORS options.
 *  - Allow-list set → restrict to it (prod and dev alike). Never a wildcard.
 *  - Empty allow-list: dev reflects the request origin (convenience); PRODUCTION denies all
 *    (`origin: false`) as a belt-and-suspenders fallback — though assertProductionSecurity() refuses
 *    to boot in that case, so prod never actually reaches this with an empty list.
 * credentials:true is safe here because origin is a concrete list (or a reflected concrete origin),
 * never "*".
 */
export function resolveCorsOptions(env: Env = process.env): CorsResolved {
  const list = parseCorsAllowList(env);
  const base = { credentials: true, methods: CORS_METHODS, allowedHeaders: CORS_ALLOWED_HEADERS };
  if (list.length > 0) return { origin: list, ...base };
  return { origin: isProd(env) ? false : true, ...base };
}

/**
 * Fail-closed boot guard. In production, throws (aborting startup) when either gate is misconfigured.
 * A no-op outside production so dev/CI are unaffected. Call once at bootstrap before listening.
 *
 * Note: a missing DATABASE_CA_CERT is intentionally NOT a failure — production still verifies TLS
 * against the system/public CA store. The CA is only an optional override to pin a private CA.
 */
export function assertProductionSecurity(env: Env = process.env): void {
  if (!isProd(env)) return;

  const problems: string[] = [];

  // ── Gate 1: DB TLS is verified (never disabled in production) ──
  if (env.DATABASE_SSL === 'false') {
    problems.push('DATABASE_SSL=false disables TLS — not allowed in production (TLS verification is required).');
  }

  // ── Gate 2: CORS explicit allow-list ──
  const list = parseCorsAllowList(env);
  if (list.length === 0) {
    problems.push(
      'CORS allow-list is empty — set CORS_ORIGIN (or CORS_ALLOWED_ORIGINS), comma-separated. ' +
        'Production never reflects arbitrary origins.',
    );
  }
  if (list.includes('*')) {
    problems.push('CORS allow-list must not contain "*" in production (wildcard + credentials is forbidden).');
  }
  for (const o of list) {
    if (o !== '*' && !isValidOrigin(o)) {
      problems.push(`CORS allow-list entry "${o}" is not a valid origin (expected scheme://host[:port], no path).`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'Refusing to start — P5.1 production security gates failed:\n' +
        problems.map((p) => `  • ${p}`).join('\n'),
    );
  }
}
