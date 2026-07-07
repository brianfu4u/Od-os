/**
 * Idempotent, repeatable migration runner. Applies every unapplied .sql file in
 * db/migrations (lexicographic order) inside a transaction and records it in
 * `_migrations`. Re-running is a safe no-op.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { requireDatabaseUrl } from './env';

async function main(): Promise<void> {
  const connectionString = requireDatabaseUrl();
  const dir = resolve(process.cwd(), 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedRows = await client.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(appliedRows.rows.map((r) => r.name));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`· skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(resolve(dir, file), 'utf8');
      console.log(`▶ apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✖ failed ${file}`);
        throw err;
      }
    }
    console.log(`\n✔ migrations complete — ${ran} applied, ${files.length - ran} skipped.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
