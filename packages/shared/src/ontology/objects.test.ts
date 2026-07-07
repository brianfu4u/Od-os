import { describe, it, expect } from 'vitest';
import {
  isMvpObjectType,
  isMvpTaskType,
  isVerifiedState,
  isLinkRelation,
  isConfidence,
  MVP_OBJECT_TYPES,
  MVP_TASK_TYPES,
} from './objects';

describe('ontology guards', () => {
  it('recognizes the 8 MVP object types', () => {
    expect(MVP_OBJECT_TYPES).toHaveLength(8);
    expect(isMvpObjectType('Task')).toBe(true);
    expect(isMvpObjectType('InventoryItem')).toBe(true);
    expect(isMvpObjectType('Nope')).toBe(false);
  });

  it('freezes exactly 5 MVP task types', () => {
    expect(MVP_TASK_TYPES).toHaveLength(5);
    expect(isMvpTaskType('room_turnover')).toBe(true);
    expect(isMvpTaskType('teleport_patient')).toBe(false);
  });

  it('recognizes cross-verification states', () => {
    expect(isVerifiedState('conflict')).toBe(true);
    expect(isVerifiedState('pending')).toBe(true);
    expect(isVerifiedState('done')).toBe(false);
  });

  it('recognizes link relations', () => {
    expect(isLinkRelation('assignedTo')).toBe(true);
    expect(isLinkRelation('marriedTo')).toBe(false);
  });

  it('validates the confidence range [0,1]', () => {
    expect(isConfidence(0)).toBe(true);
    expect(isConfidence(0.76)).toBe(true);
    expect(isConfidence(1)).toBe(true);
    expect(isConfidence(1.2)).toBe(false);
    expect(isConfidence(-0.1)).toBe(false);
    expect(isConfidence(Number.NaN)).toBe(false);
  });
});
