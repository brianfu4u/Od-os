import { describe, it, expect } from 'vitest';
import {
  isUuid,
  validateAssignInput,
  validateCreateTaskInput,
  normalizeCreateTaskInput,
  validateDecisionInput,
} from './assignment.validation';

const U = '11111111-1111-1111-1111-111111111111';
const V = '22222222-2222-2222-2222-222222222222';

describe('validateAssignInput', () => {
  it('accepts two uuids', () => {
    expect(validateAssignInput({ taskId: U, staffId: V })).toBeNull();
  });
  it('rejects missing/invalid ids', () => {
    expect(validateAssignInput(undefined)).toMatch(/body/);
    expect(validateAssignInput({ staffId: V })).toMatch(/taskId/);
    expect(validateAssignInput({ taskId: U })).toMatch(/staffId/);
    expect(validateAssignInput({ taskId: 'nope', staffId: V })).toMatch(/taskId/);
  });
});

describe('validateCreateTaskInput', () => {
  it('requires a non-empty label within the length cap', () => {
    expect(validateCreateTaskInput({ label: 'Prep room 3' })).toBeNull();
    expect(validateCreateTaskInput({ label: '   ' })).toMatch(/label/);
    expect(validateCreateTaskInput(undefined)).toMatch(/body/);
    expect(validateCreateTaskInput({ label: 'x'.repeat(201) })).toMatch(/at most/);
  });
  it('validates optional taskType / dueBy / staffId', () => {
    expect(validateCreateTaskInput({ label: 'a', taskType: 42 as unknown as string })).toMatch(/taskType/);
    expect(validateCreateTaskInput({ label: 'a', dueBy: 'not-a-date' })).toMatch(/dueBy/);
    expect(validateCreateTaskInput({ label: 'a', dueBy: '2026-07-13T09:00:00Z' })).toBeNull();
    expect(validateCreateTaskInput({ label: 'a', staffId: 'nope' })).toMatch(/staffId/);
    expect(validateCreateTaskInput({ label: 'a', staffId: U })).toBeNull();
  });
});

describe('normalizeCreateTaskInput', () => {
  it('trims label and coerces empty optionals to null', () => {
    expect(normalizeCreateTaskInput({ label: '  Prep  ', taskType: '  ', dueBy: '', staffId: 'bad' })).toEqual({
      label: 'Prep',
      taskType: null,
      dueBy: null,
      staffId: null,
    });
    expect(normalizeCreateTaskInput({ label: 'A', taskType: 'restock', dueBy: '2026-07-13T09:00:00Z', staffId: U })).toEqual({
      label: 'A',
      taskType: 'restock',
      dueBy: '2026-07-13T09:00:00Z',
      staffId: U,
    });
  });
});

describe('isUuid', () => {
  it('accepts uuids and rejects junk', () => {
    expect(isUuid(U)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('validateDecisionInput (manager three-state decision)', () => {
  it('accepts approve with no reason fields', () => {
    expect(validateDecisionInput({ decision: 'approve' })).toBeNull();
  });

  it('accepts shelve with no reason fields', () => {
    expect(validateDecisionInput({ decision: 'shelve' })).toBeNull();
  });

  it('accepts reject with a valid structured category (detail optional)', () => {
    expect(validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'missing_evidence' })).toBeNull();
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'needs_more_detail', rejectionReasonDetail: 'add the tray photo' }),
    ).toBeNull();
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'other', rejectionReasonDetail: null }),
    ).toBeNull();
  });

  it('rejects a missing or unknown decision', () => {
    expect(validateDecisionInput(undefined)).toMatch(/body/);
    expect(validateDecisionInput({} as never)).toMatch(/decision/);
    expect(validateDecisionInput({ decision: 'close' } as never)).toMatch(/decision/);
  });

  it('requires a valid category when rejecting', () => {
    expect(validateDecisionInput({ decision: 'reject' })).toMatch(/rejectionReasonCategory/);
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'nonsense' as never }),
    ).toMatch(/rejectionReasonCategory/);
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: null }),
    ).toMatch(/rejectionReasonCategory/);
  });

  it('rejects an over-long or non-string detail on reject', () => {
    const tooLong = 'x'.repeat(1001);
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'wrong_task', rejectionReasonDetail: tooLong }),
    ).toMatch(/rejectionReasonDetail/);
    expect(
      validateDecisionInput({ decision: 'reject', rejectionReasonCategory: 'wrong_task', rejectionReasonDetail: 123 as never }),
    ).toMatch(/rejectionReasonDetail/);
  });

  it('ignores reason fields entirely for approve/shelve (no false negatives)', () => {
    expect(
      validateDecisionInput({ decision: 'approve', rejectionReasonCategory: 'nonsense' as never, rejectionReasonDetail: 'x'.repeat(5000) }),
    ).toBeNull();
    expect(
      validateDecisionInput({ decision: 'shelve', rejectionReasonCategory: 'nonsense' as never }),
    ).toBeNull();
  });
});
