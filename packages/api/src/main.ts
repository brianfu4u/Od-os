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

  // credentials:true so the httpOnly cv_session cookie flows on cross-origin web ⇄ api calls.
  app.enableCors({ origin: true, credentials: true });
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[clearview-od] API listening on http://localhost:${port}`);
}

void bootstrap();
