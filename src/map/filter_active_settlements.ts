/**
 * Filter utilities for active settlements.
 * 
 * Active settlements are those that should be included in gameplay logic:
 * - Adjacency calculations
 * - Movement and supply
 * - Frontline generation
 * - Control and ownership
 * 
 * Quarantined settlements (orphans, fallback geometries) are excluded.
 */

export interface SettlementProperties {
  is_orphan?: boolean;
  usesFallbackGeometry?: boolean;
  [key: string]: unknown;
}

/**
 * Check if a settlement is active (should be included in gameplay).
 * 
 * @param settlement - Settlement record with properties
 * @returns true if settlement is active, false if quarantined
 */
export function isSettlementActive(settlement: { properties?: SettlementProperties }): boolean {
  const props = settlement.properties || {};

  // Quarantine orphan settlements (degree 0)
  if (props.is_orphan === true) {
    return false;
  }

  // Quarantine fallback geometries (pending manual review)
  if (props.usesFallbackGeometry === true) {
    return false;
  }

  return true;
}

/**
 * Filter an array of settlements to only active ones.
 */
export function filterActiveSettlements<T extends { properties?: SettlementProperties }>(
  settlements: T[]
): T[] {
  return settlements.filter(isSettlementActive);
}

/**
 * Filter a Map of settlements to only active ones.
 */
export function filterActiveSettlementMap<T extends { properties?: SettlementProperties }>(
  settlements: Map<string, T>
): Map<string, T> {
  const filtered = new Map<string, T>();
  for (const [sid, settlement] of settlements.entries()) {
    if (isSettlementActive(settlement)) {
      filtered.set(sid, settlement);
    }
  }
  return filtered;
}
