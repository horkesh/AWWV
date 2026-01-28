import { FrontEdge, getSettlementSide } from '../map/front_edges.js';
import { AdjacencyMap } from '../map/adjacency_map.js';
import { GameState, PostureLevel } from './game_state.js';
import { computeSupplyReachability } from './supply_reachability.js';
import type { EffectivePostureState } from './front_posture_commitment.js';
import { getEdgeCapacityMultiplier } from '../sim/collapse/capacity_modifiers.js';

function postureMultiplier(posture: PostureLevel): number {
  switch (posture) {
    case 'hold':
      return 0;
    case 'probe':
      return 1;
    case 'push':
      return 2;
    default:
      return 0;
  }
}

function postureIntent(
  state: GameState,
  effectivePosture: Record<string, EffectivePostureState> | undefined,
  factionId: string,
  edge_id: string
): number {
  // Use effective posture if available (Phase 9), otherwise fall back to base posture
  const effective = effectivePosture?.[factionId]?.assignments?.[edge_id];
  if (effective) {
    const weight = effective.effective_weight;
    if (weight === 0) return 0;
    const posture = effective.posture;
    if (posture !== 'hold' && posture !== 'probe' && posture !== 'push') return 0;
    return weight * postureMultiplier(posture);
  }

  // Fallback to base posture (for backward compatibility or when commitment not computed)
  const assignment = state.front_posture?.[factionId]?.assignments?.[edge_id];
  if (!assignment) return 0;
  const weight = Number.isInteger(assignment.weight) ? assignment.weight : 0;
  if (weight === 0) return 0;
  const posture = assignment.posture;
  if (posture !== 'hold' && posture !== 'probe' && posture !== 'push') return 0;
  return weight * postureMultiplier(posture);
}

function clampDelta(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Deterministically accumulate persistent front pressure for active front edges.
 *
 * Scaffolding-only: updates numbers but does not apply any effects.
 * - Only active derived front edges are updated.
 * - Inactive segments are not updated (no decay in this task).
 */
export interface PressureSupplyModifierStats {
  edges_considered: number;
  edges_with_any_unsupplied_side: number;
}

export interface FrontPressureStepReport extends PressureSupplyModifierStats {
  pressure_deltas: Record<string, number>;
  local_supply: Record<string, { side_a_supplied: boolean; side_b_supplied: boolean }>;
}

export function accumulateFrontPressure(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  adjacencyMap: AdjacencyMap,
  effectivePosture?: Record<string, EffectivePostureState>
): FrontPressureStepReport {
  if (!state.front_pressure || typeof state.front_pressure !== 'object') state.front_pressure = {};

  const turn = state.meta.turn;
  const edgesSorted = [...derivedFrontEdges]
    .filter((e) => e && typeof e.edge_id === 'string')
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));

  // Compute supply reachability once per turn and build reachable sets by faction.
  const supply = computeSupplyReachability(state, adjacencyMap);
  const reachableByFaction = new Map<string, Set<string>>();
  for (const f of supply.factions) {
    reachableByFaction.set(f.faction_id, new Set(f.reachable_controlled));
  }

  let edges_considered = 0;
  let edges_with_any_unsupplied_side = 0;
  const pressure_deltas: Record<string, number> = {};
  const local_supply: Record<string, { side_a_supplied: boolean; side_b_supplied: boolean }> = {};

  for (const edge of edgesSorted) {
    const edge_id = edge.edge_id;
    const seg = (state.front_segments as any)?.[edge_id];
    const isActive = seg && typeof seg === 'object' && (seg as any).active === true;
    if (!isActive) continue;
    edges_considered += 1;

    const side_a = edge.side_a;
    const side_b = edge.side_b;
    if (typeof side_a !== 'string' || typeof side_b !== 'string') continue;

    const intent_a = postureIntent(state, effectivePosture, side_a, edge_id);
    const intent_b = postureIntent(state, effectivePosture, side_b, edge_id);

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

    if (!local_supply_a || !local_supply_b) edges_with_any_unsupplied_side += 1;
    local_supply[edge_id] = { side_a_supplied: local_supply_a, side_b_supplied: local_supply_b };

    const numerator_a = local_supply_a ? 2 : 1;
    const denom_a = 2;
    const numerator_b = local_supply_b ? 2 : 1;
    const denom_b = 2;

    // Phase 3D consumption (deterministic, no new mechanics):
    // - supply_mult: multiplicatively reduces the existing supply effectiveness term
    // - pressure_cap_mult: multiplicatively reduces the existing pressure generation/cap scalar
    //   NOTE: This is the SOLE application point for pressure_cap_mult in the front pressure pipeline.
    //   Do not apply any additional pressure cap multipliers later in this function.
    // Conservative edge attribution: min(endpoint multipliers).
    const edgeSupplyMult = getEdgeCapacityMultiplier(state, a, b, 'supply_mult');
    const edgePressureCapMult = getEdgeCapacityMultiplier(state, a, b, 'pressure_cap_mult');

    // Integer math (deterministic):
    // 1) Apply existing supply effectiveness (including Phase 3D supply_mult) to convert intent -> supplied intent.
    // 2) Apply Phase 3D pressure_cap_mult exactly once to the resulting pressure generation term, then clamp.
    const intent_a_supplied = Math.floor((intent_a * numerator_a * edgeSupplyMult) / denom_a);
    const intent_b_supplied = Math.floor((intent_b * numerator_b * edgeSupplyMult) / denom_b);

    const delta_generated = Math.floor((intent_a_supplied - intent_b_supplied) * edgePressureCapMult);
    const delta = clampDelta(delta_generated, -10, 10);
    pressure_deltas[edge_id] = delta;

    const existing = (state.front_pressure as any)[edge_id];
    if (!existing || typeof existing !== 'object') {
      (state.front_pressure as any)[edge_id] = {
        edge_id,
        value: 0,
        max_abs: 0,
        last_updated_turn: turn
      };
    }

    const rec = (state.front_pressure as any)[edge_id];
    const prevValue = Number.isInteger(rec.value) ? rec.value : 0;
    const nextValue = prevValue + delta;
    rec.value = nextValue;
    const prevMaxAbs = Number.isInteger(rec.max_abs) ? rec.max_abs : 0;
    rec.max_abs = Math.max(prevMaxAbs, Math.abs(nextValue));
    rec.last_updated_turn = turn;
  }

  return { edges_considered, edges_with_any_unsupplied_side, pressure_deltas, local_supply };
}

