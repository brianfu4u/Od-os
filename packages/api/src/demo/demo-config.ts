/**
 * Demo-seed gating (pure, unit-testable). The synthetic-clinic seed is a deliberate, explicit
 * operation, so it refuses to run unless BOTH switches are set — this is the "double confirm" that
 * makes it safe even where NODE_ENV=production (staging): nothing defaults, so a real tenant can
 * never be seeded by accident.
 *
 *   DEMO_SEED=true                          — explicit opt-in switch
 *   DEMO_SEED_TENANT_ID=<synthetic uuid>    — the tenant to seed (NO default — name it explicitly)
 *   DEMO_SEED_RESET=true                    — (optional) archive this tenant's demo data first
 *   MANAGER_SEED_LOGIN / MANAGER_SEED_PASSWORD — (optional) reuse #26 creds to seed a login-able manager
 */
type Env = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoManagerCreds {
  login: string;
  password: string;
}
export interface DemoRunConfig {
  tenantId: string;
  reset: boolean;
  manager: DemoManagerCreds | null;
}
export type DemoResolve = { ok: true; config: DemoRunConfig } | { ok: false; error: string };

/**
 * Resolve the demo-seed config from the environment, or return a refusal reason. Pure + deterministic.
 * Requires the explicit DEMO_SEED switch AND a valid synthetic tenant uuid (no default) — so the seed
 * can never silently target a real/unnamed tenant, in any environment.
 */
export function resolveDemoConfig(env: Env = process.env): DemoResolve {
  if (env.DEMO_SEED !== 'true') {
    return { ok: false, error: 'refusing to seed: set DEMO_SEED=true to opt in (explicit switch required).' };
  }
  const tenantId = env.DEMO_SEED_TENANT_ID?.trim() ?? '';
  if (!UUID_RE.test(tenantId)) {
    return {
      ok: false,
      error: 'refusing to seed: DEMO_SEED_TENANT_ID must be a synthetic tenant uuid (no default — name the tenant explicitly).',
    };
  }
  const login = env.MANAGER_SEED_LOGIN?.trim();
  const password = env.MANAGER_SEED_PASSWORD ?? '';
  const manager: DemoManagerCreds | null = login && password.length > 0 ? { login, password } : null;
  const reset = env.DEMO_SEED_RESET === 'true';
  return { ok: true, config: { tenantId, reset, manager } };
}
