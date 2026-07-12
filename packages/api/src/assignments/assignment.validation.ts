import type { AssignTaskInput, CreateTaskInput } from '@clearview/shared';

/**
 * Pure input validation for the manager assignment endpoints (unit-testable without Nest). Returns
 * a human-readable error string, or null when the input is acceptable. UUID shape is checked here;
 * WHETHER the ids actually exist IN THE TENANT is enforced server-side by the repository under RLS
 * (never trusted from the client).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL = 200;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function validateAssignInput(body: Partial<AssignTaskInput> | undefined): string | null {
  if (!body) return 'body is required';
  if (!isUuid(body.taskId)) return 'taskId (uuid) is required';
  if (!isUuid(body.staffId)) return 'staffId (uuid) is required';
  return null;
}

export function validateCreateTaskInput(body: Partial<CreateTaskInput> | undefined): string | null {
  if (!body) return 'body is required';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return 'label is required';
  if (label.length > MAX_LABEL) return `label must be at most ${MAX_LABEL} characters`;
  if (body.taskType !== undefined && body.taskType !== null && typeof body.taskType !== 'string') {
    return 'taskType must be a string';
  }
  if (body.dueBy !== undefined && body.dueBy !== null) {
    if (typeof body.dueBy !== 'string' || Number.isNaN(Date.parse(body.dueBy))) {
      return 'dueBy must be an ISO date string';
    }
  }
  if (body.staffId !== undefined && body.staffId !== null && !isUuid(body.staffId)) {
    return 'staffId (uuid) is invalid';
  }
  return null;
}

/** Normalize a create-task input: trim the label, drop empty optionals. */
export function normalizeCreateTaskInput(body: CreateTaskInput): CreateTaskInput {
  return {
    label: body.label.trim(),
    taskType: typeof body.taskType === 'string' && body.taskType.trim() ? body.taskType.trim() : null,
    dueBy: typeof body.dueBy === 'string' && body.dueBy.trim() ? body.dueBy.trim() : null,
    staffId: isUuid(body.staffId) ? body.staffId : null,
  };
}
