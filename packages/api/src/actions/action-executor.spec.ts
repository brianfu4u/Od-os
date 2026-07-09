import { describe, it, expect } from 'vitest';
import type { ProposedAction } from '@clearview/shared';
import { ActionExecutor } from './action-executor';
import { EXECUTABLE_ACTIONS, EXECUTABLE_ACTION_TYPES, getHandler } from './action-registry';

const A = (actionType: string, riskTier: 'low' | 'high' = 'low'): ProposedAction => ({
  label: actionType,
  actionType,
  riskTier,
  needsApproval: true,
});

describe('action gate (decide) — the whitelist + high-risk boundary', () => {
  const exec = new ActionExecutor();

  it('executes a whitelisted low-risk internal write-back', () => {
    expect(exec.decide([A('inventory_reorder')])).toEqual({ kind: 'execute', action: A('inventory_reorder') });
    for (const t of ['reassign_task', 'equipment_offline', 'flag_review_followup']) {
      expect(exec.decide([A(t)]).kind).toBe('execute');
    }
  });

  it('picks the first whitelisted action when several are proposed', () => {
    const d = exec.decide([A('request_info'), A('equipment_offline'), A('reassign_task')]);
    expect(d.kind).toBe('execute');
    expect(d.action?.actionType).toBe('equipment_offline');
  });

  it('NEVER executes a high-risk action — it is blocked and recorded', () => {
    const d = exec.decide([A('request_info'), A('submit_claim', 'high')]);
    expect(d.kind).toBe('blocked_high_risk');
    expect(d.action?.actionType).toBe('submit_claim');
  });

  it('a high-risk action is blocked even if it (wrongly) shares a whitelisted actionType', () => {
    // Defense in depth: the executor refuses to auto-run anything tagged high-risk.
    const d = exec.decide([A('equipment_offline', 'high')]);
    expect(d.kind).toBe('blocked_high_risk');
  });

  it('records intent (no execution) for a non-whitelisted low-risk nudge', () => {
    expect(exec.decide([A('request_evidence')]).kind).toBe('recorded_intent');
    expect(exec.decide([]).kind).toBe('recorded_intent');
  });
});

describe('action registry — the executable whitelist', () => {
  it('contains exactly the four internal write-backs', () => {
    expect([...EXECUTABLE_ACTION_TYPES].sort()).toEqual(
      ['equipment_offline', 'flag_review_followup', 'inventory_reorder', 'reassign_task'].sort(),
    );
  });

  it('every whitelisted handler is undoable', () => {
    for (const t of EXECUTABLE_ACTION_TYPES) expect(getHandler(t)!.undoable).toBe(true);
  });

  it('high-risk / external actions are NOT in the registry (cannot be auto-executed)', () => {
    for (const t of ['submit_claim', 'send_patient_message', 'place_order', 'charge_payment']) {
      expect(getHandler(t)).toBeUndefined();
    }
  });

  it('reassign requires a target; the create-actions do not', () => {
    const base = { client: null as never, tenantId: 't', recommendationId: 'r', actor: 'manager', now: 0 };
    const noTarget = EXECUTABLE_ACTIONS['reassign_task']!.canExecute({ ...base, subject: { id: 'o', type: 'Task', properties: {} }, params: {} });
    expect(noTarget).toBeTruthy();
    const withHint = EXECUTABLE_ACTIONS['reassign_task']!.canExecute({ ...base, subject: { id: 'o', type: 'Task', properties: { reassignTo: 'A · Tech' } }, params: {} });
    expect(withHint).toBeNull();
    expect(EXECUTABLE_ACTIONS['inventory_reorder']!.canExecute({ ...base, subject: { id: 'o', type: 'InventoryItem', properties: {} }, params: {} })).toBeNull();
  });
});
