import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal, dependency-free .env loader so `pnpm db:*` just works locally.
 * Looks in the package dir and the repo root; never overrides an already-set var.
 */
export function loadEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      if (!key || process.env[key] !== undefined) continue;
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

export function requireDatabaseUrl(): string {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
  }
  return url;
}

/** TLS for hosted Postgres — on unless the host is local, or forced via DATABASE_SSL=true|false. */
export function sslFromUrl(url: string): { rejectUnauthorized: boolean } | undefined {
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

/** `pg` Client config (connection string + SSL) for the owner-role scripts (migrate/seed/reset). */
export function clientConfig(): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  const connectionString = requireDatabaseUrl();
  const ssl = sslFromUrl(connectionString);
  return ssl ? { connectionString, ssl } : { connectionString };
}
