import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertRuntimeRoleSafe } from './database/pool';
import { assertProductionSecurity, resolveCorsOptions } from './config/security';

async function bootstrap(): Promise<void> {
  // P5.1 fail-closed gate: in production, refuse to start unless DB TLS is fully verified
  // (rejectUnauthorized=true + DATABASE_CA_CERT) and CORS has an explicit, wildcard-free allow-list.
  // A misconfig is a hard boot failure here, never a silent downgrade. No-op outside production.
  assertProductionSecurity();

  const app = await NestFactory.create(AppModule);

  // S0-3 ops hardening: refuse to start if the DB role can bypass RLS (superuser / BYPASSRLS /
  // table owner). This makes "app connected as a privileged role" a hard boot failure, not a
  // silent cross-tenant leak. The app must connect as the least-privilege clearview_login role.
  await assertRuntimeRoleSafe();

  // CORS: production restricts to the env allow-list (CORS_ORIGIN / CORS_ALLOWED_ORIGINS,
  // comma-separated) — no "*" wildcard and no reflecting arbitrary origins (enforced fail-closed by
  // assertProductionSecurity above). Dev (empty list) reflects the request origin for convenience.
  // credentials:true lets the httpOnly cv_session cookie flow; origin is always a concrete list (or a
  // reflected concrete origin in dev), never "*", so it is credentials-safe.
  app.enableCors(resolveCorsOptions());

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[clearview-od] API listening on :${port} (NODE_ENV=${process.env.NODE_ENV ?? 'development'})`);
}

void bootstrap();
