import { describe, it, expect } from 'vitest';
import { resolveDemoConfig } from './demo-config';
import { buildDemoPlan, checkPlan, requiredSatisfied, SOP_EXPECTED, type VerdictColor } from './demo-plan';

const A = '11111111-1111-1111-1111-111111111111';

describe('resolveDemoConfig — explicit double-confirm gate', () => {
  it('refuses without the DEMO_SEED switch', () => {
    expect(resolveDemoConfig({}).ok).toBe(false);
    expect(resolveDemoConfig({ DEMO_SEED: 'false', DEMO_SEED_TENANT_ID: A }).ok).toBe(false);
  });
  it('refuses without a valid synthetic tenant uuid (no default)', () => {
    expect(resolveDemoConfig({ DEMO_SEED: 'true' }).ok).toBe(false);
    expect(resolveDemoConfig({ DEMO_SEED: 'true', DEMO_SEED_TENANT_ID: 'nope' }).ok).toBe(false);
  });
  it('resolves with both switches; parses reset + manager creds', () => {
    const r = resolveDemoConfig({ DEMO_SEED: 'true', DEMO_SEED_TENANT_ID: A });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({ tenantId: A, reset: false, manager: null });
    }
    const r2 = resolveDemoConfig({
      DEMO_SEED: 'true',
      DEMO_SEED_TENANT_ID: A,
      DEMO_SEED_RESET: 'true',
      MANAGER_SEED_LOGIN: 'dana',
      MANAGER_SEED_PASSWORD: 'a-long-password',
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.config.reset).toBe(true);
      expect(r2.config.manager).toEqual({ login: 'dana', password: 'a-long-password' });
    }
  });
});

describe('buildDemoPlan / checkPlan', () => {
  const plan = buildDemoPlan();

  it('is self-consistent (unique keys, valid refs, recipe↔verdict)', () => {
    expect(checkPlan(plan)).toEqual([]);
  });

  it('covers all four verdict colors for demo color', () => {
    const colors = new Set<VerdictColor>(plan.tasks.map((t) => t.targetVerdict));
    for (const c of ['verified', 'conflict', 'pending', 'unverified'] as VerdictColor[]) expect(colors.has(c)).toBe(true);
  });

  it('claims match the SOP expected state (so S2 sees claimMatchesExpected), or null for unverified', () => {
    for (const t of plan.tasks) {
      if (t.targetVerdict === 'unverified') expect(t.claim).toBeNull();
      else expect(t.claim).toBe(SOP_EXPECTED[t.taskType]);
    }
  });

  it('verified attaches required evidence + no timing; conflict/pending leave required missing', () => {
    const v = plan.tasks.find((t) => t.targetVerdict === 'verified')!;
    expect(requiredSatisfied(v)).toBe(true);
    expect(v.timing).toBeUndefined();
    const c = plan.tasks.find((t) => t.targetVerdict === 'conflict')!;
    expect(requiredSatisfied(c)).toBe(false);
    expect(c.timing).toBeTruthy();
    const p = plan.tasks.find((t) => t.targetVerdict === 'pending')!;
    expect(requiredSatisfied(p)).toBe(false);
    expect(p.timing).toBeUndefined();
  });

  it('assigns tasks to staff so /tasks/mine has content', () => {
    expect(plan.tasks.some((t) => !!t.assignToStaffKey)).toBe(true);
  });

  it('catches a broken recipe (guard against drift)', () => {
    const broken = buildDemoPlan();
    broken.tasks[0]!.claim = null; // a verified recipe with no claim is invalid
    expect(checkPlan(broken).length).toBeGreaterThan(0);
  });
});
