import type { TaskSopConfig } from '@clearview/shared';

const DEFAULT_THRESHOLD = 0.85;

/**
 * Default SOP config for the 5 MVP task types. FROZEN with the clinic in S0-7; these are
 * sensible defaults until then. Per-object overrides come from properties (requiredEvidence,
 * expectedDurationMin), so freezing S0-7 config later needs no engine change.
 */
export const DEFAULT_SOP: Record<string, TaskSopConfig> = {
  room_turnover: { taskType: 'room_turnover', expectedState: 'ready', expectedDurationMin: 6, requiredEvidence: ['snapshot'], confidenceThreshold: 0.85 },
  pretest_done: { taskType: 'pretest_done', expectedState: 'done', expectedDurationMin: 10, requiredEvidence: ['document'], confidenceThreshold: 0.85 },
  dilation_started: { taskType: 'dilation_started', expectedState: 'started', requiredEvidence: ['qr_scan'], confidenceThreshold: 0.8 },
  inventory_reorder: { taskType: 'inventory_reorder', expectedState: 'ordered', requiredEvidence: ['document'], confidenceThreshold: 0.85 },
  equipment_calibration: { taskType: 'equipment_calibration', expectedState: 'calibrated', requiredEvidence: ['document'], confidenceThreshold: 0.85 },
};

export function getSopConfig(taskType: string | undefined, overrides?: Partial<TaskSopConfig>): TaskSopConfig {
  const base: TaskSopConfig = (taskType && DEFAULT_SOP[taskType]) || {
    taskType: taskType ?? 'unknown',
    expectedState: 'done',
    requiredEvidence: [],
    confidenceThreshold: DEFAULT_THRESHOLD,
  };
  return { ...base, ...overrides };
}
