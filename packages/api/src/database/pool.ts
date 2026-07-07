import { Pool } from 'pg';

let pool: Pool | undefined;

/** Lazily-created shared connection pool. pg connects on first query, not here. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
