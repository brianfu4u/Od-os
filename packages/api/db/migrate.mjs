/**
 * Plain-Node migration runner (no tsx) for the DEPLOYED container / Render pre-deploy command:
 *   node db/migrate.mjs
 * Same idempotent logic as db/migrate.ts, but runnable with only prod deps (`pg`). Runs as the
 * OWNER role via DATABASE_URL (it CREATEs the clearview_app / clearview_login roles + tables); the
 * app itself runs as the non-superuser clearview_login via APP_DATABASE_URL. Resolves the migrations
 * dir relative to this file, so cwd doesn't matter.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

function sslFromUrl(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  try {
    const host = new URL(url).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
    return local ? undefined : { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL (the owner role) is required to run migrations.');
  }
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ssl = sslFromUrl(connectionString);
  const client = new pg.Client(ssl ? { connectionString, ssl } : { connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set((await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
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
