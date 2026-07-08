import { describe, expect, it } from 'vitest';
import type { OverviewResult, RecommendationRecord } from '@clearview/shared';
import { buildDomainTiles, type DomainKey } from './domain-model';

function tile(tiles: ReturnType<typeof buildDomainTiles>, key: DomainKey) {
  return tiles.find((t) => t.key === key)!;
}

const rec = (domain: RecommendationRecord['domain']): RecommendationRecord =>
  ({ domain }) as RecommendationRecord;

const overview = (over: Partial<OverviewResult>): OverviewResult => ({
  tempo: { score: 100, openConflicts: 0, overdue: 0, openRecommendations: 0 },
  counts: {},
  inventoryLow: 0,
  metrics: {},
  ledger: [],
  comms: [],
  ...over,
});

describe('buildDomainTiles', () => {
  it('returns six steady tiles when there is no data', () => {
    const tiles = buildDomainTiles(null, []);
    expect(tiles).toHaveLength(6);
    expect(tiles.every((t) => t.status === 'steady')).toBe(true);
    expect(tile(tiles, 'financial').metrics[0].value).toBe('$0');
    expect(tile(tiles, 'equipment').metrics[0].value).toBe('0/0');
  });

  it('flips a domain to action when it has an open cue', () => {
    const tiles = buildDomainTiles(overview({ counts: { InventoryItem: 4 }, inventoryLow: 2 }), [rec('inventory')]);
    const inv = tile(tiles, 'inventory');
    expect(inv.status).toBe('action');
    expect(inv.cueCount).toBe(1);
    expect(inv.metrics).toEqual([
      { label: 'lowStock', value: 2 },
      { label: 'items', value: 4 },
    ]);
  });

  it('maps patient_flow cues onto the patients tile', () => {
    const tiles = buildDomainTiles(overview({ counts: { Task: 3 } }), [rec('patient_flow')]);
    expect(tile(tiles, 'patients').status).toBe('action');
    expect(tile(tiles, 'staff').status).toBe('steady');
  });

  it('shows watch (not action) when there is a signal but no cue', () => {
    const tiles = buildDomainTiles(
      overview({ inventoryLow: 1, tempo: { score: 70, openConflicts: 0, overdue: 2, openRecommendations: 0 } }),
      [],
    );
    expect(tile(tiles, 'inventory').status).toBe('watch');
    expect(tile(tiles, 'patients').status).toBe('watch'); // overdue > 0
    expect(tile(tiles, 'patients').metrics[1]).toEqual({ label: 'overdue', value: 2 });
  });

  it('renders financial / marketing / equipment tile metrics from the metrics map', () => {
    const tiles = buildDomainTiles(
      overview({
        counts: { Lead: 3, Equipment: 7 },
        metrics: { collectedCents: 824000, unposted: 2, negativeReviews: 1, equipmentReady: 6, calibrationDue: 1 },
      }),
      [],
    );
    const fin = tile(tiles, 'financial');
    expect(fin.status).toBe('watch'); // unposted > 0
    expect(fin.metrics).toEqual([
      { label: 'collected', value: '$8,240' },
      { label: 'unposted', value: 2 },
    ]);

    const mkt = tile(tiles, 'marketing');
    expect(mkt.status).toBe('watch'); // negative reviews > 0
    expect(mkt.metrics).toEqual([
      { label: 'newLeads', value: 3 },
      { label: 'negativeReviews', value: 1 },
    ]);

    const eq = tile(tiles, 'equipment');
    expect(eq.status).toBe('watch'); // calibration due > 0
    expect(eq.metrics).toEqual([
      { label: 'ready', value: '6/7' },
      { label: 'calibrationDue', value: 1 },
    ]);
  });

  it('an open cue outranks a watch signal (action wins)', () => {
    const tiles = buildDomainTiles(overview({ metrics: { negativeReviews: 1 } }), [rec('marketing')]);
    expect(tile(tiles, 'marketing').status).toBe('action');
  });
});
