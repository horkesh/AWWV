import type { GameState, FactionId } from './game_state.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import type { ExhaustionStats } from './exhaustion.js';
import type { FormationFatigueStepReport } from './formation_fatigue.js';
import type { MilitiaFatigueStepReport } from './militia_fatigue.js';
import { computeFrontBreaches } from './front_breaches.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { computeSupplyReachability } from './supply_reachability.js';
import { buildAdjacencyMap } from '../map/adjacency_map.js';
import type { EdgeRecord } from '../map/settlements.js';

// Constants
const PRESSURE_THRESHOLD = 10;
const PRESSURE_THRESHOLD_ACCEPT = 10;
const ENFORCEABILITY_AVG_FRICTION_THRESHOLD = 2;
const ENFORCEABILITY_MAX_STREAK_THRESHOLD = 4;

export type OfferKind = 'ceasefire' | 'local_freeze' | 'corridor_opening';
export type OfferScope = { kind: 'global' } | { kind: 'region'; region_id: string } | { kind: 'edges'; edge_ids: string[] };

export interface Offer {
  id: string; // deterministic id: "OFF_<turn>_<kind>_<scope_hash>"
  turn: number;
  kind: OfferKind;
  scope: OfferScope;
  rationale: {
    pressure_trigger: number;
    exhaustion_snapshot: Record<FactionId, number>;
    instability_snapshot: { breaches_total: number };
    supply_snapshot: { unsupplied_formations: number; unsupplied_militia_pools: number };
  };
  terms: {
    duration_turns: number | 'indefinite';
    freeze_edges: string[]; // sorted edge_ids
  };
}

export interface EnforcementPackage {
  schema: 1;
  offer_id: string;
  turn: number;
  freeze_edges: string[]; // sorted
  duration_turns: number | 'indefinite';
}

export interface OfferGenerationReport {
  offer: Offer | null;
  candidates: Array<{
    kind: OfferKind;
    score: number;
    scope_hash: string;
  }>;
  scoring_inputs: {
    max_pressure: number;
    breaches_total: number;
    total_unsupplied_formations: number;
    total_unsupplied_militia_pools: number;
  };
}

export interface AcceptanceReport {
  accepted: boolean;
  reasons: string[]; // sorted, deterministic
  enforcement_package: EnforcementPackage | null;
}

/**
 * Generate deterministic scope hash for offer id.
 */
function generateScopeHash(scope: OfferScope): string {
  if (scope.kind === 'global') {
    return 'GLOBAL';
  } else if (scope.kind === 'region') {
    return scope.region_id.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16);
  } else {
    // edges: sort and hash deterministically
    const sorted = [...scope.edge_ids].sort();
    const combined = sorted.join('_');
    // Simple hash: take first 16 chars of combined string
    return combined.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16);
  }
}

/**
 * Generate deterministic offer id.
 */
function generateOfferId(turn: number, kind: OfferKind, scope: OfferScope): string {
  const scopeHash = generateScopeHash(scope);
  return `OFF_${turn}_${kind}_${scopeHash}`;
}

/**
 * Compute enforceability metrics from front segments.
 */
function computeEnforceabilityMetrics(state: GameState, activeEdgeIds: string[]): {
  avg_friction: number;
  max_active_streak: number;
  active_edges_count: number;
} {
  let totalFriction = 0;
  let maxStreak = 0;
  let activeCount = 0;

  for (const edgeId of activeEdgeIds) {
    const seg = (state.front_segments as any)?.[edgeId];
    if (seg && typeof seg === 'object' && seg.active === true) {
      activeCount += 1;
      const friction = Number.isInteger(seg.friction) ? seg.friction : 0;
      totalFriction += friction;
      const streak = Number.isInteger(seg.max_active_streak) ? seg.max_active_streak : 0;
      if (streak > maxStreak) maxStreak = streak;
    }
  }

  const avgFriction = activeCount > 0 ? totalFriction / activeCount : 0;

  return {
    avg_friction: Math.floor(avgFriction * 100) / 100, // round to 2 decimals for determinism
    max_active_streak: maxStreak,
    active_edges_count: activeCount
  };
}

/**
 * Generate candidate offers deterministically.
 */
function generateCandidateOffers(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  frontRegions: FrontRegionsFile,
  exhaustionReport: ExhaustionStats | undefined,
  formationFatigueReport: FormationFatigueStepReport | undefined,
  militiaFatigueReport: MilitiaFatigueStepReport | undefined,
  breaches: Array<{ side_a: string; side_b: string }>,
  activeEdgeIds: string[]
): Offer[] {
  const candidates: Offer[] = [];
  const currentTurn = state.meta.turn;

  // Get active edge IDs sorted
  const sortedActiveEdges = [...activeEdgeIds].sort();

  // Candidate 1: Global ceasefire
  const globalCeasefire: Offer = {
    id: generateOfferId(currentTurn, 'ceasefire', { kind: 'global' }),
    turn: currentTurn,
    kind: 'ceasefire',
    scope: { kind: 'global' },
    rationale: {
      pressure_trigger: PRESSURE_THRESHOLD,
      exhaustion_snapshot: {},
      instability_snapshot: { breaches_total: breaches.length },
      supply_snapshot: {
        unsupplied_formations: formationFatigueReport?.by_faction.reduce((sum, f) => sum + f.formations_unsupplied, 0) ?? 0,
        unsupplied_militia_pools: militiaFatigueReport?.by_faction.reduce((sum, f) => sum + f.pools_unsupplied, 0) ?? 0
      }
    },
    terms: {
      duration_turns: 'indefinite',
      freeze_edges: sortedActiveEdges
    }
  };
  // Populate exhaustion snapshot
  if (exhaustionReport) {
    for (const f of exhaustionReport.per_faction) {
      globalCeasefire.rationale.exhaustion_snapshot[f.faction_id] = f.exhaustion_after;
    }
  }
  candidates.push(globalCeasefire);

  // Candidate 2: Local freeze (region with highest combined pressure)
  if (frontRegions.regions.length > 0) {
    // Find region with highest active_edge_count (proxy for pressure concentration)
    const bestRegion = frontRegions.regions[0]; // Already sorted by active_edge_count desc
    const localFreeze: Offer = {
      id: generateOfferId(currentTurn, 'local_freeze', { kind: 'region', region_id: bestRegion.region_id }),
      turn: currentTurn,
      kind: 'local_freeze',
      scope: { kind: 'region', region_id: bestRegion.region_id },
      rationale: {
        pressure_trigger: PRESSURE_THRESHOLD,
        exhaustion_snapshot: {},
        instability_snapshot: { breaches_total: breaches.length },
        supply_snapshot: {
          unsupplied_formations: formationFatigueReport?.by_faction.reduce((sum, f) => sum + f.formations_unsupplied, 0) ?? 0,
          unsupplied_militia_pools: militiaFatigueReport?.by_faction.reduce((sum, f) => sum + f.pools_unsupplied, 0) ?? 0
        }
      },
      terms: {
        duration_turns: 6,
        freeze_edges: [...bestRegion.edge_ids].sort()
      }
    };
    if (exhaustionReport) {
      for (const f of exhaustionReport.per_faction) {
        localFreeze.rationale.exhaustion_snapshot[f.faction_id] = f.exhaustion_after;
      }
    }
    candidates.push(localFreeze);
  }

  // Candidate 3: Corridor opening (region with highest unsupplied formations concentration)
  if (formationFatigueReport && frontRegions.regions.length > 0) {
    // Find region with most unsupplied formations (simplified: use first region as proxy)
    const corridorRegion = frontRegions.regions[0];
    const corridorOpening: Offer = {
      id: generateOfferId(currentTurn, 'corridor_opening', { kind: 'region', region_id: corridorRegion.region_id }),
      turn: currentTurn,
      kind: 'corridor_opening',
      scope: { kind: 'region', region_id: corridorRegion.region_id },
      rationale: {
        pressure_trigger: PRESSURE_THRESHOLD,
        exhaustion_snapshot: {},
        instability_snapshot: { breaches_total: breaches.length },
        supply_snapshot: {
          unsupplied_formations: formationFatigueReport.by_faction.reduce((sum, f) => sum + f.formations_unsupplied, 0),
          unsupplied_militia_pools: militiaFatigueReport?.by_faction.reduce((sum, f) => sum + f.pools_unsupplied, 0) ?? 0
        }
      },
      terms: {
        duration_turns: 4,
        freeze_edges: [...corridorRegion.edge_ids].sort()
      }
    };
    if (exhaustionReport) {
      for (const f of exhaustionReport.per_faction) {
        corridorOpening.rationale.exhaustion_snapshot[f.faction_id] = f.exhaustion_after;
      }
    }
    candidates.push(corridorOpening);
  }

  return candidates;
}

/**
 * Score candidate offers deterministically.
 */
function scoreOffer(
  offer: Offer,
  maxPressure: number,
  breachesTotal: number,
  totalUnsuppliedFormations: number,
  totalUnsuppliedMilitiaPools: number
): number {
  let score = 0;
  if (maxPressure >= 20) score += 5;
  score += Math.min(breachesTotal, 5);
  score += Math.floor(totalUnsuppliedFormations / 10);
  score += Math.floor(totalUnsuppliedMilitiaPools / 20);
  return score;
}

/**
 * Generate negotiation offers (max 1 per turn).
 */
export function generateNegotiationOffers(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  settlementEdges: EdgeRecord[],
  exhaustionReport: ExhaustionStats | undefined,
  formationFatigueReport: FormationFatigueStepReport | undefined,
  militiaFatigueReport: MilitiaFatigueStepReport | undefined
): OfferGenerationReport {
  const negotiationStatus = state.negotiation_status;
  const ceasefireActive = negotiationStatus?.ceasefire_active ?? false;

  // Check if we should generate offers
  if (ceasefireActive) {
    return {
      offer: null,
      candidates: [],
      scoring_inputs: {
        max_pressure: 0,
        breaches_total: 0,
        total_unsupplied_formations: 0,
        total_unsupplied_militia_pools: 0
      }
    };
  }

  // Check pressure threshold
  let maxPressure = 0;
  for (const faction of state.factions) {
    const pressure = faction.negotiation?.pressure ?? 0;
    if (pressure > maxPressure) maxPressure = pressure;
  }

  if (maxPressure < PRESSURE_THRESHOLD) {
    return {
      offer: null,
      candidates: [],
      scoring_inputs: {
        max_pressure: maxPressure,
        breaches_total: 0,
        total_unsupplied_formations: 0,
        total_unsupplied_militia_pools: 0
      }
    };
  }

  // Compute active edges
  const activeEdgeIds: string[] = [];
  for (const edge of derivedFrontEdges) {
    const seg = (state.front_segments as any)?.[edge.edge_id];
    if (seg && typeof seg === 'object' && seg.active === true) {
      activeEdgeIds.push(edge.edge_id);
    }
  }

  // Compute breaches
  const breaches = computeFrontBreaches(state, derivedFrontEdges);

  // Compute front regions
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);

  // Generate candidates
  const candidates = generateCandidateOffers(
    state,
    derivedFrontEdges,
    frontRegions,
    exhaustionReport,
    formationFatigueReport,
    militiaFatigueReport,
    breaches,
    activeEdgeIds
  );

  // Score candidates
  const totalUnsuppliedFormations = formationFatigueReport?.by_faction.reduce((sum, f) => sum + f.formations_unsupplied, 0) ?? 0;
  const totalUnsuppliedMilitiaPools = militiaFatigueReport?.by_faction.reduce((sum, f) => sum + f.pools_unsupplied, 0) ?? 0;

  const scoredCandidates = candidates.map((c) => ({
    offer: c,
    score: scoreOffer(c, maxPressure, breaches.length, totalUnsuppliedFormations, totalUnsuppliedMilitiaPools),
    scopeHash: generateScopeHash(c.scope)
  }));

  // Sort by score desc, then kind order, then scope_hash asc
  scoredCandidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // Kind order: ceasefire > local_freeze > corridor_opening
    const kindOrder: Record<OfferKind, number> = { ceasefire: 0, local_freeze: 1, corridor_opening: 2 };
    const kindA = kindOrder[a.offer.kind];
    const kindB = kindOrder[b.offer.kind];
    if (kindA !== kindB) return kindA - kindB;
    return a.scopeHash.localeCompare(b.scopeHash);
  });

  const selectedOffer = scoredCandidates.length > 0 ? scoredCandidates[0].offer : null;

  return {
    offer: selectedOffer,
    candidates: scoredCandidates.map((c) => ({
      kind: c.offer.kind,
      score: c.score,
      scope_hash: c.scopeHash
    })),
    scoring_inputs: {
      max_pressure: maxPressure,
      breaches_total: breaches.length,
      total_unsupplied_formations: totalUnsuppliedFormations,
      total_unsupplied_militia_pools: totalUnsuppliedMilitiaPools
    }
  };
}

/**
 * Check if an offer can be accepted (deterministic gating).
 */
export function checkOfferAcceptance(
  state: GameState,
  offer: Offer,
  derivedFrontEdges: FrontEdge[],
  settlementEdges: EdgeRecord[],
  exhaustionReport: ExhaustionStats | undefined,
  formationFatigueReport: FormationFatigueStepReport | undefined
): AcceptanceReport {
  const reasons: string[] = [];
  const currentTurn = state.meta.turn;

  // Get active edges
  const activeEdgeIds: string[] = [];
  for (const edge of derivedFrontEdges) {
    const seg = (state.front_segments as any)?.[edge.edge_id];
    if (seg && typeof seg === 'object' && seg.active === true) {
      activeEdgeIds.push(edge.edge_id);
    }
  }

  // 1) Enforceability check
  const enforceability = computeEnforceabilityMetrics(state, activeEdgeIds);
  const enforceabilityPass =
    enforceability.avg_friction >= ENFORCEABILITY_AVG_FRICTION_THRESHOLD ||
    enforceability.max_active_streak >= ENFORCEABILITY_MAX_STREAK_THRESHOLD;
  if (!enforceabilityPass) {
    reasons.push(`enforceability_failed: avg_friction=${enforceability.avg_friction.toFixed(2)} < ${ENFORCEABILITY_AVG_FRICTION_THRESHOLD} and max_streak=${enforceability.max_active_streak} < ${ENFORCEABILITY_MAX_STREAK_THRESHOLD}`);
  }

  // 2) Symmetry check
  let pressuredFactionsCount = 0;
  for (const faction of state.factions) {
    const pressure = faction.negotiation?.pressure ?? 0;
    if (pressure >= PRESSURE_THRESHOLD_ACCEPT) {
      pressuredFactionsCount += 1;
    }
  }
  const symmetryPass = pressuredFactionsCount >= 2;
  if (!symmetryPass) {
    reasons.push(`symmetry_failed: only ${pressuredFactionsCount} faction(s) with pressure >= ${PRESSURE_THRESHOLD_ACCEPT}`);
  }

  // 3) Supply sanity check
  const adjacencyMap = buildAdjacencyMap(settlementEdges);
  const supplyReport = computeSupplyReachability(state, adjacencyMap);
  const topPressuredFactions = [...state.factions]
    .map((f) => ({ id: f.id, pressure: f.negotiation?.pressure ?? 0 }))
    .sort((a, b) => b.pressure - a.pressure)
    .slice(0, 2);

  let supplySanityPass = true;
  for (const { id } of topPressuredFactions) {
    const factionSupply = supplyReport.factions.find((f) => f.faction_id === id);
    if (!factionSupply || factionSupply.reachable_controlled.length === 0) {
      supplySanityPass = false;
      reasons.push(`supply_sanity_failed: faction ${id} has no reachable controlled settlements`);
      break;
    }
  }

  const accepted = enforceabilityPass && symmetryPass && supplySanityPass;

  let enforcementPackage: EnforcementPackage | null = null;
  if (accepted) {
    enforcementPackage = {
      schema: 1,
      offer_id: offer.id,
      turn: currentTurn,
      freeze_edges: [...offer.terms.freeze_edges].sort(),
      duration_turns: offer.terms.duration_turns
    };
  }

  // Sort reasons deterministically
  reasons.sort();

  return {
    accepted,
    reasons,
    enforcement_package: enforcementPackage
  };
}

/**
 * Apply enforcement package to state (mutates state).
 */
export function applyEnforcementPackage(state: GameState, enforcementPackage: EnforcementPackage): void {
  const currentTurn = state.meta.turn;

  // Initialize negotiation_status if needed
  if (!state.negotiation_status || typeof state.negotiation_status !== 'object') {
    state.negotiation_status = { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null };
  }

  // Initialize ceasefire if needed
  if (!state.ceasefire || typeof state.ceasefire !== 'object') {
    state.ceasefire = {};
  }

  // Set negotiation status
  state.negotiation_status.ceasefire_active = true;
  state.negotiation_status.ceasefire_since_turn = currentTurn;
  state.negotiation_status.last_offer_turn = currentTurn;
  // Store offer_id reference (for audit)
  (state.negotiation_status as any).last_enforcement_offer_id = enforcementPackage.offer_id;

  // Add freeze entries
  const untilTurn = enforcementPackage.duration_turns === 'indefinite' ? null : currentTurn + enforcementPackage.duration_turns;
  for (const edgeId of enforcementPackage.freeze_edges) {
    state.ceasefire[edgeId] = {
      since_turn: currentTurn,
      until_turn: untilTurn
    };
  }
}

/**
 * Expire ceasefire entries that have reached their until_turn (mutates state).
 */
export function expireCeasefireEntries(state: GameState): void {
  const currentTurn = state.meta.turn;
  const ceasefire = state.ceasefire;
  if (!ceasefire || typeof ceasefire !== 'object') return;

  const edgeIds = Object.keys(ceasefire).sort();
  for (const edgeId of edgeIds) {
    const entry = ceasefire[edgeId];
    if (!entry || typeof entry !== 'object') {
      delete ceasefire[edgeId];
      continue;
    }
    if (entry.until_turn !== null && Number.isInteger(entry.until_turn) && entry.until_turn <= currentTurn) {
      delete ceasefire[edgeId];
    }
  }

  // If no freeze entries remain, deactivate ceasefire
  if (Object.keys(ceasefire).length === 0 && state.negotiation_status) {
    state.negotiation_status.ceasefire_active = false;
  }
}
