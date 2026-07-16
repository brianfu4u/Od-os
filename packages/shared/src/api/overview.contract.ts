/** Command-center overview aggregate — one call feeds the podium, tiles, ledger, and comms. */
export interface OverviewTempo {
  score: number;
  openConflicts: number;
  overdue: number;
  openRecommendations: number;
}

export interface LedgerEntrySummary {
  objectId: string;
  title: string;
  verifiedState: string;
  verificationScore: number;
  evidenceCount: number;
  /** Distinct evidence kinds present (qr_scan/snapshot/document/communication/…) for chips. */
  evidenceKinds: string[];
  at: string;
}

export interface CommSummary {
  id: string;
  author: string;
  text: string;
  reportType?: string;
  at: string;
}

export interface OverviewResult {
  tempo: OverviewTempo;
  /** Object counts by type (Staff, Task, InventoryItem, Communication, Alert, Recommendation, …). */
  counts: Record<string, number>;
  inventoryLow: number;
  /**
   * Domain-specific tile metrics for the six-domain grid (financial/marketing/equipment need
   * property-level aggregation the raw type counts can't give). Keys: collectedCents, unposted,
   * negativeReviews, equipmentReady, calibrationDue. Missing keys default to 0 in the UI.
   */
  metrics: Record<string, number>;
  ledger: LedgerEntrySummary[];
  comms: CommSummary[];
}
