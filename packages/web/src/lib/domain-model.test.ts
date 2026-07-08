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
  ledger: [],
  comms: [],
  ...over,
});

describe('buildDomainTiles', () => {
  it('returns six steady tiles with zeros when there is no data', () => {
    const tiles = buildDomainTiles(null, []);
    expect(tiles).toHaveLength(6);
    expect(tiles.every((t) => t.status === 'steady')).toBe(true);
    expect(tiles.every((t) => t.metrics.every((m) => m.value === 0))).toBe(true);
  });

  it('flips a domain to action when it has an open cue', () => {
    const tiles = buildDomainTiles(overview({ counts: { InventoryItem: 4 }, inventoryLow: 2 }), [rec('inventory')]);
    const inv = tile(tiles, 'inventory');
    expect(inv.status).toBe('action');
    expect(inv.cueCount).toBe(1);
    expect(inv.metrics[0]).toEqual({ label: 'lowStock', value: 2 });
    expect(inv.metrics[1]).toEqual({ label: 'items', value: 4 });
  });

  it('maps patient_flow cues onto the patients tile', () => {
    const tiles = buildDomainTiles(overview({ counts: { Task: 3 } }), [rec('patient_flow')]);
    expect(tile(tiles, 'patients').status).toBe('action');
    expect(tile(tiles, 'staff').status).toBe('steady');
  });

  it('shows watch (not action) when there is a signal but no cue', () => {
    const tiles = buildDomainTiles(overview({ inventoryLow: 1, tempo: { score: 70, openConflicts: 0, overdue: 2, openRecommendations: 0 } }), []);
    expect(tile(tiles, 'inventory').status).toBe('watch');
    expect(tile(tiles, 'patients').status).toBe('watch'); // overdue > 0
    expect(tile(tiles, 'patients').metrics[1]).toEqual({ label: 'overdue', value: 2 });
  });
});
