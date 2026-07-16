/**
 * S3 Recommendation contract. Domain agents emit candidates from S2 verifications/Alerts;
 * the conductor orchestrator de-conflicts, ranks, and persists Recommendation objects — the
 * evidence-backed Co-Pilot cues the command center shows. Human-in-the-loop: S3 only
 * proposes; approve/dismiss updates status and records intent (no world write until S4).
 */
export type DomainName = 'patient_flow' | 'staff' | 'inventory' | 'equipment' | 'financial' | 'marketing';
export type RecommendationStatus = 'open' | 'approved' | 'dismissed' | 'snoozed';
export type RiskTier = 'low' | 'high';
export type Severity = 'low' | 'medium' | 'high';

export interface ProposedAction {
  label: string;
  actionType: string;
  riskTier: RiskTier;
  needsApproval: boolean;
}

export interface RecommendationEvidence {
  kind: string;
  ref?: string;
  note?: string;
}

/** A candidate emitted by a domain agent (before de-conflict/rank). */
export interface RecommendationCandidate {
  domain: DomainName;
  sourceAgent: DomainName;
  title: string;
  why: string;
  evidence: RecommendationEvidence[];
  confidence: number;
  proposedActions: ProposedAction[];
  /** Subject object (the Task/Room/InventoryItem the cue is about). */
  objectId: string;
  /** Alert this cue addresses, if any. */
  addresses?: string;
  severity: Severity;
  /** Business impact multiplier (configurable; default 1). */
  impact?: number;
  /** Shared resource key for cross-domain de-conflict (e.g. a staff id being moved). */
  resourceKey?: string;
}

/** A candidate after the orchestrator ranks and (optionally) annotates a trade-off. */
export interface RankedRecommendation extends RecommendationCandidate {
  rank: number;
  score: number;
  tradeoff?: string;
}

export interface RecommendationRecord {
  id: string;
  domain: DomainName;
  sourceAgent: DomainName;
  title: string;
  why: string;
  evidence: RecommendationEvidence[];
  /** B-family agent self-confidence (NOT the S2 verdict score). Kept as `confidence` on purpose in P1-4. */
  confidence: number;
  actions: ProposedAction[];
  rank: number;
  status: RecommendationStatus;
  objectId: string;
  tradeoff?: string;
  /** P2/S4: outcome of executing this cue when approved (present once acted on). */
  execution?: RecommendationExecution;
}

/**
 * P2/S4 action write-back outcomes. `executed` = a whitelisted low-risk INTERNAL ontology
 * write-back was applied; `blocked_high_risk` = a high-risk action was approved but deliberately
 * NOT executed (recorded only); `recorded_intent` = nothing to auto-execute (a nudge / manual
 * action); `not_executable` = a whitelisted action could not run (e.g. missing target);
 * `undone` = a prior executed action was reversed.
 */
export type ActionResult = 'executed' | 'blocked_high_risk' | 'recorded_intent' | 'not_executable' | 'undone';

/** Compact execution marker stored on the Recommendation (also the idempotency guard). */
export interface RecommendationExecution {
  state: ActionResult;
  actionType?: string;
  riskTier?: RiskTier;
  actionLogId?: string;
  targetObjectId?: string | null;
  createdObjectId?: string | null;
  undoable?: boolean;
  at?: string;
}

/** A row of the append-only action_log — the auditable record of what a manager's approval did. */
export interface ActionLogRecord {
  id: string;
  recommendationId: string;
  actionType: string;
  result: ActionResult;
  riskTier?: RiskTier;
  actor?: string;
  targetObjectId?: string | null;
  createdObjectId?: string | null;
  undoable: boolean;
  undoOf?: string | null;
  at: string;
}

/** Rolled-up clinic health for the command-center podium header. */
export interface OperatingTempo {
  score: number; // 0..100
  openConflicts: number;
  overdue: number;
  openRecommendations: number;
}
