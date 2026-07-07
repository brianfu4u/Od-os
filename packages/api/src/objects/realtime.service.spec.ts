import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { RealtimeService } from './realtime.service';
import type { ObjectChangeEvent } from '@clearview/shared';

function evt(tenantId: string): ObjectChangeEvent {
  return { kind: 'created', tenantId, objectId: 'o1', type: 'Task', at: new Date().toISOString() };
}

describe('RealtimeService', () => {
  it('delivers only the subscribing tenant’s events', () => {
    const svc = new RealtimeService();
    const received: ObjectChangeEvent[] = [];
    const sub = svc.forTenant('tenant-A').subscribe((e) => received.push(e));

    svc.publish(evt('tenant-A'));
    svc.publish(evt('tenant-B'));
    svc.publish(evt('tenant-A'));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.tenantId === 'tenant-A')).toBe(true);
    sub.unsubscribe();
  });
});
