import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SessionService } from './session.service';
import { parseSeedConfig } from './manager-seed.config';

/**
 * Boot-time, idempotent, synthetic manager seed. When MANAGER_SEED_* is configured, ensures a
 * manager credential exists so the command center can be signed into on a fresh deploy. It is
 * BEST-EFFORT: any failure (e.g. the DB is not yet reachable) is logged and swallowed — seeding must
 * never crash the app, and it re-runs (idempotently) on the next boot. The plaintext password is
 * NEVER logged. Production config sanity (password strength / pepper length) is enforced separately
 * by assertProductionSecurity() at bootstrap, before the app listens.
 */
@Injectable()
export class ManagerSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ManagerSeed');
  constructor(private readonly sessions: SessionService) {}

  async onApplicationBootstrap(): Promise<void> {
    const cfg = parseSeedConfig(process.env);
    if (!cfg) return; // not requested → no-op (dev/CI default)
    try {
      const { action, managerId } = await this.sessions.seedManager(cfg);
      this.logger.log(`manager seed ${action}: login=${cfg.login} tenant=${cfg.tenantId} managerId=${managerId}`);
    } catch (err) {
      this.logger.warn(`manager seed skipped (will retry next boot): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
