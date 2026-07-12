import { Pool, type PoolConfig } from 'pg';
import { resolveDbSsl } from '../config/security';

let pool: Pool | undefined;

/**
 * TLS for the runtime Postgres connection. Delegates to the hardened P5.1 resolver:
 *  - production → FULL verification (rejectUnauthorized=true + CA from DATABASE_CA_CERT ⇒ verify-full);
 *    the CA's presence is enforced fail-closed at boot by assertProductionSecurity().
 *  - dev/test → off for localhost, or accept managed-provider certs for a hosted synthetic DB
 *    (DATABASE_SSL toggles; a provided DATABASE_CA_CERT switches dev to verification too).
 * There is deliberately no production path that yields rejectUnauthorized=false.
 */
export function sslFor(connectionString: string): PoolConfig['ssl'] {
  return resolveDbSsl(connectionString);
}

/** Dev/CI default password for the derived clearview_login connection (see 0007 migration). */
const DEV_LOGIN_PASSWORD = process.env.APP_DB_PASSWORD ?? 'clearview_login_dev';

/**
 * The connection string the RUNTIME app uses — always the least-privilege `clearview_login`
 * role, never the owner/superuser.
 *
 *  - `APP_DATABASE_URL` (a clearview_login connection) wins, and is REQUIRED in production.
 *  - Otherwise (dev/test only) we derive it from `DATABASE_URL` by swapping the user to
 *    clearview_login + the dev password, so local/CI need no extra config while still
 *    exercising the RLS-bound role. Migrations/seed keep using `DATABASE_URL` (owner).
 */
function runtimeConnectionString(): string {
  const explicit = process.env.APP_DATABASE_URL;
  if (explicit) return explicit;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'APP_DATABASE_URL (a non-superuser clearview_login connection) is required in production.',
    );
  }

  const admin = process.env.DATABASE_URL;
  if (!admin) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
  }
  try {
    const u = new URL(admin);
    u.username = 'clearview_login';
    u.password = DEV_LOGIN_PASSWORD;
    return u.toString();
  } catch {
    // Non-URL connection string — fall back (the self-check below still guards privilege).
    return admin;
  }
}

/** Lazily-created shared connection pool. pg connects on first query, not here. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = runtimeConnectionString();
    pool = new Pool({ connectionString, max: 10, ssl: sslFor(connectionString) });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Read-only DB liveness ping for /health/ready. Runs `SELECT 1` on the runtime (least-privilege)
 * pool and returns { ok, latencyMs }. NEVER throws — a failure is reported as { ok:false, error }
 * so readiness can degrade (503) without taking the process down. No tenant context, no business
 * data — purely a connectivity probe.
 */
export async function pingDatabase(
  p: Pool = getPool(),
): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  const start = Date.now();
  try {
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Startup safety gate: refuse to run if the app's DB role can bypass Row-Level Security.
 * A superuser, a BYPASSRLS role, or the owner of a tenant table would silently see EVERY
 * tenant's rows — the exact cross-tenant leak RLS exists to prevent. Called at boot; throwing
 * aborts startup. Pass a specific pool in tests to assert the check both ways.
 */
export async function assertRuntimeRoleSafe(p: Pool = getPool()): Promise<void> {
  const client = await p.connect();
  try {
    const role = await client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const r = role.rows[0];
    if (!r) throw new Error('DB safety check: cannot determine current role.');
    if (r.rolsuper || r.rolbypassrls) {
      throw new Error(
        `Refusing to start: DB role "${r.current_user}" is privileged (superuser=${r.rolsuper}, bypassrls=${r.rolbypassrls}). ` +
          'Connect as the non-privileged clearview_login role so RLS applies.',
      );
    }
    const owner = await client.query<{ is_owner: boolean }>(
      `SELECT pg_get_userbyid(relowner) = current_user AS is_owner
         FROM pg_class WHERE relname = 'objects' AND relkind = 'r' LIMIT 1`,
    );
    if (owner.rows[0]?.is_owner) {
      throw new Error(
        `Refusing to start: DB role "${r.current_user}" owns tenant table "objects" (owner bypasses RLS). ` +
          'Connect as the non-privileged clearview_login role instead.',
      );
    }
  } finally {
    client.release();
  }
}
