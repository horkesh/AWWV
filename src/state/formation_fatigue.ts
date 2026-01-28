import type { GameState, FormationId, FactionId } from './game_state.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import { computeSupplyReachability } from './supply_reachability.js';
import { getSettlementSide } from '../map/front_edges.js';
import { buildAdjacencyMap, type AdjacencyMap } from '../map/adjacency_map.js';
import type { EdgeRecord } from '../map/settlements.js';
import { getEdgeCapacityMultiplier } from '../sim/collapse/capacity_modifiers.js';

/**
 * Per-formation fatigue update record.
 */
export interface FormationFatigueRecord {
  formation_id: FormationId;
  faction_id: FactionId;
  supplied: boolean;
  supplied_this_turn: boolean; // Phase 12A: computed from current supply, not last_supplied_turn equality
  fatigue_before: number;
  fatigue_after: number;
  commit_points_used: number; // computed commit points after supply/fatigue penalty
}

/**
 * Per-faction formation fatigue totals.
 */
export interface FormationFatigueFactionTotals {
  faction_id: FactionId;
  formations_active: number;
  formations_supplied: number;
  formations_unsupplied: number;
  total_fatigue: number;
  total_commit_points: number; // total commit points after penalties
}

/**
 * Formation fatigue step report.
 */
export interface FormationFatigueStepReport {
  by_formation: FormationFatigueRecord[];
  by_faction: FormationFatigueFactionTotals[];
}

/**
 * Determine if a formation is supplied based on its assignment.
 *
 * Rules:
 * - If unassigned: treated as supplied (admin/roster)
 * - If assigned to edge: formation is supplied if that edge is locally supplied for the faction
 * - If assigned to region: formation is supplied if at least one edge in that region is locally supplied for the faction
 */
export function isFormationSupplied(
  state: GameState,
  formation: any,
  localSupplyByEdge: Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }>,
  frontRegions: FrontRegionsFile,
  derivedFrontEdges: FrontEdge[]
): boolean {
  const assignment = formation?.assignment;
  if (!assignment || typeof assignment !== 'object') {
    // Unassigned: treat as supplied
    return true;
  }

  const factionId = formation?.faction;
  if (typeof factionId !== 'string') return true; // defensive: treat as supplied if invalid

  if (assignment.kind === 'edge' && typeof assignment.edge_id === 'string') {
    const edgeId = assignment.edge_id;
    const supply = localSupplyByEdge.get(edgeId);
    if (!supply) return true; // defensive: treat as supplied if edge not found

    // Find which side this faction is on this edge
    const edge = derivedFrontEdges.find((e) => e.edge_id === edgeId);
    if (!edge) return true; // defensive

    if (edge.side_a === factionId) {
      return supply.side_a_supplied;
    } else if (edge.side_b === factionId) {
      return supply.side_b_supplied;
    }
    return true; // defensive: faction not on this edge
  }

  if (assignment.kind === 'region' && typeof assignment.region_id === 'string') {
    const regionId = assignment.region_id;
    const region = frontRegions.regions.find((r) => r.region_id === regionId);
    if (!region) return true; // defensive: treat as supplied if region not found

    // Check if at least one edge in the region is locally supplied for this faction
    for (const edgeId of region.edge_ids) {
      const supply = localSupplyByEdge.get(edgeId);
      if (!supply) continue;

      const edge = derivedFrontEdges.find((e) => e.edge_id === edgeId);
      if (!edge) continue;

      if (edge.side_a === factionId && supply.side_a_supplied) {
        return true;
      }
      if (edge.side_b === factionId && supply.side_b_supplied) {
        return true;
      }
    }
    return false; // no edges in region are supplied for this faction
  }

  return true; // defensive: unknown assignment kind
}

/**
 * Compute local supply status for all active front edges.
 * This mirrors the logic from accumulateFrontPressure.
 */
export function computeLocalSupplyForEdges(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  adjacencyMap: AdjacencyMap
): Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }> {
  const localSupply = new Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }>();

  // Compute supply reachability once per turn
  const supply = computeSupplyReachability(state, adjacencyMap);
  const reachableByFaction = new Map<string, Set<string>>();
  for (const f of supply.factions) {
    reachableByFaction.set(f.faction_id, new Set(f.reachable_controlled));
  }

  const edgesSorted = [...derivedFrontEdges]
    .filter((e) => e && typeof e.edge_id === 'string')
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));

  for (const edge of edgesSorted) {
    const edge_id = edge.edge_id;
    const seg = (state.front_segments as any)?.[edge_id];
    const isActive = seg && typeof seg === 'object' && (seg as any).active === true;
    if (!isActive) continue;

    const side_a = edge.side_a;
    const side_b = edge.side_b;
    if (typeof side_a !== 'string' || typeof side_b !== 'string') continue;

    const a = edge.a;
    const b = edge.b;
    const controllerA = getSettlementSide(state, a);
    const controllerB = getSettlementSide(state, b);

    const reachableA = reachableByFaction.get(side_a) ?? new Set<string>();
    const reachableB = reachableByFaction.get(side_b) ?? new Set<string>();

    const local_supply_a =
      (controllerA === side_a && reachableA.has(a)) || (controllerB === side_a && reachableA.has(b));
    const local_supply_b =
      (controllerA === side_b && reachableB.has(a)) || (controllerB === side_b && reachableB.has(b));

    localSupply.set(edge_id, { side_a_supplied: local_supply_a, side_b_supplied: local_supply_b });
  }

  return localSupply;
}

/**
 * Compute commit points for a formation after applying supply and fatigue penalties.
 *
 * Rules:
 * - Base: 1000 milli-points per active formation
 * - If unsupplied: commit_points = floor(1000 * 0.5) = 500
 * - Additionally: effective_commit_points = max(0, commit_points - fatigue*50)
 */
function computeCommitPoints(supplied: boolean, fatigue: number): number {
  let commitPoints = 1000; // base commit points
  if (!supplied) {
    commitPoints = Math.floor(1000 * 0.5); // 500 when unsupplied
  }
  const penalty = fatigue * 50;
  return Math.max(0, commitPoints - penalty);
}

function parseEdgeId(edgeId: string): [string, string] | null {
  const idx = edgeId.indexOf('__');
  if (idx <= 0 || idx === edgeId.length - 2) return null;
  const a = edgeId.slice(0, idx);
  const b = edgeId.slice(idx + 2);
  return a && b ? [a, b] : null;
}

/**
 * Phase 3D supply_mult consumption (deterministic, conservative):
 * - Edge assignment: use edge multiplier min(supply_mult endpoints)
 * - Region assignment: use min over region edges (conservative)
 * - Unassigned: 1.0 (no logistics constraint)
 */
function getFormationSupplyMultiplier(
  state: GameState,
  formation: any,
  frontRegions: FrontRegionsFile,
  derivedFrontEdges: FrontEdge[]
): number {
  const assignment = formation?.assignment;
  if (!assignment || typeof assignment !== 'object') return 1;

  if (assignment.kind === 'edge' && typeof assignment.edge_id === 'string') {
    const pair = parseEdgeId(assignment.edge_id);
    if (!pair) return 1;
    const [a, b] = pair;
    return getEdgeCapacityMultiplier(state, a, b, 'supply_mult');
  }

  if (assignment.kind === 'region' && typeof assignment.region_id === 'string') {
    const region = frontRegions.regions.find((r) => r.region_id === assignment.region_id);
    if (!region) return 1;
    let minMult = 1;
    for (const edgeId of region.edge_ids) {
      const pair = parseEdgeId(edgeId);
      if (!pair) continue;
      const [a, b] = pair;
      const m = getEdgeCapacityMultiplier(state, a, b, 'supply_mult');
      if (m < minMult) minMult = m;
    }
    return minMult;
  }

  return 1;
}

/**
 * Update formation fatigue based on supply status.
 *
 * Rules:
 * - For each ACTIVE formation:
 *   - Determine supplied boolean
 *   - If supplied: last_supplied_turn = current turn, fatigue increases by 0
 *   - If unsupplied AND assigned: fatigue += 1 per turn, last_supplied_turn unchanged
 *   - If unassigned: treated as supplied (no fatigue increase)
 */
export function updateFormationFatigue(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  frontRegions: FrontRegionsFile,
  settlementEdges: EdgeRecord[]
): FormationFatigueStepReport {
  const currentTurn = state.meta.turn;
  const formations = (state as any).formations as Record<string, any> | undefined;
  if (!formations || typeof formations !== 'object') {
    return { by_formation: [], by_faction: [] };
  }

  // Compute local supply for all active edges
  const adjacencyMap = buildAdjacencyMap(settlementEdges);
  const localSupplyByEdge = computeLocalSupplyForEdges(state, derivedFrontEdges, adjacencyMap);

  const records: FormationFatigueRecord[] = [];
  const factionTotals = new Map<FactionId, { active: number; supplied: number; unsupplied: number; total_fatigue: number; total_commit_points: number }>();

  const formationIds = Object.keys(formations).sort(); // deterministic ordering
  for (const formationId of formationIds) {
    const formation = formations[formationId];
    if (!formation || typeof formation !== 'object') continue;
    if (formation.status !== 'active') continue; // only process active formations

    const factionId = formation.faction;
    if (typeof factionId !== 'string') continue;

    // Ensure ops field exists
    if (!formation.ops || typeof formation.ops !== 'object') {
      formation.ops = { fatigue: 0, last_supplied_turn: null };
    }
    if (!Number.isInteger(formation.ops.fatigue) || formation.ops.fatigue < 0) {
      formation.ops.fatigue = 0;
    }

    const fatigueBefore = formation.ops.fatigue;
    const supplied_this_turn = isFormationSupplied(state, formation, localSupplyByEdge, frontRegions, derivedFrontEdges);

    // Update fatigue and last_supplied_turn
    if (supplied_this_turn) {
      formation.ops.last_supplied_turn = currentTurn;
      // fatigue increases by 0 (no change)
    } else {
      // Only increase fatigue if assigned (unassigned formations are treated as supplied)
      if (formation.assignment && typeof formation.assignment === 'object') {
        formation.ops.fatigue = fatigueBefore + 1;
      }
      // last_supplied_turn unchanged
    }

    const fatigueAfter = formation.ops.fatigue;
    const commitPointsBase = computeCommitPoints(supplied_this_turn, fatigueAfter);
    // Phase 3D consumption: multiply existing commit_points by supply_mult (<= 1).
    // This does not change the supply definition; it scales the existing commit capacity.
    const supplyMult = getFormationSupplyMultiplier(state, formation, frontRegions, derivedFrontEdges);
    const commitPoints = Math.floor(commitPointsBase * supplyMult);

    records.push({
      formation_id: formationId,
      faction_id: factionId,
      supplied: supplied_this_turn, // kept for backward compatibility
      supplied_this_turn: supplied_this_turn, // Phase 12A: explicit field
      fatigue_before: fatigueBefore,
      fatigue_after: fatigueAfter,
      commit_points_used: commitPoints
    });

    // Update faction totals
    const totals = factionTotals.get(factionId) ?? { active: 0, supplied: 0, unsupplied: 0, total_fatigue: 0, total_commit_points: 0 };
    totals.active += 1;
    if (supplied_this_turn) {
      totals.supplied += 1;
    } else {
      totals.unsupplied += 1;
    }
    totals.total_fatigue += fatigueAfter;
    totals.total_commit_points += commitPoints;
    factionTotals.set(factionId, totals);
  }

  // Build sorted faction totals array
  const byFaction: FormationFatigueFactionTotals[] = Array.from(factionTotals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([faction_id, totals]) => ({
      faction_id,
      formations_active: totals.active,
      formations_supplied: totals.supplied,
      formations_unsupplied: totals.unsupplied,
      total_fatigue: totals.total_fatigue,
      total_commit_points: totals.total_commit_points
    }));

  // Sort records deterministically
  records.sort((a, b) => {
    const fc = a.formation_id.localeCompare(b.formation_id);
    if (fc !== 0) return fc;
    return a.faction_id.localeCompare(b.faction_id);
  });

  return { by_formation: records, by_faction: byFaction };
}
