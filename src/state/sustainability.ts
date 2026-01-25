/**
 * Phase 22: Surrounded settlements, sustainability, and collapse dynamics
 *
 * Deterministic sustainability collapse system that models what happens
 * to municipalities that are surrounded, unsustainable, and politically hollowed out.
 */

import type { GameState, MunicipalityId, FactionId, SustainabilityState, DisplacementState } from './game_state.js';
import type { SettlementRecord } from '../map/settlements.js';
import { computeSupplyReachability } from './supply_reachability.js';
import { buildAdjacencyMap, type AdjacencyMap } from '../map/adjacency_map.js';
import type { EdgeRecord } from '../map/settlements.js';
import { computeFrontBreaches, type FrontBreach } from './front_breaches.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { getEffectiveSettlementSide } from './control_effective.js';

// Sustainability degradation constants
const BASE_DEGRADATION = 5; // per turn when surrounded
const UNSUPPLIED_ACCELERATION_THRESHOLD = 2; // unsupplied_turns >= this triggers acceleration
const UNSUPPLIED_ACCELERATION = 5; // additional degradation per turn
const BREACH_DEGRADATION = 3; // additional degradation per turn when breaches persist
const DISPLACEMENT_DEGRADATION_THRESHOLD = 0.25; // displaced_out / original_population >= this triggers degradation
const DISPLACEMENT_DEGRADATION = 5; // additional degradation per turn
const AUTHORITY_DEGRADED_THRESHOLD = 50; // sustainability_score < this marks authority_degraded

// Negotiation pressure increment per collapsed municipality per turn
const COLLAPSE_PRESSURE_INCREMENT = 1;

/**
 * Sustainability update record per municipality.
 */
export interface SustainabilityRecord {
  mun_id: MunicipalityId;
  faction_id: FactionId | null;
  is_surrounded: boolean;
  unsupplied_turns: number;
  sustainability_score_before: number;
  sustainability_score_after: number;
  collapsed: boolean;
  authority_degraded: boolean;
  degradation_this_turn: number;
  degradation_reasons: string[];
}

/**
 * Sustainability step report.
 */
export interface SustainabilityStepReport {
  by_municipality: SustainabilityRecord[];
  negotiation_pressure_increment: number; // total increment from all collapsed municipalities
}

/**
 * Get or initialize sustainability state for a municipality.
 */
function getOrInitSustainabilityState(
  state: GameState,
  munId: MunicipalityId
): SustainabilityState {
  if (!state.sustainability_state) {
    state.sustainability_state = {};
  }

  const existing = state.sustainability_state[munId];
  if (existing) {
    return existing;
  }

  const newState: SustainabilityState = {
    mun_id: munId,
    is_surrounded: false,
    unsupplied_turns: 0,
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: state.meta.turn
  };

  state.sustainability_state[munId] = newState;
  return newState;
}

/**
 * Check if a municipality is supplied for a faction.
 */
function isMunicipalitySupplied(
  factionId: FactionId,
  munId: MunicipalityId,
  settlements: Map<string, SettlementRecord>,
  reachableSettlements: Set<string>
): boolean {
  // Find all settlements in this municipality
  const munSettlements: string[] = [];
  for (const [sid, settlement] of settlements.entries()) {
    if (settlement.mun_code === munId) {
      munSettlements.push(sid);
    }
  }

  // Sort deterministically
  munSettlements.sort();

  // Check if at least one settlement in the municipality is reachable
  for (const sid of munSettlements) {
    if (reachableSettlements.has(sid)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a municipality is surrounded (no adjacency path to friendly-controlled municipality with supply access).
 * 
 * Canonical definition:
 * A municipality M is NOT surrounded if and only if there exists at least one path in the adjacency graph
 * from M to another municipality N such that:
 * 1) N is controlled by the same faction as M
 * 2) N is supply-reachable (according to existing supply logic)
 * 
 * If no such path exists, M IS surrounded.
 * 
 * Clarifications:
 * - Paths through unsupplied friendly municipalities do NOT count
 * - Paths through hostile or contested municipalities do NOT count
 * - Control and supply are both required at the destination
 * - Intermediate nodes in the path must be friendly-controlled
 */
function isMunicipalitySurrounded(
  munId: MunicipalityId,
  factionId: FactionId,
  settlements: Map<string, SettlementRecord>,
  adjacencyMap: AdjacencyMap,
  state: GameState,
  reachableSettlements: Set<string>
): boolean {
  // Find all settlements in this municipality
  const munSettlements: string[] = [];
  for (const [sid, settlement] of settlements.entries()) {
    if (settlement.mun_code === munId) {
      munSettlements.push(sid);
    }
  }

  if (munSettlements.length === 0) return false;

  // BFS from any settlement in this municipality
  // Check if we can reach any settlement in a different friendly municipality with supply
  const visited = new Set<string>();
  const queue: string[] = [munSettlements[0]]; // Start from first settlement
  visited.add(munSettlements[0]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacencyMap[current] ?? [];

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;

      const neighborSide = getEffectiveSettlementSide(state, neighbor);
      if (neighborSide !== factionId) continue; // Must be friendly-controlled

      visited.add(neighbor);

      // Check if neighbor is in a different municipality
      const neighborSettlement = settlements.get(neighbor);
      if (neighborSettlement && neighborSettlement.mun_code !== munId) {
        // Check if this different municipality has supply access
        // (A municipality has supply if at least one settlement in it is supply-reachable)
        if (isMunicipalitySupplied(factionId, neighborSettlement.mun_code, settlements, reachableSettlements)) {
          // Found path to different friendly municipality with supply - not surrounded
          return false;
        }
        // If the destination municipality doesn't have supply, we can still traverse through it
        // (intermediate nodes don't need to be supply-reachable, but destination must be)
        // Continue to add it to queue so we can explore beyond it
      }

      queue.push(neighbor);
    }
  }

  // No path found to different friendly municipality with supply - surrounded
  return true;
}

/**
 * Count persistent breaches affecting a municipality.
 * A breach is "persistent" if it exists this turn (simplified: just count breaches).
 */
function countPersistentBreaches(
  munId: MunicipalityId,
  settlements: Map<string, SettlementRecord>,
  breaches: FrontBreach[],
  frontEdges: ReturnType<typeof computeFrontEdges>
): number {
  // Find all settlements in this municipality
  const munSettlements: string[] = [];
  for (const [sid, settlement] of settlements.entries()) {
    if (settlement.mun_code === munId) {
      munSettlements.push(sid);
    }
  }

  if (munSettlements.length === 0) return 0;

  const munSettlementSet = new Set(munSettlements);

  // Build edge_id to front edge map
  const edgeMap = new Map<string, typeof frontEdges[0]>();
  for (const edge of frontEdges) {
    edgeMap.set(edge.edge_id, edge);
  }

  // Count breaches where the edge involves a settlement in this municipality
  let count = 0;
  for (const breach of breaches) {
    const edge = edgeMap.get(breach.edge_id);
    if (!edge) continue;

    if (munSettlementSet.has(edge.a) || munSettlementSet.has(edge.b)) {
      count += 1;
    }
  }

  return count;
}

/**
 * Update sustainability state for all municipalities.
 */
export function updateSustainability(
  state: GameState,
  settlements: Map<string, SettlementRecord>,
  settlementEdges: EdgeRecord[]
): SustainabilityStepReport {
  const currentTurn = state.meta.turn;
  const militiaPools = (state as any).militia_pools as Record<string, any> | undefined;

  if (!militiaPools || typeof militiaPools !== 'object') {
    return { by_municipality: [], negotiation_pressure_increment: 0 };
  }

  // Compute derived state
  const adjacencyMap = buildAdjacencyMap(settlementEdges);
  const supplyReport = computeSupplyReachability(state, adjacencyMap);
  const frontEdges = computeFrontEdges(state, settlementEdges);
  const breaches = computeFrontBreaches(state, frontEdges);

  // Build reachable sets by faction
  const reachableByFaction = new Map<FactionId, Set<string>>();
  for (const f of supplyReport.factions) {
    reachableByFaction.set(f.faction_id, new Set(f.reachable_controlled));
  }

  const records: SustainabilityRecord[] = [];
  let totalNegotiationPressureIncrement = 0;

  // Process each municipality with a militia pool
  const munIds = Object.keys(militiaPools).sort(); // deterministic ordering
  for (const munId of munIds) {
    const pool = militiaPools[munId];
    if (!pool || typeof pool !== 'object') continue;

    const factionId = pool.faction;
    if (factionId === null || factionId === undefined) continue; // only process pools with faction
    if (typeof factionId !== 'string') continue;

    // Get or initialize sustainability state
    const sustState = getOrInitSustainabilityState(state, munId);

    // Check conditions
    const reachableSettlements = reachableByFaction.get(factionId) ?? new Set<string>();
    const supplied = isMunicipalitySupplied(factionId, munId, settlements, reachableSettlements);
    const surrounded = isMunicipalitySurrounded(munId, factionId, settlements, adjacencyMap, state, reachableSettlements);
    const breachCount = countPersistentBreaches(munId, settlements, breaches, frontEdges);

    // Update unsupplied_turns
    let unsuppliedTurns = sustState.unsupplied_turns;
    if (!supplied) {
      // If last_updated_turn was last turn, increment; otherwise reset to 1
      if (sustState.last_updated_turn === currentTurn - 1) {
        unsuppliedTurns += 1;
      } else {
        unsuppliedTurns = 1;
      }
    } else {
      // Reset if supplied
      unsuppliedTurns = 0;
    }

    // Update is_surrounded
    const isSurrounded = surrounded;

    // Calculate degradation
    let degradation = 0;
    const degradationReasons: string[] = [];

    if (isSurrounded) {
      // Base degradation when surrounded
      degradation += BASE_DEGRADATION;
      degradationReasons.push('surrounded');

      // Unsupplied acceleration
      if (unsuppliedTurns >= UNSUPPLIED_ACCELERATION_THRESHOLD) {
        degradation += UNSUPPLIED_ACCELERATION;
        degradationReasons.push(`unsupplied_${unsuppliedTurns}_turns`);
      }

      // Breach interaction
      if (breachCount > 0) {
        degradation += BREACH_DEGRADATION;
        degradationReasons.push(`breaches_${breachCount}`);
      }

      // Displacement interaction
      const dispState = state.displacement_state?.[munId] as DisplacementState | undefined;
      if (dispState && dispState.original_population > 0) {
        const displacementRatio = dispState.displaced_out / dispState.original_population;
        if (displacementRatio >= DISPLACEMENT_DEGRADATION_THRESHOLD) {
          degradation += DISPLACEMENT_DEGRADATION;
          degradationReasons.push(`displacement_${Math.floor(displacementRatio * 100)}%`);
        }
      }
    }

    // Apply degradation (sustainability_score never increases)
    const scoreBefore = sustState.sustainability_score;
    let scoreAfter = Math.max(0, scoreBefore - degradation);
    const collapsed = scoreAfter <= 0;
    if (collapsed) {
      scoreAfter = 0;
    }

    // Update state
    sustState.is_surrounded = isSurrounded;
    sustState.unsupplied_turns = unsuppliedTurns;
    sustState.sustainability_score = scoreAfter;
    sustState.collapsed = collapsed;
    sustState.last_updated_turn = currentTurn;

    // Authority degradation (scaffolding, no mechanics yet)
    const authorityDegraded = scoreAfter < AUTHORITY_DEGRADED_THRESHOLD;

    // Negotiation pressure increment (for collapsed municipalities)
    if (collapsed) {
      totalNegotiationPressureIncrement += COLLAPSE_PRESSURE_INCREMENT;
    }

    records.push({
      mun_id: munId,
      faction_id: factionId,
      is_surrounded: isSurrounded,
      unsupplied_turns: unsuppliedTurns,
      sustainability_score_before: scoreBefore,
      sustainability_score_after: scoreAfter,
      collapsed: collapsed,
      authority_degraded: authorityDegraded,
      degradation_this_turn: degradation,
      degradation_reasons: degradationReasons
    });
  }

  // Sort records deterministically
  records.sort((a, b) => a.mun_id.localeCompare(b.mun_id));

  return {
    by_municipality: records,
    negotiation_pressure_increment: totalNegotiationPressureIncrement
  };
}
