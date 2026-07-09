import type { ActionContext, ActionHandler, ActionSubject, WritebackResult } from './actions.types';
import { addLink, archiveObject, emitEvent, insertObject, patchProps, restoreProps } from './actions.sql';

/**
 * The low-risk, INTERNAL ontology write-back whitelist (P2 · S4). Approving a recommendation only
 * ever runs one of these — each creates/patches objects WITHIN the tenant and has NO external side
 * effect (no messaging, no real ordering, no payment). High-risk actions are never registered here,
 * so they can never be auto-executed. Every handler is undoable.
 *
 * The keys are the canonical `actionType` values the domain agents emit for these cues.
 */

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function reassignTarget(ctx: ActionContext): string | undefined {
  return str(ctx.params, 'to') ?? str(ctx.subject.properties, 'reassignTo');
}

/** inventory_reorder → create an internal restock Task for a low-stock item. */
const inventoryReorder: ActionHandler = {
  actionType: 'inventory_reorder',
  undoable: true,
  describe: (s: ActionSubject) => `Create reorder task for ${str(s.properties, 'name') ?? s.id}`,
  canExecute: () => null,
  async execute(ctx: ActionContext): Promise<WritebackResult> {
    const p = ctx.subject.properties;
    const name = str(p, 'name') ?? str(p, 'sku') ?? 'item';
    const taskId = await insertObject(
      ctx.client,
      ctx.tenantId,
      'Task',
      {
        taskType: 'inventory_reorder',
        label: `Reorder ${name}`,
        requiredEvidence: ['document'],
        forItem: ctx.subject.id,
        sku: str(p, 'sku') ?? null,
        createdByAction: 'inventory_reorder',
      },
      ctx.actor,
      { expected: 'ordered' },
    );
    await addLink(ctx.client, ctx.tenantId, taskId, ctx.subject.id, 'consumes');
    return { createdObjectId: taskId, targetObjectId: null, before: null, after: { createdTaskId: taskId, taskType: 'inventory_reorder' } };
  },
  async undo(ctx, log) {
    // Undo a pure create = archive the task the action created.
    if (log.createdObjectId) await archiveObject(ctx.client, ctx.tenantId, log.createdObjectId, ctx.actor);
  },
};

/**
 * reassign_task → set the Task's `assignedTo` property to the proposed owner.
 * TODO(prod): a real reassignment should resolve a Staff id and move the `assignedTo` LINK, not just
 * stamp a display-name property; kept simple + reversible here for the internal MVP write-back.
 */
const reassignTask: ActionHandler = {
  actionType: 'reassign_task',
  undoable: true,
  describe: (s: ActionSubject) => `Reassign ${str(s.properties, 'label') ?? s.id}`,
  canExecute: (ctx: ActionContext) => (reassignTarget(ctx) ? null : 'no reassign target (params.to / properties.reassignTo)'),
  async execute(ctx: ActionContext): Promise<WritebackResult> {
    const to = reassignTarget(ctx)!;
    const patched = await patchProps(ctx.client, ctx.subject.id, { assignedTo: to });
    await emitEvent(ctx.client, ctx.tenantId, ctx.subject.id, 'object.updated', { changed: ['assignedTo'], via: 'action' }, ctx.actor);
    return {
      targetObjectId: ctx.subject.id,
      createdObjectId: null,
      before: patched?.before ?? { assignedTo: undefined },
      after: patched?.after ?? { assignedTo: to },
    };
  },
  async undo(ctx, log) {
    if (log.targetObjectId && log.before) {
      await restoreProps(ctx.client, log.targetObjectId, log.before);
      await emitEvent(ctx.client, ctx.tenantId, log.targetObjectId, 'object.updated', { changed: ['assignedTo'], via: 'action.undo' }, ctx.actor);
    }
  },
};

/** equipment_offline → set Equipment status=offline AND create an internal calibration Task. */
const equipmentOffline: ActionHandler = {
  actionType: 'equipment_offline',
  undoable: true,
  describe: (s: ActionSubject) => `Set ${str(s.properties, 'label') ?? 'device'} offline + create calibration task`,
  canExecute: () => null,
  async execute(ctx: ActionContext): Promise<WritebackResult> {
    const p = ctx.subject.properties;
    const prevStatus = typeof p.status === 'string' ? p.status : null;
    await patchProps(ctx.client, ctx.subject.id, { status: 'offline' });
    await emitEvent(ctx.client, ctx.tenantId, ctx.subject.id, 'object.updated', { changed: ['status'], status: 'offline', via: 'action' }, ctx.actor);
    const label = str(p, 'label') ?? 'device';
    const taskId = await insertObject(
      ctx.client,
      ctx.tenantId,
      'Task',
      {
        taskType: 'equipment_calibration',
        label: `Recalibrate ${label}`,
        requiredEvidence: ['document'],
        forEquipment: ctx.subject.id,
        createdByAction: 'equipment_offline',
      },
      ctx.actor,
      { expected: 'calibrated' },
    );
    await addLink(ctx.client, ctx.tenantId, taskId, ctx.subject.id, 'references');
    return { targetObjectId: ctx.subject.id, createdObjectId: taskId, before: { status: prevStatus }, after: { status: 'offline', calibrationTaskId: taskId } };
  },
  async undo(ctx, log) {
    if (log.targetObjectId && log.before) {
      await restoreProps(ctx.client, log.targetObjectId, log.before); // status → prior value
      await emitEvent(ctx.client, ctx.tenantId, log.targetObjectId, 'object.updated', { changed: ['status'], via: 'action.undo' }, ctx.actor);
    }
    if (log.createdObjectId) await archiveObject(ctx.client, ctx.tenantId, log.createdObjectId, ctx.actor);
  },
};

/** flag_review_followup → create an internal follow-up Task for a negative review. */
const flagReviewFollowup: ActionHandler = {
  actionType: 'flag_review_followup',
  undoable: true,
  describe: (s: ActionSubject) => `Create follow-up task for review ${str(s.properties, 'label') ?? s.id}`,
  canExecute: () => null,
  async execute(ctx: ActionContext): Promise<WritebackResult> {
    const p = ctx.subject.properties;
    const rating = typeof p.rating === 'number' ? p.rating : undefined;
    const taskId = await insertObject(
      ctx.client,
      ctx.tenantId,
      'Task',
      {
        taskType: 'review_followup',
        label: rating !== undefined ? `Follow up on ${rating}★ review` : 'Follow up on review',
        requiredEvidence: [],
        forReview: ctx.subject.id,
        createdByAction: 'flag_review_followup',
      },
      ctx.actor,
    );
    await addLink(ctx.client, ctx.tenantId, taskId, ctx.subject.id, 'references');
    return { createdObjectId: taskId, targetObjectId: null, before: null, after: { createdTaskId: taskId, taskType: 'review_followup' } };
  },
  async undo(ctx, log) {
    if (log.createdObjectId) await archiveObject(ctx.client, ctx.tenantId, log.createdObjectId, ctx.actor);
  },
};

export const EXECUTABLE_ACTIONS: Readonly<Record<string, ActionHandler>> = {
  [inventoryReorder.actionType]: inventoryReorder,
  [reassignTask.actionType]: reassignTask,
  [equipmentOffline.actionType]: equipmentOffline,
  [flagReviewFollowup.actionType]: flagReviewFollowup,
};

/** The canonical actionTypes eligible for auto-execution on approval. Everything else is recorded only. */
export const EXECUTABLE_ACTION_TYPES: readonly string[] = Object.keys(EXECUTABLE_ACTIONS);

export function getHandler(actionType: string): ActionHandler | undefined {
  return EXECUTABLE_ACTIONS[actionType];
}
