import { Module } from '@nestjs/common';
import { ObjectsController } from './objects.controller';
import { LinksController } from './links.controller';
import { ObjectsService } from './objects.service';
import { ObjectsRepository } from './objects.repository';
import { RealtimeService } from './realtime.service';

@Module({
  controllers: [ObjectsController, LinksController],
  providers: [ObjectsService, ObjectsRepository, RealtimeService],
  exports: [RealtimeService, ObjectsService],
})
export class ObjectsModule {}
