import { describe, it, expect } from 'vitest';
import { HeuristicListener } from './heuristic-listener';

const h = new HeuristicListener();

describe('HeuristicListener — deterministic analyze (trilingual)', () => {
  it('extracts a room_turnover "ready" claim from Chinese "3号房已备好"', async () => {
    const a = await h.analyze({ text: '3号房已备好' });
    expect(a.locale).toBe('zh');
    expect(a.claim).toEqual({ taskType: 'room_turnover', claimedState: 'ready', locator: { room: '3', label: 'Room 3' } });
    expect(a.classification).toMatchObject({ domain: 'patient_flow', taskType: 'room_turnover', eventType: 'task_update' });
    expect(a.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('infers room_turnover from English "Room 3 is ready" (no explicit turnover word)', async () => {
    const a = await h.analyze({ text: 'Room 3 is ready' });
    expect(a.locale).toBe('en');
    expect(a.claim?.taskType).toBe('room_turnover');
    expect(a.claim?.claimedState).toBe('ready');
    expect(a.claim?.locator.label).toBe('Room 3');
  });

  it('handles Japanese "3番診察室 準備できました"', async () => {
    const a = await h.analyze({ text: '3番診察室 準備できました' });
    expect(a.locale).toBe('ja');
    expect(a.claim?.taskType).toBe('room_turnover');
    expect(a.claim?.claimedState).toBe('ready');
  });

  it('classifies clock in/out with no claim', async () => {
    const cin = await h.analyze({ text: '', reportType: 'clock_in' });
    expect(cin.classification.eventType).toBe('clock_in');
    expect(cin.claim).toBeNull();
    const cout = await h.analyze({ text: '我下班打卡' });
    expect(cout.classification.eventType).toBe('clock_out');
  });

  it('flags a support request and an anomaly as candidate cues', async () => {
    const sup = await h.analyze({ text: '前台需要支援,人手不够' });
    expect(sup.classification.eventType).toBe('support_request');
    expect(sup.candidateCues.length).toBe(1);
    const anom = await h.analyze({ text: 'OCT 仪器坏了,故障报错' });
    expect(anom.classification.eventType).toBe('anomaly');
    expect(anom.classification.severity).toBe('high');
    expect(anom.candidateCues[0]?.severity).toBe('high');
  });

  it('marks a bare/ambiguous report low-confidence (→ pending, no claim)', async () => {
    const a = await h.analyze({ text: '嗯,收到了' });
    expect(a.claim).toBeNull();
    expect(a.confidence).toBeLessThan(0.6);
  });

  it('summarize counts by event type and domain', async () => {
    const s = await h.summarize({
      scope: 'shift',
      locale: 'en',
      periodHours: 12,
      events: [
        { at: 'x', eventType: 'task_update', domain: 'patient_flow' },
        { at: 'y', eventType: 'task_update', domain: 'patient_flow' },
        { at: 'z', eventType: 'anomaly', domain: 'equipment' },
      ],
    });
    expect(s.count).toBe(3);
    expect(s.byEventType.task_update).toBe(2);
    expect(s.byDomain.equipment).toBe(1);
    expect(s.text).toContain('3 events');
  });
});
