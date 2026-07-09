/**
 * DEV ONLY. Drops and recreates the `public` schema (wiping all data + the
 * _migrations record) and the app role, so `pnpm db:migrate` rebuilds from zero.
 * Never run this against a database that holds anything you want to keep.
 */
import { Client } from 'pg';
import { clientConfig } from './env';

async function main(): Promise<void> {
  const client = new Client(clientConfig());
  await client.connect();
  try {
    console.log('⚠ dropping and recreating schema public …');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearview_app') THEN
          DROP OWNED BY clearview_app;
          DROP ROLE clearview_app;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'could not drop clearview_app (%). Migration 0004 is idempotent.', SQLERRM;
      END
      $$;
    `);
    console.log('✔ schema reset. Run `pnpm db:migrate` next.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
