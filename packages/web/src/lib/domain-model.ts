/**
 * Pure derivation of the six 360° domain tiles from the live overview aggregate + open
 * recommendations. Kept side-effect-free so it is unit-testable and the UI stays dumb.
 * Every number here traces to a real object count / ledger fact / metric — nothing is fabricated.
 */
import type { DomainName, OverviewResult, RecommendationRecord } from '@clearview/shared';

export type DomainKey = 'staff' | 'patients' | 'financial' | 'marketing' | 'equipment' | 'inventory';
export type DomainStatus = 'steady' | 'watch' | 'action';

export interface DomainMetric {
  /** i18n key under domains.metrics.* */
  label: string;
  value: number | string;
}

export interface DomainVM {
  key: DomainKey;
  icon: string;
  status: DomainStatus;
  metrics: [DomainMetric, DomainMetric];
  cueCount: number;
}

const ICON: Record<DomainKey, string> = {
  staff: '👥',
  patients: '🩺',
  financial: '💳',
  marketing: '📣',
  equipment: '🛠️',
  inventory: '📦',
};

/** Which recommendation domains roll up into which tile. */
const DOMAIN_TO_TILE: Record<DomainName, DomainKey> = {
  patient_flow: 'patients',
  staff: 'staff',
  inventory: 'inventory',
  equipment: 'equipment',
  financial: 'financial',
  marketing: 'marketing',
};

export function buildDomainTiles(
  overview: OverviewResult | null,
  recs: RecommendationRecord[],
): DomainVM[] {
  const counts = overview?.counts ?? {};
  const tempo = overview?.tempo;
  const metrics = overview?.metrics ?? {};
  const metric = (k: string): number => metrics[k] ?? 0;

  const cueByTile: Record<DomainKey, number> = {
    staff: 0,
    patients: 0,
    financial: 0,
    marketing: 0,
    equipment: 0,
    inventory: 0,
  };
  for (const r of recs) cueByTile[DOMAIN_TO_TILE[r.domain]] += 1;

  const overdue = tempo?.overdue ?? 0;
  const conflicts = tempo?.openConflicts ?? 0;
  const inventoryLow = overview?.inventoryLow ?? 0;
  const dollars = Math.round(metric('collectedCents') / 100);

  const status = (cues: number, watch: boolean): DomainStatus =>
    cues > 0 ? 'action' : watch ? 'watch' : 'steady';

  const tiles: DomainVM[] = [
    {
      key: 'staff',
      icon: ICON.staff,
      status: status(cueByTile.staff, false),
      metrics: [
        { label: 'onDuty', value: counts.Staff ?? 0 },
        { label: 'cues', value: cueByTile.staff },
      ],
      cueCount: cueByTile.staff,
    },
    {
      key: 'patients',
      icon: ICON.patients,
      status: status(cueByTile.patients, overdue > 0 || conflicts > 0),
      metrics: [
        { label: 'activeTasks', value: counts.Task ?? 0 },
        { label: 'overdue', value: overdue },
      ],
      cueCount: cueByTile.patients,
    },
    {
      key: 'financial',
      icon: ICON.financial,
      status: status(cueByTile.financial, metric('unposted') > 0),
      metrics: [
        { label: 'collected', value: `$${dollars.toLocaleString('en-US')}` },
        { label: 'unposted', value: metric('unposted') },
      ],
      cueCount: cueByTile.financial,
    },
    {
      key: 'marketing',
      icon: ICON.marketing,
      status: status(cueByTile.marketing, metric('negativeReviews') > 0),
      metrics: [
        { label: 'newLeads', value: counts.Lead ?? 0 },
        { label: 'negativeReviews', value: metric('negativeReviews') },
      ],
      cueCount: cueByTile.marketing,
    },
    {
      key: 'equipment',
      icon: ICON.equipment,
      status: status(cueByTile.equipment, metric('calibrationDue') > 0),
      metrics: [
        { label: 'ready', value: `${metric('equipmentReady')}/${counts.Equipment ?? 0}` },
        { label: 'calibrationDue', value: metric('calibrationDue') },
      ],
      cueCount: cueByTile.equipment,
    },
    {
      key: 'inventory',
      icon: ICON.inventory,
      status: status(cueByTile.inventory, inventoryLow > 0),
      metrics: [
        { label: 'lowStock', value: inventoryLow },
        { label: 'items', value: counts.InventoryItem ?? 0 },
      ],
      cueCount: cueByTile.inventory,
    },
  ];

  return tiles;
}
