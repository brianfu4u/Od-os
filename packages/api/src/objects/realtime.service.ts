import { Injectable } from '@nestjs/common';
import { Subject, type Observable, filter } from 'rxjs';
import type { ObjectChangeEvent } from '@clearview/shared';

/**
 * In-process publish/subscribe for object changes. The write path publishes after a
 * successful commit; the SSE endpoint subscribes per tenant. (A single-process bus is
 * fine for the MVP; a later ticket can swap in Postgres LISTEN/NOTIFY or a broker for
 * multi-instance fan-out without changing callers.)
 */
@Injectable()
export class RealtimeService {
  private readonly changes$ = new Subject<ObjectChangeEvent>();

  publish(event: ObjectChangeEvent): void {
    this.changes$.next(event);
  }

  /** Stream of changes scoped to a single tenant. */
  forTenant(tenantId: string): Observable<ObjectChangeEvent> {
    return this.changes$.pipe(filter((event) => event.tenantId === tenantId));
  }
}
