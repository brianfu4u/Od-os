import { Injectable } from '@nestjs/common';

/**
 * In-process domain event seam that closes the agentic loop:
 *   report/scan → verify → alert → agent → orchestrator → cue → SSE.
 * Handlers are awaited sequentially so the chain is deterministic and testable. A later
 * ticket can swap this for Postgres LISTEN/NOTIFY (multi-instance) without changing callers.
 * Producers publish AFTER their tx commits; a failing handler is isolated (never breaks the producer).
 */
export interface DomainEvent {
  type: string;
  tenantId: string;
  objectId: string;
  payload?: Record<string, unknown>;
}

export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;

@Injectable()
export class DomainEventBus {
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  on(type: string, handler: DomainEventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        await handler(event);
      } catch {
        /* isolate subscriber failures from the producer */
      }
    }
  }
}
