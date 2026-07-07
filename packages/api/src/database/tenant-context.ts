import type { PoolClient } from 'pg';
import { getPool } from './pool';

/**
 * Runs `fn` inside a transaction bound to a single tenant, under the RLS-restricted
 * `clearview_app` role. This is the pattern EVERY tenant-scoped query must use:
 *
 *   BEGIN;
 *   SET LOCAL ROLE clearview_app;              -- non-owner, non-superuser → RLS applies
 *   SELECT set_config('app.tenant_id', $1, true);  -- transaction-local tenant
 *   ... queries ...
 *   COMMIT;
 *
 * `SET LOCAL` / is_local=true reset automatically at transaction end, so pooled
 * connections never leak tenant context between requests.
 *
 * (Wired for S1-1 object CRUD; the S0-2 isolation test exercises the same path.)
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE clearview_app');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
