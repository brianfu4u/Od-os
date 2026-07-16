/**
 * P5.1 · Production security hardening — pure, side-effect-free resolvers + a fail-closed boot guard.
 *
 * Gates that MUST close before any real (PHI) data is connected, enforced STRUCTURALLY
 * ("fail-closed"), not by "remembering to set an env var":
 *   1. DB TLS: production connects to Postgres with verification (rejectUnauthorized=true ⇒ chain +
 *      hostname checked). DATABASE_CA_CERT is an OPTIONAL override — when absent, the connection
 *      verifies against the system/public CA store (Render/Neon/Supabase work out of the box); set
 *      it only for a self-hosted/private CA to pin the trust chain. Production NEVER falls back to
 *      rejectUnauthorized=false.
 *   2. CORS: production uses an explicit allow-list from the environment. No "*" wildcard, no
 *      reflecting arbitrary Origins.
 *   3. Manager auth (feat/manager-auth): if the synthetic manager seed is enabled in production
 *      (MANAGER_SEED_LOGIN set), it must carry a strong password + valid tenant; and if a password
 *      pepper is set (AUTH_PASSWORD_PEPPER) it must be long enough to be meaningful. A weak/partial
 *      manager-auth config is a hard boot failure, never a silent weak credential.
 * `assertProductionSecurity()` refuses to boot when production is misconfigured so a misconfig is a
 * hard failure, not a silent downgrade. A missing CA / unset seed / unset pepper are NOT misconfigs
 * (they are the safe defaults).
 *
 * These functions take `env` explicitly (default `process.env`) so they are deterministically
 * unit-testable in node without mutating global state — and they touch ONLY the DB connection layer,
 * CORS bootstrap, and auth config validation; the RLS / withTenant / clearview_app model, the moat
 * (applyClaim → claimed_state only), and the verified_state engine are all untouched.
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

/** Minimum lengths for manager-auth secrets in production (Gate 3). */
const MIN_SEED_PASSWORD_LEN = 12;
const MIN_PEPPER_LEN = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export interface ExternalProvidersResolved {
  /** true ⇒ external LLM/STT adapters may be selected as usual; false ⇒ force the local fallbacks. */
  enabled: boolean;
  /** machine-readable reason for the boot log (never contains any key/secret). */
  reason: 'enabled' | 'compliance-off';
}

/**
 * P1-6-c · compliance downgrade switch for EXTERNAL data processors (DeepSeek LLM1, OpenAI Whisper).
 *
 * When `COMPLIANCE_EXTERNAL_PROVIDERS=off`, the boot factories MUST skip the external adapters even
 * if their API keys are present, and fall back to the in-process paths that ship no data off-box:
 * the deterministic HeuristicListener (LLM1) and the NullTranscriber (STT declines rather than
 * fabricating text). This lets an operator disable external processing for compliance WITHOUT having
 * to delete keys. Absent / any other value keeps today's behaviour (external allowed when keyed).
 *
 * Pure + env-injectable (no side effects, no key ever read here) so it is deterministically testable.
 * This is a SELECTION gate only: it never changes data flow, world state, or the claim/verification
 * layering — it only decides which engine runs, and the disabled state is strictly more conservative.
 */
export function resolveExternalProviders(env: Env = process.env): ExternalProvidersResolved {
  const flag = (env.COMPLIANCE_EXTERNAL_PROVIDERS ?? '').trim().toLowerCase();
  if (flag === 'off') return { enabled: false, reason: 'compliance-off' };
  return { enabled: true, reason: 'enabled' };
}

/**
 * Gate 3 (pure): manager-auth config problems in production. Empty array ⇒ OK.
 *  - Manager seed is OPTIONAL. But if it is switched on (MANAGER_SEED_LOGIN present), it must be
 *    complete + strong: a password of at least MIN_SEED_PASSWORD_LEN chars and a valid tenant uuid —
 *    otherwise a fresh prod deploy would seed a manager with a weak/parameter-missing credential.
 *  - AUTH_PASSWORD_PEPPER is OPTIONAL, but if set it must be at least MIN_PEPPER_LEN chars (a short
 *    pepper is security theater).
 * Returns problems only in production; a no-op elsewhere.
 */
export function managerAuthProblems(env: Env = process.env): string[] {
  if (!isProd(env)) return [];
  const problems: string[] = [];

  const seedLogin = env.MANAGER_SEED_LOGIN?.trim();
  if (seedLogin) {
    const pw = env.MANAGER_SEED_PASSWORD ?? '';
    const tenant = env.MANAGER_SEED_TENANT_ID?.trim() ?? '';
    if (pw.length < MIN_SEED_PASSWORD_LEN) {
      problems.push(
        `MANAGER_SEED_LOGIN is set but MANAGER_SEED_PASSWORD is missing or shorter than ${MIN_SEED_PASSWORD_LEN} chars — ` +
          'the seeded manager credential must be strong (or unset all MANAGER_SEED_* to disable seeding).',
      );
    }
    if (!UUID_RE.test(tenant)) {
      problems.push('MANAGER_SEED_LOGIN is set but MANAGER_SEED_TENANT_ID is not a valid uuid.');
    }
  }

  const pepper = env.AUTH_PASSWORD_PEPPER?.trim();
  if (pepper !== undefined && pepper.length > 0 && pepper.length < MIN_PEPPER_LEN) {
    problems.push(`AUTH_PASSWORD_PEPPER is set but shorter than ${MIN_PEPPER_LEN} chars — use a long random value or unset it.`);
  }

  return problems;
}

/**
 * Fail-closed boot guard. In production, throws (aborting startup) when any gate is misconfigured.
 * A no-op outside production so dev/CI are unaffected. Call once at bootstrap before listening.
 *
 * Note: a missing DATABASE_CA_CERT is intentionally NOT a failure (public-CA verification is the safe
 * default), and unset MANAGER_SEED_* / AUTH_PASSWORD_PEPPER are NOT failures (they are optional).
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

  // ── Gate 3: manager-auth secrets (feat/manager-auth) ──
  problems.push(...managerAuthProblems(env));

  if (problems.length > 0) {
    throw new Error(
      'Refusing to start — P5.1 production security gates failed:\n' + problems.map((p) => `  • ${p}`).join('\n'),
    );
  }
}
