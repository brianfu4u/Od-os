/**
 * Domain drill-down constants. Kept in a plain (non-'use client') module so both the server
 * component (generateStaticParams) and the client detail component can import the runtime values
 * safely across the RSC boundary.
 */
import type { DomainName } from '@clearview/shared';

export const DOMAIN_KEYS = ['staff', 'patients', 'financial', 'marketing', 'equipment', 'inventory'] as const;
export type DomainKey = (typeof DOMAIN_KEYS)[number];

/** Object types that roll up into each domain tile. */
export const DOMAIN_TYPES: Record<DomainKey, string[]> = {
  patients: ['Task'],
  staff: ['Task', 'Staff'],
  inventory: ['InventoryItem'],
  equipment: ['Equipment'],
  financial: ['Invoice', 'Claim', 'Payment'],
  marketing: ['Review', 'Lead', 'Campaign'],
};

/** Which recommendation domain a tile maps to. */
export const TILE_TO_RECDOMAIN: Record<DomainKey, DomainName> = {
  patients: 'patient_flow',
  staff: 'staff',
  inventory: 'inventory',
  equipment: 'equipment',
  financial: 'financial',
  marketing: 'marketing',
};

export const DOMAIN_ICON: Record<DomainKey, string> = {
  staff: '👥',
  patients: '🩺',
  financial: '💳',
  marketing: '📣',
  equipment: '🛠️',
  inventory: '📦',
};

export function isDomainKey(x: string): x is DomainKey {
  return (DOMAIN_KEYS as readonly string[]).includes(x);
}
