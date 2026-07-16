/**
 * Ontology objects, links, and the state triplet.
 * Source of truth: docs/01-structure-design.md §2.
 */

/**
 * Object types the MVP explicitly supports and type-checks against.
 * NOTE: the `objects.type` column is free text on purpose — the store is generic
 * and the full ontology has many more types. These are just the ones S0-2 must cover.
 */
export const MVP_OBJECT_TYPES = [
  'Task',
  'Communication',
  'Document',
  'Snapshot',
  'Verification',
  'Staff',
  'Room',
  'InventoryItem',
] as const;
export type MvpObjectType = (typeof MVP_OBJECT_TYPES)[number];

/** Broader ontology object types (structure-design §2). Modeled generically, not all used in MVP. */
export const EXTENDED_OBJECT_TYPES = [
  'Patient',
  'Visit',
  'JourneyStage',
  'Appointment',
  'Equipment',
  'Invoice',
  'Claim',
  'Payment',
  'Campaign',
  'Lead',
  'Review',
  'Observation',
  'Alert',
  'Recommendation',
  'ActionLog',
  'LoopRun',
  'Tenant',
  'SOP',
  'KPIThreshold',
  'Role',
] as const;
export type ExtendedObjectType = (typeof EXTENDED_OBJECT_TYPES)[number];

export type ObjectType = MvpObjectType | ExtendedObjectType;

/**
 * The 5 MVP task types. These are FROZEN with the clinic in ticket S0-7 together
 * with their SOP + requiredEvidence — do not hardcode verification logic against
 * them yet. Stored in `objects.properties.taskType`.
 */
export const MVP_TASK_TYPES = [
  'room_turnover',
  'pretest_done',
  'dilation_started',
  'inventory_reorder',
  'equipment_calibration',
] as const;
export type MvpTaskType = (typeof MVP_TASK_TYPES)[number];

/** Cross-verification result states (structure-design §4). */
export const VERIFIED_STATES = ['verified', 'conflict', 'pending', 'unverified'] as const;
export type VerifiedState = (typeof VERIFIED_STATES)[number];

/** Ontology link relations (structure-design §2). Stored as free text for extensibility. */
export const LINK_RELATIONS = [
  'assignedTo',
  'partOf',
  'uses',
  'consumes',
  'references',
  'verifies',
  'forPatient',
  'forVisit',
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/**
 * The state triplet carried by every operational object — the native primitive
 * that makes cross-verification a first-class property of the ontology.
 *   expected = what the SOP says it should be
 *   claimed  = what a communication asserts it is
 *   verified = the cross-verified truth + verificationScore
 */
export interface StateTriplet {
  expectedState: string | null;
  claimedState: string | null;
  /** Typically a VerifiedState, kept as string for generic objects. */
  verifiedState: string | null;
  /** Verification score in [0, 1]. */
  verificationScore: number | null;
}

/** A row in the generic `objects` table. */
export interface OntologyObject<TProps = Record<string, unknown>> extends StateTriplet {
  id: string;
  tenantId: string;
  /** ObjectType for known types; free text for the long tail of the ontology. */
  type: string;
  properties: TProps;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** A row in the `links` table (directed, tenant-scoped). */
export interface OntologyLink {
  id: string;
  tenantId: string;
  fromObject: string;
  toObject: string;
  /** LinkRelation for known relations; free text otherwise. */
  relation: string;
  createdAt: string;
}

/**
 * Illustrative task-specific properties. In the generic store these live inside
 * `objects.properties` (JSONB), NOT as columns.
 */
export interface TaskProperties {
  taskType: MvpTaskType | string;
  /** e.g. ['snapshot'] — evidence that must exist before the task can be 'verified'. */
  requiredEvidence?: string[];
  expectedDurationMin?: number;
  dueBy?: string;
  tags?: string[];
}

// ---- runtime guards -------------------------------------------------------

export function isMvpObjectType(t: string): t is MvpObjectType {
  return (MVP_OBJECT_TYPES as readonly string[]).includes(t);
}

export function isMvpTaskType(t: string): t is MvpTaskType {
  return (MVP_TASK_TYPES as readonly string[]).includes(t);
}

export function isVerifiedState(s: string): s is VerifiedState {
  return (VERIFIED_STATES as readonly string[]).includes(s);
}

export function isLinkRelation(r: string): r is LinkRelation {
  return (LINK_RELATIONS as readonly string[]).includes(r);
}

/** Verification score must be a finite number within [0, 1]. */
export function isVerificationScore(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}
