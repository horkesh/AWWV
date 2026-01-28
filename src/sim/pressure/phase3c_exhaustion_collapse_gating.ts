/**
 * Phase 3C: Exhaustion → Collapse Gating
 * 
 * Computes collapse eligibility only (domain gating), not collapse resolution.
 * Eligibility is driven by exhaustion + state coherence gates + suppression/immunity rules.
 * Eligibility is persistent (requires sustained conditions) and deterministic.
 * 
 * Feature-gated: ENABLE_PHASE3C_EXHAUSTION_COLLAPSE_GATING (default: false).
 */

import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import type { GameState, FactionId, CollapseEligibilityState, Tier1EntityEligibilityState } from '../../state/game_state.js';
import { getEnablePhase3B } from './phase3b_pressure_exhaustion.js';
import { computePressureExposureByEntity, type EntityId } from './pressure_exposure.js';
import type { FrontEdge } from '../../map/front_edges.js';

loadMistakes();
assertNoRepeat('phase3c must implement eligibility gating only, not collapse, and must enforce persistence deterministically without false unlocks');
assertNoRepeat('phase3c tier1 must localize eligibility without inventing new mechanics; use existing pressure exposure as proxy and keep determinism');

// Feature flag (OFF by default)
let _enablePhase3COverride: boolean | null = null;

export function getEnablePhase3C(): boolean {
  return _enablePhase3COverride !== null ? _enablePhase3COverride : false;
}

export function setEnablePhase3C(enable: boolean): void {
  _enablePhase3COverride = enable;
}

export function resetEnablePhase3C(): void {
  _enablePhase3COverride = null;
}

// Legacy const export for backward compatibility (uses getter)
export const ENABLE_PHASE3C_EXHAUSTION_COLLAPSE_GATING = false; // Default, but use getEnablePhase3C() for runtime value

// Phase 3C Tier-0 constants (conservative placeholders - SPEC VALUE REQUIRED)
// TODO: Verify these thresholds against spec text
const EXHAUSTION_THRESHOLD_AUTHORITY = 50; // SPEC VALUE REQUIRED
const EXHAUSTION_THRESHOLD_COHESION = 50; // SPEC VALUE REQUIRED
const EXHAUSTION_THRESHOLD_SPATIAL = 50; // SPEC VALUE REQUIRED
const PERSISTENCE_REQUIRED_TURNS = 3; // SPEC VALUE REQUIRED: N consecutive turns above threshold

// Coherence gate thresholds (conservative placeholders)
const AUTHORITY_DEGRADATION_THRESHOLD = 30; // SPEC VALUE REQUIRED: authority below this indicates degradation
const COHESION_DEGRADATION_THRESHOLD = 30; // SPEC VALUE REQUIRED: formation readiness/cohesion below this
const SPATIAL_DEGRADATION_THRESHOLD = 0.5; // SPEC VALUE REQUIRED: supply connectivity ratio below this

// Phase 3C Tier-1 constants (conservative placeholders - SPEC VALUE REQUIRED)
const TIER1_AUTH_THRESHOLD = 20; // SPEC VALUE REQUIRED: local strain threshold for authority domain
const TIER1_COH_THRESHOLD = 20; // SPEC VALUE REQUIRED: local strain threshold for cohesion domain
const TIER1_SPA_THRESHOLD = 20; // SPEC VALUE REQUIRED: local strain threshold for spatial domain
const TIER1_PERSIST_TURNS = 3; // SPEC VALUE REQUIRED: N consecutive turns above threshold
const STRAIN_FRACTION = 0.1; // SPEC VALUE REQUIRED: fraction of exposure that converts to strain per turn
const STRAIN_MAX = 100; // SPEC VALUE REQUIRED: maximum local strain value (clamp)

export type CollapseDomain = 'authority' | 'cohesion' | 'spatial';

export interface Phase3CEligibilityResult {
  applied: boolean;
  reason_if_not_applied: string;
  stats: {
    // Tier-0 stats (faction-level)
    entities_evaluated: number;
    eligible_authority: number;
    eligible_cohesion: number;
    eligible_spatial: number;
    newly_eligible_authority: number;
    newly_eligible_cohesion: number;
    newly_eligible_spatial: number;
    suppressed_count: number;
    immune_count: number;
    // Tier-1 stats (entity-level)
    tier1?: {
      entities_evaluated: number;
      eligible_authority: number;
      eligible_cohesion: number;
      eligible_spatial: number;
      newly_eligible_authority: number;
      newly_eligible_cohesion: number;
      newly_eligible_spatial: number;
      suppressed_count: number;
      immune_count: number;
      top10_exposure_entities?: Array<{ entity_id: EntityId; exposure: number }>;
      max_exposure?: number;
      max_persistence_authority?: number;
      max_persistence_cohesion?: number;
      max_persistence_spatial?: number;
    };
  };
  eligibility?: Record<FactionId, CollapseEligibilityState>;
  tier1_eligibility?: Record<EntityId, Tier1EntityEligibilityState>;
}

/**
 * Get or initialize collapse eligibility state for a faction.
 */
function getOrInitEligibilityState(
  state: GameState,
  factionId: FactionId
): CollapseEligibilityState {
  if (!state.collapse_eligibility) {
    state.collapse_eligibility = {};
  }
  
  const existing = state.collapse_eligibility[factionId];
  if (existing) {
    return existing;
  }
  
  // Initialize new state
  const newState: CollapseEligibilityState = {
    eligible_authority: false,
    eligible_cohesion: false,
    eligible_spatial: false,
    persistence_authority: 0,
    persistence_cohesion: 0,
    persistence_spatial: 0,
    suppressed: false,
    immune: false,
    last_updated_turn: state.meta.turn
  };
  
  state.collapse_eligibility[factionId] = newState;
  return newState;
}

/**
 * Check if authority degradation exists (coherence gate).
 */
function checkAuthorityDegradation(state: GameState, factionId: FactionId): boolean {
  const faction = state.factions.find(f => f.id === factionId);
  if (!faction) return false;
  
  const authority = Number.isFinite(faction.profile?.authority) ? faction.profile.authority : 50;
  return authority < AUTHORITY_DEGRADATION_THRESHOLD;
}

/**
 * Check if cohesion degradation exists (coherence gate).
 * Simplified: check if formations have high fatigue or low readiness.
 */
function checkCohesionDegradation(state: GameState, factionId: FactionId): boolean {
  // Check formation fatigue/readiness
  const formations = Object.values(state.formations ?? {})
    .filter(f => f.faction === factionId && f.status === 'active');
  
  if (formations.length === 0) return false; // No formations = no cohesion to degrade
  
  // Check if any formation has high fatigue or low readiness
  for (const formation of formations) {
    const fatigue = formation.ops?.fatigue ?? 0;
    // Simplified: high fatigue indicates degradation
    if (fatigue > COHESION_DEGRADATION_THRESHOLD) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if spatial degradation exists (coherence gate).
 * Simplified: check supply connectivity ratio.
 */
function checkSpatialDegradation(state: GameState, factionId: FactionId): boolean {
  const faction = state.factions.find(f => f.id === factionId);
  if (!faction) return false;
  
  const controlledSids = new Set(faction.areasOfResponsibility ?? []);
  if (controlledSids.size === 0) return false;
  
  const supplySources = new Set(faction.supply_sources ?? []);
  if (supplySources.size === 0) {
    // No supply sources = spatial degradation
    return true;
  }
  
  // Simplified: if less than threshold of controlled settlements have supply, consider degraded
  // This is a placeholder - actual implementation would use supply reachability
  const suppliedRatio = supplySources.size / Math.max(1, controlledSids.size);
  return suppliedRatio < SPATIAL_DEGRADATION_THRESHOLD;
}

/**
 * Check if faction is suppressed (temporary suppression rules).
 */
function checkSuppression(state: GameState, factionId: FactionId): boolean {
  // Placeholder: no suppression logic implemented yet
  // Suppression would pause persistence counters but not erase exhaustion
  return false;
}

/**
 * Check if faction is immune (immunity conditions).
 */
function checkImmunity(state: GameState, factionId: FactionId): boolean {
  // Placeholder: no immunity logic implemented yet
  // Immunity would prevent eligibility even if conditions are met
  return false;
}

/**
 * Get or initialize Tier-1 eligibility state for an entity.
 */
function getOrInitTier1EligibilityState(
  state: GameState,
  entityId: EntityId
): Tier1EntityEligibilityState {
  if (!state.collapse_eligibility_tier1) {
    state.collapse_eligibility_tier1 = {};
  }
  
  const existing = state.collapse_eligibility_tier1[entityId];
  if (existing) {
    return existing;
  }
  
  // Initialize new state
  const newState: Tier1EntityEligibilityState = {
    domains: {
      authority: false,
      cohesion: false,
      spatial: false
    },
    persistence: {
      authority: 0,
      cohesion: 0,
      spatial: 0
    },
    suppressed: false,
    immune: false
  };
  
  state.collapse_eligibility_tier1[entityId] = newState;
  return newState;
}

/**
 * Get or initialize local strain state.
 */
function getOrInitLocalStrain(state: GameState): void {
  if (!state.local_strain) {
    state.local_strain = { by_entity: {} };
  }
}

/**
 * Update local strain for an entity based on pressure exposure.
 * Monotonic accumulator: strain = clamp(strain + exposure * STRAIN_FRACTION, 0, STRAIN_MAX)
 */
function updateLocalStrain(state: GameState, entityId: EntityId, exposure: number): number {
  getOrInitLocalStrain(state);
  
  const current = state.local_strain!.by_entity[entityId] ?? 0;
  const increment = exposure * STRAIN_FRACTION;
  const newStrain = Math.min(Math.max(0, current + increment), STRAIN_MAX);
  
  state.local_strain!.by_entity[entityId] = newStrain;
  return newStrain;
}

/**
 * Check if entity has local degradation (coherence gate for Tier-1).
 * Simplified: check if entity is in a degraded faction context.
 */
function checkTier1Degradation(state: GameState, entityId: EntityId, domain: CollapseDomain, factionId: FactionId): boolean {
  // For Tier-1, we use the faction-level degradation check as a proxy
  // This is conservative and avoids inventing new mechanics
  if (domain === 'authority') {
    return checkAuthorityDegradation(state, factionId);
  } else if (domain === 'cohesion') {
    return checkCohesionDegradation(state, factionId);
  } else if (domain === 'spatial') {
    return checkSpatialDegradation(state, factionId);
  }
  return false;
}

/**
 * Check if entity is suppressed (Tier-1).
 */
function checkTier1Suppression(state: GameState, entityId: EntityId): boolean {
  // Placeholder: no suppression logic implemented yet
  return false;
}

/**
 * Check if entity is immune (Tier-1).
 */
function checkTier1Immunity(state: GameState, entityId: EntityId): boolean {
  // Placeholder: no immunity logic implemented yet
  return false;
}

/**
 * Apply Phase 3C exhaustion → collapse eligibility gating.
 * 
 * Tier-0 (faction-level):
 * - Check exhaustion thresholds per domain
 * - Increment persistence counters if above threshold
 * - Reset persistence counters if below threshold
 * - Check coherence gates (degradation in supporting systems)
 * - Check suppression/immunity rules
 * - Set eligibility flags only if all conditions met
 * 
 * Tier-1 (entity-level):
 * - Compute pressure exposure per entity (settlement SID)
 * - Convert exposure to local strain (monotonic accumulator)
 * - Apply domain thresholds + coherence gates per entity
 * - Tier-0 gating: entity eligibility requires faction eligibility in that domain
 * - Update persistence counters per entity per domain
 * 
 * @param state Game state (mutated: collapse_eligibility and collapse_eligibility_tier1 state updated)
 * @param derivedFrontEdges Optional front edges for pressure exposure computation
 * @returns Result object with applied flag, reason if not applied, and stats
 */
export function applyPhase3CExhaustionCollapseGating(
  state: GameState,
  derivedFrontEdges?: FrontEdge[]
): Phase3CEligibilityResult {
  // Feature gate check
  if (!getEnablePhase3C()) {
    return {
      applied: false,
      reason_if_not_applied: 'feature_flag_disabled',
      stats: {
        entities_evaluated: 0,
        eligible_authority: 0,
        eligible_cohesion: 0,
        eligible_spatial: 0,
        newly_eligible_authority: 0,
        newly_eligible_cohesion: 0,
        newly_eligible_spatial: 0,
        suppressed_count: 0,
        immune_count: 0
      }
    };
  }

  // Phase 3B prerequisite: if Phase 3B is disabled, Phase 3C should not apply
  if (!getEnablePhase3B()) {
    return {
      applied: false,
      reason_if_not_applied: 'phase3b_exhaustion_disabled',
      stats: {
        entities_evaluated: 0,
        eligible_authority: 0,
        eligible_cohesion: 0,
        eligible_spatial: 0,
        newly_eligible_authority: 0,
        newly_eligible_cohesion: 0,
        newly_eligible_spatial: 0,
        suppressed_count: 0,
        immune_count: 0
      }
    };
  }

  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  if (factions.length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_factions',
      stats: {
        entities_evaluated: 0,
        eligible_authority: 0,
        eligible_cohesion: 0,
        eligible_spatial: 0,
        newly_eligible_authority: 0,
        newly_eligible_cohesion: 0,
        newly_eligible_spatial: 0,
        suppressed_count: 0,
        immune_count: 0
      }
    };
  }

  const currentTurn = state.meta.turn;
  const eligibility: Record<FactionId, CollapseEligibilityState> = {};
  
  let eligibleAuthority = 0;
  let eligibleCohesion = 0;
  let eligibleSpatial = 0;
  let newlyEligibleAuthority = 0;
  let newlyEligibleCohesion = 0;
  let newlyEligibleSpatial = 0;
  let suppressedCount = 0;
  let immuneCount = 0;

  for (const faction of factions) {
    const factionId = faction.id;
    const eligibilityState = getOrInitEligibilityState(state, factionId);
    
    // Get current exhaustion
    const exhaustion = Number.isFinite(faction.profile?.exhaustion) ? faction.profile.exhaustion : 0;
    
    // Check suppression/immunity first
    const suppressed = checkSuppression(state, factionId);
    const immune = checkImmunity(state, factionId);
    
    if (suppressed) suppressedCount++;
    if (immune) immuneCount++;
    
    // Update suppression/immunity flags
    eligibilityState.suppressed = suppressed;
    eligibilityState.immune = immune;
    
    // If immune, skip eligibility evaluation (but still update state)
    if (immune) {
      eligibility[factionId] = eligibilityState;
      continue;
    }
    
    // Evaluate each domain independently
    // Authority domain
    {
      const wasEligible = eligibilityState.eligible_authority;
      if (exhaustion > EXHAUSTION_THRESHOLD_AUTHORITY) {
        if (!suppressed) {
          eligibilityState.persistence_authority = eligibilityState.persistence_authority + 1;
        }
        if (eligibilityState.persistence_authority >= PERSISTENCE_REQUIRED_TURNS) {
          const degradationExists = checkAuthorityDegradation(state, factionId);
          if (degradationExists) {
            eligibilityState.eligible_authority = true;
            if (!wasEligible) newlyEligibleAuthority++;
          } else {
            eligibilityState.eligible_authority = false;
          }
        } else {
          eligibilityState.eligible_authority = false;
        }
      } else {
        eligibilityState.persistence_authority = 0;
        eligibilityState.eligible_authority = false;
      }
    }
    
    // Cohesion domain
    {
      const wasEligible = eligibilityState.eligible_cohesion;
      if (exhaustion > EXHAUSTION_THRESHOLD_COHESION) {
        if (!suppressed) {
          eligibilityState.persistence_cohesion = eligibilityState.persistence_cohesion + 1;
        }
        if (eligibilityState.persistence_cohesion >= PERSISTENCE_REQUIRED_TURNS) {
          const degradationExists = checkCohesionDegradation(state, factionId);
          if (degradationExists) {
            eligibilityState.eligible_cohesion = true;
            if (!wasEligible) newlyEligibleCohesion++;
          } else {
            eligibilityState.eligible_cohesion = false;
          }
        } else {
          eligibilityState.eligible_cohesion = false;
        }
      } else {
        eligibilityState.persistence_cohesion = 0;
        eligibilityState.eligible_cohesion = false;
      }
    }
    
    // Spatial domain
    {
      const wasEligible = eligibilityState.eligible_spatial;
      if (exhaustion > EXHAUSTION_THRESHOLD_SPATIAL) {
        if (!suppressed) {
          eligibilityState.persistence_spatial = eligibilityState.persistence_spatial + 1;
        }
        if (eligibilityState.persistence_spatial >= PERSISTENCE_REQUIRED_TURNS) {
          const degradationExists = checkSpatialDegradation(state, factionId);
          if (degradationExists) {
            eligibilityState.eligible_spatial = true;
            if (!wasEligible) newlyEligibleSpatial++;
          } else {
            eligibilityState.eligible_spatial = false;
          }
        } else {
          eligibilityState.eligible_spatial = false;
        }
      } else {
        eligibilityState.persistence_spatial = 0;
        eligibilityState.eligible_spatial = false;
      }
    }
    
    // Update counts
    if (eligibilityState.eligible_authority) eligibleAuthority++;
    if (eligibilityState.eligible_cohesion) eligibleCohesion++;
    if (eligibilityState.eligible_spatial) eligibleSpatial++;
    
    eligibilityState.last_updated_turn = currentTurn;
    eligibility[factionId] = eligibilityState;
  }

  // Tier-1: Per-entity localized eligibility
  const tier1Eligibility: Record<EntityId, Tier1EntityEligibilityState> = {};
  let tier1EntitiesEvaluated = 0;
  let tier1EligibleAuthority = 0;
  let tier1EligibleCohesion = 0;
  let tier1EligibleSpatial = 0;
  let tier1NewlyEligibleAuthority = 0;
  let tier1NewlyEligibleCohesion = 0;
  let tier1NewlyEligibleSpatial = 0;
  let tier1SuppressedCount = 0;
  let tier1ImmuneCount = 0;
  let maxExposure = 0;
  let maxPersistenceAuthority = 0;
  let maxPersistenceCohesion = 0;
  let maxPersistenceSpatial = 0;
  const exposureEntities: Array<{ entity_id: EntityId; exposure: number }> = [];
  
  // Compute pressure exposure per entity
  const exposureByEntity = computePressureExposureByEntity(state, derivedFrontEdges);
  
  // Build map of entity -> faction (for Tier-0 gating)
  const entityToFaction = new Map<EntityId, FactionId>();
  for (const faction of factions) {
    for (const sid of faction.areasOfResponsibility ?? []) {
      entityToFaction.set(sid, faction.id);
    }
  }
  
  // Evaluate Tier-1 eligibility per entity
  const entityIds = [...exposureByEntity.keys()].sort((a, b) => a.localeCompare(b));
  for (const entityId of entityIds) {
    const exposure = exposureByEntity.get(entityId) ?? 0;
    if (exposure > maxExposure) maxExposure = exposure;
    
    // Update local strain (monotonic accumulator)
    const strain = updateLocalStrain(state, entityId, exposure);
    
    // Get faction for this entity (for Tier-0 gating)
    const factionId = entityToFaction.get(entityId);
    if (!factionId) continue; // Skip entities not controlled by any faction
    
    // Get Tier-0 eligibility for this faction
    const tier0State = eligibility[factionId];
    if (!tier0State) continue; // Skip if Tier-0 not evaluated
    
    tier1EntitiesEvaluated++;
    
    // Get or initialize Tier-1 state
    const tier1State = getOrInitTier1EligibilityState(state, entityId);
    
    // Check suppression/immunity
    const suppressed = checkTier1Suppression(state, entityId);
    const immune = checkTier1Immunity(state, entityId);
    
    if (suppressed) tier1SuppressedCount++;
    if (immune) tier1ImmuneCount++;
    
    tier1State.suppressed = suppressed;
    tier1State.immune = immune;
    
    if (immune) {
      tier1Eligibility[entityId] = tier1State;
      continue;
    }
    
    // Evaluate each domain independently
    // Authority domain
    {
      const wasEligible = tier1State.domains.authority;
      const threshold = TIER1_AUTH_THRESHOLD;
      
      // Tier-0 precondition: faction must be eligible in this domain
      const tier0Allows = tier0State.eligible_authority;
      
      if (strain > threshold && tier0Allows) {
        if (!suppressed) {
          tier1State.persistence.authority = tier1State.persistence.authority + 1;
        }
        if (tier1State.persistence.authority > maxPersistenceAuthority) {
          maxPersistenceAuthority = tier1State.persistence.authority;
        }
        if (tier1State.persistence.authority >= TIER1_PERSIST_TURNS) {
          const degradationExists = checkTier1Degradation(state, entityId, 'authority', factionId);
          if (degradationExists) {
            tier1State.domains.authority = true;
            if (!wasEligible) tier1NewlyEligibleAuthority++;
          } else {
            tier1State.domains.authority = false;
          }
        } else {
          tier1State.domains.authority = false;
        }
      } else {
        tier1State.persistence.authority = 0;
        tier1State.domains.authority = false;
      }
    }
    
    // Cohesion domain
    {
      const wasEligible = tier1State.domains.cohesion;
      const threshold = TIER1_COH_THRESHOLD;
      
      const tier0Allows = tier0State.eligible_cohesion;
      
      if (strain > threshold && tier0Allows) {
        if (!suppressed) {
          tier1State.persistence.cohesion = tier1State.persistence.cohesion + 1;
        }
        if (tier1State.persistence.cohesion > maxPersistenceCohesion) {
          maxPersistenceCohesion = tier1State.persistence.cohesion;
        }
        if (tier1State.persistence.cohesion >= TIER1_PERSIST_TURNS) {
          const degradationExists = checkTier1Degradation(state, entityId, 'cohesion', factionId);
          if (degradationExists) {
            tier1State.domains.cohesion = true;
            if (!wasEligible) tier1NewlyEligibleCohesion++;
          } else {
            tier1State.domains.cohesion = false;
          }
        } else {
          tier1State.domains.cohesion = false;
        }
      } else {
        tier1State.persistence.cohesion = 0;
        tier1State.domains.cohesion = false;
      }
    }
    
    // Spatial domain
    {
      const wasEligible = tier1State.domains.spatial;
      const threshold = TIER1_SPA_THRESHOLD;
      
      const tier0Allows = tier0State.eligible_spatial;
      
      if (strain > threshold && tier0Allows) {
        if (!suppressed) {
          tier1State.persistence.spatial = tier1State.persistence.spatial + 1;
        }
        if (tier1State.persistence.spatial > maxPersistenceSpatial) {
          maxPersistenceSpatial = tier1State.persistence.spatial;
        }
        if (tier1State.persistence.spatial >= TIER1_PERSIST_TURNS) {
          const degradationExists = checkTier1Degradation(state, entityId, 'spatial', factionId);
          if (degradationExists) {
            tier1State.domains.spatial = true;
            if (!wasEligible) tier1NewlyEligibleSpatial++;
          } else {
            tier1State.domains.spatial = false;
          }
        } else {
          tier1State.domains.spatial = false;
        }
      } else {
        tier1State.persistence.spatial = 0;
        tier1State.domains.spatial = false;
      }
    }
    
    // Update counts
    if (tier1State.domains.authority) tier1EligibleAuthority++;
    if (tier1State.domains.cohesion) tier1EligibleCohesion++;
    if (tier1State.domains.spatial) tier1EligibleSpatial++;
    
    // Store exposure for top10 list
    if (exposure > 0) {
      exposureEntities.push({ entity_id: entityId, exposure });
    }
    
    tier1Eligibility[entityId] = tier1State;
  }
  
  // Sort exposure entities by exposure desc, then entity_id asc (deterministic)
  exposureEntities.sort((a, b) => {
    if (b.exposure !== a.exposure) return b.exposure - a.exposure;
    return a.entity_id.localeCompare(b.entity_id);
  });
  const top10Exposure = exposureEntities.slice(0, 10);

  return {
    applied: true,
    reason_if_not_applied: '',
    stats: {
      // Tier-0 stats
      entities_evaluated: factions.length,
      eligible_authority: eligibleAuthority,
      eligible_cohesion: eligibleCohesion,
      eligible_spatial: eligibleSpatial,
      newly_eligible_authority: newlyEligibleAuthority,
      newly_eligible_cohesion: newlyEligibleCohesion,
      newly_eligible_spatial: newlyEligibleSpatial,
      suppressed_count: suppressedCount,
      immune_count: immuneCount,
      // Tier-1 stats
      tier1: {
        entities_evaluated: tier1EntitiesEvaluated,
        eligible_authority: tier1EligibleAuthority,
        eligible_cohesion: tier1EligibleCohesion,
        eligible_spatial: tier1EligibleSpatial,
        newly_eligible_authority: tier1NewlyEligibleAuthority,
        newly_eligible_cohesion: tier1NewlyEligibleCohesion,
        newly_eligible_spatial: tier1NewlyEligibleSpatial,
        suppressed_count: tier1SuppressedCount,
        immune_count: tier1ImmuneCount,
        top10_exposure_entities: top10Exposure,
        max_exposure: maxExposure,
        max_persistence_authority: maxPersistenceAuthority,
        max_persistence_cohesion: maxPersistenceCohesion,
        max_persistence_spatial: maxPersistenceSpatial
      }
    },
    eligibility,
    tier1_eligibility: tier1Eligibility
  };
}
