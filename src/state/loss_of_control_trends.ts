/**
 * Phase 5D: Loss-of-control trend exposure (read-only, no new mechanics)
 * 
 * Computes trends and warnings from existing irreversible state.
 * All trends are derived from current vs previous turn values only.
 * No new mechanics, thresholds, or inference chains.
 */

import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard.js';
import type { GameState, LossOfControlTrendExposureState, TrendDirection, FactionId } from './game_state.js';
import { getSidCapacityModifiers } from '../sim/collapse/capacity_modifiers.js';
import { FrontEdge } from '../map/front_edges.js';

loadMistakes();
assertNoRepeat('phase5d must expose trends and warnings only from existing state and must not add new mechanics or thresholds');

/**
 * Compute trend direction from two numeric values.
 * Returns "up" if current > previous, "down" if current < previous, "flat" otherwise.
 */
function computeTrend(current: number, previous: number | undefined): TrendDirection {
  if (previous === undefined) return 'flat';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

/**
 * Update loss-of-control trend exposure.
 * 
 * This function:
 * - Computes trends by comparing current state to previous turn snapshot
 * - Sets warning flags directly from existing state (no inference)
 * - Stores current turn snapshot for next turn comparison
 * - Does NOT introduce new mechanics or thresholds
 */
export function updateLossOfControlTrends(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  exhaustionReport?: { per_faction: Array<{ faction_id: string; exhaustion_before: number; exhaustion_after: number; delta: number }> }
): void {
  const currentTurn = state.meta.turn;
  
  // Initialize or get existing trend exposure
  if (!state.loss_of_control_trends) {
    state.loss_of_control_trends = {
      by_faction: {},
      by_settlement: {},
      by_edge: {},
      last_updated_turn: currentTurn
    };
  }
  
  const trends = state.loss_of_control_trends;
  const previousSnapshot = trends.previous_turn_snapshot;
  
  // Initialize faction trends
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  for (const faction of factions) {
    if (!trends.by_faction[faction.id]) {
      trends.by_faction[faction.id] = {
        exhaustion_trend: 'flat',
        exhaustion_increasing: false,
        collapse_eligible: false
      };
    }
    
    const factionTrend = trends.by_faction[faction.id];
    const currentExhaustion = Number.isFinite(faction.profile?.exhaustion) ? faction.profile.exhaustion : 0;
    const previousExhaustion = previousSnapshot?.faction_exhaustion?.[faction.id];
    
    // Compute exhaustion trend
    factionTrend.exhaustion_trend = computeTrend(currentExhaustion, previousExhaustion);
    
    // Set exhaustion_increasing from exhaustion report delta (if available)
    if (exhaustionReport) {
      const factionReport = exhaustionReport.per_faction.find(f => f.faction_id === faction.id);
      factionTrend.exhaustion_increasing = (factionReport?.delta ?? 0) > 0;
    } else {
      // Fallback: compare current vs previous
      factionTrend.exhaustion_increasing = currentExhaustion > (previousExhaustion ?? 0);
    }
    
    // Set collapse_eligible directly from collapse_eligibility state
    const collapseEligibility = state.collapse_eligibility?.[faction.id];
    factionTrend.collapse_eligible = collapseEligibility ? (
      collapseEligibility.eligible_authority ||
      collapseEligibility.eligible_cohesion ||
      collapseEligibility.eligible_spatial
    ) : false;
  }
  
  // Initialize settlement trends
  // Collect all settlement SIDs from factions' AoR
  const settlementSids = new Set<string>();
  for (const faction of factions) {
    if (faction.areasOfResponsibility) {
      for (const sid of faction.areasOfResponsibility) {
        settlementSids.add(sid);
      }
    }
  }
  
  // Also include settlements with collapse damage
  if (state.collapse_damage?.by_entity) {
    for (const sid of Object.keys(state.collapse_damage.by_entity)) {
      settlementSids.add(sid);
    }
  }
  
  const sortedSids = [...settlementSids].sort();
  for (const sid of sortedSids) {
    if (!trends.by_settlement[sid]) {
      trends.by_settlement[sid] = {
        capacity_degraded: false,
        supply_fragile: false,
        will_not_recover: false,
        capacity_trend: 'flat'
      };
    }
    
    const settlementTrend = trends.by_settlement[sid];
    const currentModifiers = getSidCapacityModifiers(state, sid);
    const previousModifiers = previousSnapshot?.settlement_capacity?.[sid];
    
    // Set warnings directly from current state
    settlementTrend.capacity_degraded = (
      currentModifiers.authority_mult < 1 ||
      currentModifiers.cohesion_mult < 1 ||
      currentModifiers.supply_mult < 1 ||
      currentModifiers.pressure_cap_mult < 1
    );
    settlementTrend.supply_fragile = currentModifiers.supply_mult < 1;
    settlementTrend.will_not_recover = !!(state.collapse_damage?.by_entity?.[sid]);
    
    // Compute capacity trend from supply_mult (as proxy for overall degradation)
    // Note: "down" trend means supply_mult decreased (degradation worsening)
    // "up" trend means supply_mult increased (degradation improving)
    const currentSupplyMult = currentModifiers.supply_mult;
    const previousSupplyMult = previousModifiers?.supply_mult;
    settlementTrend.capacity_trend = computeTrend(currentSupplyMult, previousSupplyMult);
  }
  
  // Initialize edge trends
  const sortedEdges = [...derivedFrontEdges]
    .filter(e => e && typeof e.edge_id === 'string')
    .map(e => e.edge_id)
    .sort();
  
  for (const edgeId of sortedEdges) {
    if (!trends.by_edge[edgeId]) {
      trends.by_edge[edgeId] = {
        pressure_trend: 'flat',
        supply_fragile: false,
        command_friction_worsening: false
      };
    }
    
    const edgeTrend = trends.by_edge[edgeId];
    const pressure = state.front_pressure?.[edgeId];
    const segment = state.front_segments?.[edgeId];
    
    // Compute pressure trend
    const currentPressure = pressure?.value ?? 0;
    const previousPressure = previousSnapshot?.edge_pressure?.[edgeId];
    edgeTrend.pressure_trend = computeTrend(Math.abs(currentPressure), previousPressure !== undefined ? Math.abs(previousPressure) : undefined);
    
    // Set supply_fragile from edge capacity multipliers
    const edgeParts = edgeId.split('__');
    if (edgeParts.length === 2) {
      const sidA = edgeParts[0];
      const sidB = edgeParts[1];
      const modA = getSidCapacityModifiers(state, sidA);
      const modB = getSidCapacityModifiers(state, sidB);
      const minSupplyMult = Math.min(modA.supply_mult, modB.supply_mult);
      edgeTrend.supply_fragile = minSupplyMult < 1;
    }
    
    // Set command_friction_worsening from front_segments friction
    if (segment) {
      const currentFriction = Number.isInteger(segment.friction) ? segment.friction : 0;
      const previousFriction = previousSnapshot?.edge_friction?.[edgeId];
      edgeTrend.command_friction_worsening = currentFriction > (previousFriction ?? 0);
    }
  }
  
  // Store current turn snapshot for next turn comparison
  const currentSnapshot = {
    turn: currentTurn,
    faction_exhaustion: {} as Record<FactionId, number>,
    settlement_capacity: {} as Record<string, { supply_mult: number; pressure_cap_mult: number }>,
    edge_pressure: {} as Record<string, number>,
    edge_friction: {} as Record<string, number>
  };
  
  // Snapshot faction exhaustion
  for (const faction of factions) {
    currentSnapshot.faction_exhaustion[faction.id] = Number.isFinite(faction.profile?.exhaustion) ? faction.profile.exhaustion : 0;
  }
  
  // Snapshot settlement capacity
  for (const sid of sortedSids) {
    const modifiers = getSidCapacityModifiers(state, sid);
    currentSnapshot.settlement_capacity[sid] = {
      supply_mult: modifiers.supply_mult,
      pressure_cap_mult: modifiers.pressure_cap_mult
    };
  }
  
  // Snapshot edge pressure and friction
  for (const edgeId of sortedEdges) {
    const pressure = state.front_pressure?.[edgeId];
    const segment = state.front_segments?.[edgeId];
    if (pressure) {
      currentSnapshot.edge_pressure[edgeId] = pressure.value ?? 0;
    }
    if (segment) {
      currentSnapshot.edge_friction[edgeId] = Number.isInteger(segment.friction) ? segment.friction : 0;
    }
  }
  
  trends.previous_turn_snapshot = currentSnapshot;
  trends.last_updated_turn = currentTurn;
}
