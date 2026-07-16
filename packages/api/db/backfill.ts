/**
 * P1-6-d · E-1 one-off, IDEMPOTENT data backfill runner (NOT a schema migration).
 *
 * Applies every .sql file in db/backfill (lexicographic order). Unlike db/migrate.ts, backfills are
 * NOT recorded in a ledger and are NOT auto-run on deploy — they are safe to re-run by design (each
 * script guards its own INSERTs with NOT EXISTS), so an operator invokes `pnpm db:backfill` once at
 * launch (and may re-run at will). Each .sql file manages its own transaction (BEGIN/COMMIT).
 *
 * Backfills are kept OUT of db/migrations on purpose: they mutate DATA in existing rows' mirror, not
 * SCHEMA, and must never be conflated with the append-only schema history.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { clientConfig } from './env';

async function main(): Promise<void> {
  const dir = resolve(process.cwd(), 'db', 'backfill');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client(clientConfig());
  await client.connect();
  try {
    let ran = 0;
    for (const file of files) {
      const sql = readFileSync(resolve(dir, file), 'utf8');
      console.log(`▶ run ${file}`);
      try {
        await client.query(sql);
        ran += 1;
      } catch (err) {
        console.error(`✖ failed ${file}`);
        throw err;
      }
    }
    console.log(`\n✔ backfill complete — ${ran} script(s) run (idempotent; safe to re-run).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
