/**
 * Pressure Exposure Helper
 * 
 * Computes per-entity (settlement SID) pressure exposure from state.front_pressure.
 * Deterministic: stable ordering, half-split attribution for edge pressure.
 * 
 * This is used as a proxy for "local exhaustion" until a true per-entity exhaustion model exists.
 */

import type { GameState } from '../../state/game_state.js';
import type { FrontEdge } from '../../map/front_edges.js';

export type EntityId = string; // Settlement SID

/**
 * Parse edge ID (format: "a__b" where a < b) into [a, b] pair.
 */
function parseEdgeId(edgeId: string): [string, string] | null {
  const idx = edgeId.indexOf('__');
  if (idx <= 0 || idx === edgeId.length - 2) return null;
  const a = edgeId.slice(0, idx);
  const b = edgeId.slice(idx + 2);
  return a && b ? [a, b] : null;
}

/**
 * Compute pressure exposure per entity (settlement SID) from state.front_pressure.
 * 
 * For each edge with pressure p:
 * - Split p/2 to each endpoint (a, b)
 * - Sum exposures per entity
 * 
 * Deterministic: stable sorted edge iteration, stable entity ordering.
 * 
 * @param state Game state (reads state.front_pressure)
 * @param derivedFrontEdges Optional front edges for validation (if provided, only count edges that exist in front_edges)
 * @returns Map from EntityId (settlement SID) to pressure exposure (non-negative)
 */
export function computePressureExposureByEntity(
  state: GameState,
  derivedFrontEdges?: FrontEdge[]
): Map<EntityId, number> {
  const exposure = new Map<EntityId, number>();
  
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') {
    return exposure;
  }
  
  // Build set of valid edge IDs if front edges provided (for validation)
  const validEdgeIds = derivedFrontEdges
    ? new Set(derivedFrontEdges.map(e => e.edge_id))
    : null;
  
  // Get all pressure-bearing edges in stable sorted order
  const edgeIds = Object.keys(fp)
    .filter((k) => {
      // Skip if not in valid front edges (if provided)
      if (validEdgeIds && !validEdgeIds.has(k)) return false;
      
      const v = (fp as Record<string, { value?: unknown }>)[k];
      return v && typeof v === 'object' && typeof (v as { value: number }).value === 'number';
    })
    .sort((a, b) => a.localeCompare(b));
  
  for (const edgeId of edgeIds) {
    const rec = (fp as Record<string, { value: number }>)[edgeId];
    const p = Math.abs(rec?.value ?? 0);
    if (p <= 0) continue;
    
    // Parse edge endpoints
    const pair = parseEdgeId(edgeId);
    if (!pair) continue;
    const [a, b] = pair;
    
    // Half-split attribution (deterministic, matches Phase 3A harness default)
    const halfP = p / 2;
    exposure.set(a, (exposure.get(a) ?? 0) + halfP);
    exposure.set(b, (exposure.get(b) ?? 0) + halfP);
  }
  
  return exposure;
}
