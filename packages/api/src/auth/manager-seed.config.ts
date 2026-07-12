type Env = Record<string, string | undefined>;

export interface ManagerSeedConfig {
  tenantId: string;
  login: string;
  password: string;
  displayName?: string;
  role: string;
  force: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse MANAGER_SEED_* env into a seed config, or null when seeding is not requested. Returns null
 * (a no-op) unless login + a non-empty password + a valid tenant uuid are ALL present — so dev/CI
 * with none of these set simply never seeds. Pure + deterministic for unit testing. (Production
 * ALSO enforces password strength at boot via assertProductionSecurity → managerAuthProblems; this
 * parser only decides whether a seed was requested + well-formed enough to attempt.)
 */
export function parseSeedConfig(env: Env = process.env): ManagerSeedConfig | null {
  const login = env.MANAGER_SEED_LOGIN?.trim();
  const password = env.MANAGER_SEED_PASSWORD ?? '';
  const tenantId = env.MANAGER_SEED_TENANT_ID?.trim();
  if (!login || password.length === 0 || !tenantId || !UUID_RE.test(tenantId)) return null;
  return {
    tenantId,
    login,
    password,
    displayName: env.MANAGER_SEED_DISPLAY_NAME?.trim() || undefined,
    role: env.MANAGER_SEED_ROLE?.trim() || 'manager',
    force: env.MANAGER_SEED_FORCE === 'true',
  };
}
