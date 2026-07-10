import { describe, it, expect } from 'vitest';
import { LlmListenerService } from './listener.service';
import type { LlmListenerRepository } from './listener.repository';
import type { ObjectsService } from '../objects/objects.service';
import type { ListenAnalysis, LlmListenerPort } from './listener.types';

/**
 * ⛔ MOAT unit tests. LLM1 may set claimed_state and annotate properties — and NOTHING else. These
 * tests pin that the service's writes never carry verifiedState/confidence, and that low-confidence
 * claims are left pending (no state write). Uses fakes only — no DB, fully deterministic.
 */
const COMM = { id: 'comm-1', text: '3号房已备好', reportType: null, fields: {}, hasAttachments: false, hasScans: false, locale: 'zh' };

function analysis(over: Partial<ListenAnalysis> = {}): ListenAnalysis {
  return {
    summary: 'claim: Room 3 room_turnover → ready',
    claim: { taskType: 'room_turnover', claimedState: 'ready', locator: { room: '3', label: 'Room 3' } },
    classification: { domain: 'patient_flow', taskType: 'room_turnover', eventType: 'task_update', severity: 'low' },
    candidateCues: [],
    confidence: 0.82,
    locale: 'zh',
    ...over,
  };
}

function makeService(a: ListenAnalysis, resolveTo: { objectId: string; created: boolean } | null = { objectId: 'task-1', created: false }) {
  const updates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const listener: LlmListenerPort = { name: 'stub', analyze: async () => a, summarize: async () => ({ scope: 's', text: '', locale: 'zh', periodHours: 1, count: 0, byEventType: {}, byDomain: {} }) };
  const repo = {
    loadCommunication: async () => ({ ...COMM }),
    resolveTaskForClaim: async () => resolveTo,
    audit: async (_t: string, row: Record<string, unknown>) => { audits.push(row); },
    gatherAnalyses: async () => [],
  } as unknown as LlmListenerRepository;
  const objects = { update: async (_t: string, id: string, input: Record<string, unknown>) => { updates.push({ id, input }); return {} as never; } } as unknown as ObjectsService;
  const svc = new LlmListenerService(listener, repo, objects);
  return { svc, updates, audits };
}

describe('LlmListenerService — moat enforcement', () => {
  it('applies the claim as claimed_state ONLY (never writes verifiedState/confidence)', async () => {
    const { svc, updates, audits } = makeService(analysis());
    await svc.process('tenant-a', 'comm-1');

    // Two writes: annotate the Communication (properties only) + set the Task's claim.
    const commWrite = updates.find((u) => u.id === 'comm-1')!;
    const taskWrite = updates.find((u) => u.id === 'task-1')!;
    expect(commWrite).toBeTruthy();
    expect(Object.keys(commWrite.input)).toEqual(['properties']); // classification annotation only
    expect(taskWrite).toBeTruthy();
    expect(Object.keys(taskWrite.input).sort()).toEqual(['claimedState', 'properties']);
    expect((taskWrite.input as { claimedState: string }).claimedState).toBe('ready');

    // The moat: no LLM write ever carries a verified field or a confidence override.
    for (const u of updates) {
      expect('verifiedState' in u.input).toBe(false);
      expect('confidence' in u.input).toBe(false);
    }
    expect(audits[0]).toMatchObject({ appliedAction: 'claim_applied', objectId: 'task-1', claimedState: 'ready' });
  });

  it('leaves a low-confidence claim PENDING — no state write at all', async () => {
    const { svc, updates, audits } = makeService(analysis({ confidence: 0.4 }));
    await svc.process('tenant-a', 'comm-1');

    // Only the (safe) Communication annotation happens; the Task claim is NOT set.
    expect(updates.some((u) => u.id === 'task-1')).toBe(false);
    expect(updates.every((u) => !('claimedState' in u.input))).toBe(true);
    expect(audits[0]).toMatchObject({ appliedAction: 'pending_low_confidence' });
  });

  it('records claim_unresolved (still no verified write) when no task can be resolved', async () => {
    const { svc, updates, audits } = makeService(analysis(), null);
    await svc.process('tenant-a', 'comm-1');
    expect(updates.some((u) => 'claimedState' in u.input)).toBe(false);
    expect(audits[0]).toMatchObject({ appliedAction: 'claim_unresolved' });
  });

  it('classifies with no claim → classified_only, annotation only', async () => {
    const { svc, updates, audits } = makeService(analysis({ claim: null, confidence: 0.8 }));
    await svc.process('tenant-a', 'comm-1');
    expect(updates.length).toBe(1);
    expect(Object.keys(updates[0]!.input)).toEqual(['properties']);
    expect(audits[0]).toMatchObject({ appliedAction: 'classified_only' });
  });
});
