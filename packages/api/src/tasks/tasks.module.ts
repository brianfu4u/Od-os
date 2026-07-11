import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';

/**
 * T5 · "My tasks". Read-only projection over the existing objects/links (assignedTo). Follows the
 * same wiring as ObjectsModule/ReportsModule — the controller uses TenantGuard (SessionService is
 * resolved globally / optionally), so no auth import is needed here.
 */
@Module({
  controllers: [TasksController],
  providers: [TasksService, TasksRepository],
})
export class TasksModule {}
