import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { closePool, getPool } from './pool';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => getPool(),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await closePool();
  }
}
