/**
 * Phase 12C.4: Territorial valuation system (deterministic)
 *
 * Produces per-side "value" for each settlement (integer, capped 0..100).
 * Used for:
 * 1) Pricing transfer_settlements in treaty draft (cost/acceptance impact)
 * 2) Improving treaty acceptance (so "non-homeland conquered territory" is more tradable)
 *
 * All computation is deterministic, stable sorts, no timestamps.
 */

import type { GameState, PoliticalSideId } from './game_state.js';
import type { LoadedSettlementGraph } from '../map/settlements.js';
import { getEffectiveSettlementSide } from './control_effective.js';
import { getSettlementSide } from '../map/front_edges.js';
import { buildAdjacencyMap, type AdjacencyMap } from '../map/adjacency_map.js';

export interface TerritorialValuationReport {
  schema: 1;
  turn: number;
  sides: PoliticalSideId[]; // ["RBiH","RS","HRHB"]
  per_settlement: Array<{
    sid: string;
    by_side: Record<PoliticalSideId, number>; // integer 0..100
    components?: Record<string, number>; // optional, small
  }>;
}

export interface ValuationOptions {
  /**
   * Optional hook to get homeland side for a settlement.
   * Returns null if unknown (component will default to neutral).
   * This is a placeholder for future census/ethnic data integration.
   */
  getSettlementHomelandSide?: (sid: string) => PoliticalSideId | null;
}

/**
 * Compute settlement values for all sides.
 *
 * Deterministic: same state + graph -> same report.
 * Sorting: per_settlement sorted by sid asc.
 */
export function computeSettlementValues(
  state: GameState,
  settlementsGraph: LoadedSettlementGraph,
  opts: ValuationOptions = {}
): TerritorialValuationReport {
  const turn = state.meta.turn;
  const sides: PoliticalSideId[] = state.factions.map((f) => f.id).sort();

  // Build adjacency map for contiguity and degree calculations
  const adjacencyMap = buildAdjacencyMap(settlementsGraph.edges);

  // Get all settlement IDs sorted deterministically
  const allSids = Array.from(settlementsGraph.settlements.keys()).sort();

  // Build set of effectively controlled settlements per side (for contiguity check)
  const effectivelyControlledBySide = new Map<PoliticalSideId, Set<string>>();
  for (const side of sides) {
    effectivelyControlledBySide.set(side, new Set());
  }
  for (const sid of allSids) {
    const effectiveSide = getEffectiveSettlementSide(state, sid);
    if (effectiveSide) {
      effectivelyControlledBySide.get(effectiveSide)?.add(sid);
    }
  }

  // Build municipality mapping (for contiguity component)
  const sidToMun = new Map<string, string>();
  for (const [sid, record] of settlementsGraph.settlements.entries()) {
    sidToMun.set(sid, record.mun_code);
  }

  // Compute values per settlement
  const perSettlement: TerritorialValuationReport['per_settlement'] = [];
  for (const sid of allSids) {
    const record = settlementsGraph.settlements.get(sid);
    if (!record) continue;

    const bySide: Record<PoliticalSideId, number> = {} as Record<PoliticalSideId, number>;
    const components: Record<string, number> = {};

    // Compute value for each side
    for (const side of sides) {
      const value = computeSettlementValueForSide(
        sid,
        side,
        state,
        settlementsGraph,
        adjacencyMap,
        effectivelyControlledBySide,
        sidToMun,
        opts
      );
      bySide[side] = value;
    }

    // Optional: include component breakdown (small, for debugging)
    // For now, we'll skip detailed components to keep output minimal

    perSettlement.push({
      sid,
      by_side: bySide
    });
  }

  return {
    schema: 1,
    turn,
    sides,
    per_settlement: perSettlement
  };
}

/**
 * Compute value for a single settlement for a specific side.
 * Returns integer 0..100.
 */
function computeSettlementValueForSide(
  sid: string,
  side: PoliticalSideId,
  state: GameState,
  settlementsGraph: LoadedSettlementGraph,
  adjacencyMap: AdjacencyMap,
  effectivelyControlledBySide: Map<PoliticalSideId, Set<string>>,
  sidToMun: Map<string, string>,
  opts: ValuationOptions
): number {
  let total = 0;

  // B1) Control/heldness component (0..25)
  const controlComponent = computeControlComponent(sid, side, state);
  total += controlComponent;

  // B2) Contiguity component (0..20)
  const contiguityComponent = computeContiguityComponent(
    sid,
    side,
    settlementsGraph,
    adjacencyMap,
    effectivelyControlledBySide,
    sidToMun
  );
  total += contiguityComponent;

  // B3) Corridor/strategic connector proxy (0..20)
  const corridorComponent = computeCorridorComponent(sid, adjacencyMap);
  total += corridorComponent;

  // B4) Homeland proxy component (0..35)
  const homelandComponent = computeHomelandComponent(sid, side, opts);
  total += homelandComponent;

  // Clamp to 0..100
  return Math.max(0, Math.min(100, total));
}

/**
 * B1) Control/heldness component (0..25)
 * - If effective control == side => +25
 * - Else if AoR control == side => +20
 * - Else +0
 */
function computeControlComponent(sid: string, side: PoliticalSideId, state: GameState): number {
  const effectiveControl = getEffectiveSettlementSide(state, sid);
  if (effectiveControl === side) {
    return 25;
  }

  const aorControl = getSettlementSide(state, sid);
  if (aorControl === side) {
    return 20;
  }

  return 0;
}

/**
 * B2) Contiguity component (0..20)
 * - If settlement is adjacent (in settlement graph) to any settlement effectively controlled by side => +10
 * - If also within same municipality as any effectively controlled settlement => +10
 */
function computeContiguityComponent(
  sid: string,
  side: PoliticalSideId,
  settlementsGraph: LoadedSettlementGraph,
  adjacencyMap: AdjacencyMap,
  effectivelyControlledBySide: Map<PoliticalSideId, Set<string>>,
  sidToMun: Map<string, string>
): number {
  let score = 0;

  const controlledSet = effectivelyControlledBySide.get(side);
  if (!controlledSet || controlledSet.size === 0) {
    return 0;
  }

  // Check adjacency
  const neighbors = adjacencyMap[sid] || [];
  let hasAdjacentControlled = false;
  for (const neighbor of neighbors) {
    if (controlledSet.has(neighbor)) {
      hasAdjacentControlled = true;
      break;
    }
  }

  if (hasAdjacentControlled) {
    score += 10;

    // Check same municipality
    const sidMun = sidToMun.get(sid);
    if (sidMun) {
      let hasSameMunControlled = false;
      for (const controlledSid of controlledSet) {
        const controlledMun = sidToMun.get(controlledSid);
        if (controlledMun === sidMun) {
          hasSameMunControlled = true;
          break;
        }
      }
      if (hasSameMunControlled) {
        score += 10;
      }
    }
  }

  return score;
}

/**
 * B3) Corridor/strategic connector proxy (0..20)
 * Use purely graph-based proxy:
 * - degree >= 6 => +20
 * - else if degree >= 4 => +12
 * - else if degree >= 2 => +6
 * - else +0
 */
function computeCorridorComponent(sid: string, adjacencyMap: AdjacencyMap): number {
  const neighbors = adjacencyMap[sid] || [];
  const degree = neighbors.length;

  if (degree >= 6) {
    return 20;
  } else if (degree >= 4) {
    return 12;
  } else if (degree >= 2) {
    return 6;
  }

  return 0;
}

/**
 * B4) Homeland proxy component (0..35)
 * Placeholder implementation:
 * - If settlement has tags or metadata indicating "homeland side" => +35 for that side, +10 for others
 * - Else default to +15 for all sides (neutral)
 *
 * This component MUST be designed to accept better data later without rewriting the system.
 */
function computeHomelandComponent(
  sid: string,
  side: PoliticalSideId,
  opts: ValuationOptions
): number {
  // Use optional hook if provided
  if (opts.getSettlementHomelandSide) {
    const homelandSide = opts.getSettlementHomelandSide(sid);
    if (homelandSide === side) {
      return 35;
    } else if (homelandSide !== null) {
      return 10;
    }
  }

  // Default: neutral (all sides get same value)
  return 15;
}
