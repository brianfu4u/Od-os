/**
 * Deterministic thresholds for the domain agents. Kept as config (not magic numbers in the
 * detectors) so a clinic can tune calibration the same way S0-7 tunes task SOPs. A per-object
 * `properties` override always wins over these defaults (see each agent). LLM phrasing/ranking
 * remains a later seam; these are the hard, explainable trip-wires.
 */
export interface DomainThresholds {
  financial: {
    /** An Invoice/Payment claimed collected but not verified-posted for longer than this is "unposted". */
    unpostedWindowMin: number;
  };
  marketing: {
    /** A review at or below this rating is "negative". */
    negativeRatingMax: number;
    /** Minutes a negative review may sit unanswered before it breaches SLA. */
    reviewResponseSlaMin: number;
    /** Minutes a lead may sit with no follow-up before it is "unworked". */
    leadUnworkedMin: number;
  };
  equipment: {
    /** Days a calibration stays valid (S0-7 freeze = 30). */
    calibrationValidDays: number;
  };
}

export const DOMAIN_THRESHOLDS: DomainThresholds = {
  financial: { unpostedWindowMin: 30 },
  marketing: { negativeRatingMax: 2, reviewResponseSlaMin: 60, leadUnworkedMin: 24 * 60 },
  equipment: { calibrationValidDays: 30 },
};
