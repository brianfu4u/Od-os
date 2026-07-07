import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './domain-event-bus';

/** Global so any module can publish/subscribe to domain events without import gymnastics. */
@Global()
@Module({
  providers: [DomainEventBus],
  exports: [DomainEventBus],
})
export class EventsModule {}
