import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertRuntimeRoleSafe } from './database/pool';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // S0-3 ops hardening: refuse to start if the DB role can bypass RLS (superuser / BYPASSRLS /
  // table owner). This makes "app connected as a privileged role" a hard boot failure, not a
  // silent cross-tenant leak. The app must connect as the least-privilege clearview_login role.
  await assertRuntimeRoleSafe();

  // CORS: in staging/prod, restrict to the deployed web origin(s) via CORS_ORIGIN (comma-separated);
  // in dev (unset) reflect any origin. credentials:true lets the httpOnly cv_session cookie flow, but
  // the web authenticates cross-origin with a Bearer token + ?session= (SSE), so a specific origin is
  // required here rather than a wildcard.
  const allow = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({ origin: allow.length > 0 ? allow : true, credentials: true });

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[clearview-od] API listening on :${port} (NODE_ENV=${process.env.NODE_ENV ?? 'development'})`);
}

void bootstrap();
