/**
 * Phase 3D: Collapse Resolution
 * 
 * Applies irreversible degradation effects (negative-sum) based on Phase 3C Tier-1 eligibility.
 * Deterministic, localized outcomes driven by Tier-1 eligibility + persistence + local_strain.
 * 
 * Phase 3D does NOT:
 * - Create map geometry or rewire contact graph
 * - Create "victory states" or hard-code historical outcomes
 * - Change Phase 3A pressure conservation or Phase 3B exhaustion accrual
 * - Use randomness (all thresholds and ordering are deterministic)
 * 
 * Feature-gated: ENABLE_PHASE3D_COLLAPSE_RESOLUTION (default: false).
 */

import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import type { GameState } from '../../state/game_state.js';
import { getEnablePhase3C } from '../pressure/phase3c_exhaustion_collapse_gating.js';
import type { CollapseDomain } from '../pressure/phase3c_exhaustion_collapse_gating.js';
import type { EntityId } from '../pressure/pressure_exposure.js';

loadMistakes();
assertNoRepeat("phase3d must resolve collapse locally from tier1 eligibility with deterministic gradation, never global flips, and must not invent scripted outcomes");

// Feature flag (OFF by default)
let _enablePhase3DOverride: boolean | null = null;

export function getEnablePhase3D(): boolean {
  return _enablePhase3DOverride !== null ? _enablePhase3DOverride : false;
}

export function setEnablePhase3D(enable: boolean): void {
  _enablePhase3DOverride = enable;
}

export function resetEnablePhase3D(): void {
  _enablePhase3DOverride = null;
}

// Legacy const export for backward compatibility (uses getter)
export const ENABLE_PHASE3D_COLLAPSE_RESOLUTION = false; // Default, but use getEnablePhase3D() for runtime value

// Phase 3D severity computation constants (conservative defaults - SPEC VALUE REQUIRED)
const STRAIN_THRESHOLD = 20; // SPEC VALUE REQUIRED: minimum local_strain to consider severity
const STRAIN_MAX = 100; // SPEC VALUE REQUIRED: maximum local_strain value (from Phase 3C)
const SEVERITY_MIN = 0.25; // SPEC VALUE REQUIRED: minimum severity [0,1] to apply collapse damage

// Phase 3D impact constants (conservative defaults - SPEC VALUE REQUIRED)
// These control how much collapse damage affects capacity multipliers
const AUTHORITY_IMPACT = 0.5; // SPEC VALUE REQUIRED: authority_mult = 1 - AUTHORITY_IMPACT * damage.authority
const COHESION_IMPACT = 0.5;  // SPEC VALUE REQUIRED: cohesion_mult = 1 - COHESION_IMPACT * damage.cohesion
const SPATIAL_IMPACT = 0.5;   // SPEC VALUE REQUIRED: supply_mult = 1 - SPATIAL_IMPACT * damage.spatial
// pressure_cap_mult uses conservative combination of all three domains

export interface Phase3DCollapseResolutionResult {
  applied: boolean;
  reason_if_not_applied: string;
  stats: {
    entities_evaluated: number;
    collapses_applied_count: number;
    collapses_max_severity: number;
    damage_sum_by_domain: {
      authority: number;
      cohesion: number;
      spatial: number;
    };
  };
  applied_events?: Array<{
    sid: string;
    domain: CollapseDomain;
    severity: number;
    effects: {
      damage_before: number;
      damage_after: number;
      authority_mult: number;
      cohesion_mult: number;
      supply_mult: number;
      pressure_cap_mult: number;
    };
  }>;
}

/**
 * Get or initialize collapse damage state for an entity.
 */
function getOrInitCollapseDamage(
  state: GameState,
  entityId: EntityId
): { authority: number; cohesion: number; spatial: number } {
  if (!state.collapse_damage) {
    state.collapse_damage = { by_entity: {} };
  }
  
  const existing = state.collapse_damage.by_entity[entityId];
  if (existing) {
    return existing;
  }
  
  // Initialize new damage track (all zeros)
  const newDamage = {
    authority: 0,
    cohesion: 0,
    spatial: 0
  };
  
  state.collapse_damage.by_entity[entityId] = newDamage;
  return newDamage;
}

/**
 * Get or initialize capacity modifiers state for an entity.
 */
function getOrInitCapacityModifiers(
  state: GameState,
  entityId: EntityId
): { authority_mult: number; cohesion_mult: number; supply_mult: number; pressure_cap_mult: number } {
  if (!state.capacity_modifiers) {
    state.capacity_modifiers = { by_sid: {} };
  }
  
  const existing = state.capacity_modifiers.by_sid[entityId];
  if (existing) {
    return existing;
  }
  
  // Initialize new modifiers (all 1.0 = no reduction)
  const newModifiers = {
    authority_mult: 1.0,
    cohesion_mult: 1.0,
    supply_mult: 1.0,
    pressure_cap_mult: 1.0
  };
  
  state.capacity_modifiers.by_sid[entityId] = newModifiers;
  return newModifiers;
}

/**
 * Compute deterministic severity from local_strain and persistence.
 * Returns severity in [0,1] or 0 if below threshold.
 */
function computeSeverity(
  localStrain: number,
  persistence: number
): number {
  // Severity is based on how far above threshold the strain is
  if (localStrain < STRAIN_THRESHOLD) {
    return 0;
  }
  
  // Normalize: S_raw = (strain - threshold) / (max - threshold)
  const strainRange = STRAIN_MAX - STRAIN_THRESHOLD;
  if (strainRange <= 0) {
    return 0;
  }
  
  const sRaw = (localStrain - STRAIN_THRESHOLD) / strainRange;
  const s = Math.max(0, Math.min(1, sRaw)); // clamp to [0,1]
  
  // Apply minimum severity threshold
  if (s < SEVERITY_MIN) {
    return 0;
  }
  
  return s;
}

/**
 * Update capacity modifiers from collapse damage.
 * Modifiers are derived deterministically from damage tracks.
 */
function updateCapacityModifiers(
  state: GameState,
  entityId: EntityId,
  damage: { authority: number; cohesion: number; spatial: number }
): void {
  const modifiers = getOrInitCapacityModifiers(state, entityId);
  
  // Derive multipliers from damage (monotonic reduction)
  modifiers.authority_mult = Math.max(0, Math.min(1, 1 - AUTHORITY_IMPACT * damage.authority));
  modifiers.cohesion_mult = Math.max(0, Math.min(1, 1 - COHESION_IMPACT * damage.cohesion));
  modifiers.supply_mult = Math.max(0, Math.min(1, 1 - SPATIAL_IMPACT * damage.spatial));
  
  // Pressure cap multiplier uses conservative combination (minimum of all three)
  // This ensures that any domain collapse reduces pressure generation capacity
  modifiers.pressure_cap_mult = Math.min(
    modifiers.authority_mult,
    modifiers.cohesion_mult,
    modifiers.supply_mult
  );
}

/**
 * Recompute Phase 3D capacity modifiers from existing collapse_damage.
 * This is used by tooling/harnesses (e.g., test seeding) and is deterministic.
 *
 * NOTE: This does NOT change any Phase 3D formulas; it applies the same derivation
 * as the Phase 3D resolution step uses.
 */
export function recomputePhase3DCapacityModifiersFromDamage(state: GameState): void {
  const byEntity = state.collapse_damage?.by_entity;
  if (!byEntity || typeof byEntity !== 'object') return;
  const entityIds = Object.keys(byEntity).sort((a, b) => a.localeCompare(b));
  for (const entityId of entityIds) {
    const damage = byEntity[entityId];
    if (!damage || typeof damage !== 'object') continue;
    updateCapacityModifiers(state, entityId, {
      authority: Number.isFinite((damage as any).authority) ? (damage as any).authority : 0,
      cohesion: Number.isFinite((damage as any).cohesion) ? (damage as any).cohesion : 0,
      spatial: Number.isFinite((damage as any).spatial) ? (damage as any).spatial : 0
    });
  }
}

/**
 * Apply Phase 3D collapse resolution.
 * 
 * For each entity (settlement SID) with Tier-1 eligibility in a domain:
 * - Compute severity from local_strain and persistence
 * - Apply monotonic collapse damage (max of current and new severity)
 * - Update capacity modifiers derived from damage
 * 
 * @param state Game state (mutated: collapse_damage and capacity_modifiers updated)
 * @returns Result object with applied flag, reason if not applied, and stats
 */
export function applyPhase3DCollapseResolution(
  state: GameState
): Phase3DCollapseResolutionResult {
  // Feature gate check
  if (!getEnablePhase3D()) {
    return {
      applied: false,
      reason_if_not_applied: 'feature_flag_disabled',
      stats: {
        entities_evaluated: 0,
        collapses_applied_count: 0,
        collapses_max_severity: 0,
        damage_sum_by_domain: {
          authority: 0,
          cohesion: 0,
          spatial: 0
        }
      }
    };
  }

  // Phase 3C prerequisite: if Phase 3C is disabled, Phase 3D should not apply
  if (!getEnablePhase3C()) {
    return {
      applied: false,
      reason_if_not_applied: 'phase3c_eligibility_disabled',
      stats: {
        entities_evaluated: 0,
        collapses_applied_count: 0,
        collapses_max_severity: 0,
        damage_sum_by_domain: {
          authority: 0,
          cohesion: 0,
          spatial: 0
        }
      }
    };
  }

  // Check if Tier-1 eligibility state exists
  if (!state.collapse_eligibility_tier1 || Object.keys(state.collapse_eligibility_tier1).length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_tier1_eligibility_state',
      stats: {
        entities_evaluated: 0,
        collapses_applied_count: 0,
        collapses_max_severity: 0,
        damage_sum_by_domain: {
          authority: 0,
          cohesion: 0,
          spatial: 0
        }
      }
    };
  }

  // Check if local_strain state exists
  if (!state.local_strain || !state.local_strain.by_entity) {
    return {
      applied: false,
      reason_if_not_applied: 'no_local_strain_state',
      stats: {
        entities_evaluated: 0,
        collapses_applied_count: 0,
        collapses_max_severity: 0,
        damage_sum_by_domain: {
          authority: 0,
          cohesion: 0,
          spatial: 0
        }
      }
    };
  }

  const tier1Eligibility = state.collapse_eligibility_tier1;
  const localStrain = state.local_strain.by_entity;
  
  let entitiesEvaluated = 0;
  let collapsesAppliedCount = 0;
  let collapsesMaxSeverity = 0;
  const damageSumByDomain = {
    authority: 0,
    cohesion: 0,
    spatial: 0
  };
  const appliedEvents: Array<{
    sid: string;
    domain: CollapseDomain;
    severity: number;
    effects: {
      damage_before: number;
      damage_after: number;
      authority_mult: number;
      cohesion_mult: number;
      supply_mult: number;
      pressure_cap_mult: number;
    };
  }> = [];

  // Process all entities with Tier-1 eligibility
  const entityIds = Object.keys(tier1Eligibility).sort((a, b) => a.localeCompare(b));
  
  for (const entityId of entityIds) {
    const tier1State = tier1Eligibility[entityId];
    if (!tier1State) continue;
    
    const strain = localStrain[entityId] ?? 0;
    
    // Evaluate each domain independently
    const domains: CollapseDomain[] = ['authority', 'cohesion', 'spatial'];
    
    for (const domain of domains) {
      // Check if entity is eligible in this domain
      const isEligible = tier1State.domains[domain];
      if (!isEligible) continue;
      
      entitiesEvaluated++;
      
      // Get persistence for this domain
      const persistence = tier1State.persistence[domain];
      
      // Compute severity
      const severity = computeSeverity(strain, persistence);
      if (severity <= 0) continue; // Below threshold, skip
      
      // Get current damage
      const damage = getOrInitCollapseDamage(state, entityId);
      const damageBefore = damage[domain];
      
      // Apply monotonic damage (max of current and new severity)
      const damageAfter = Math.max(damageBefore, severity);
      damage[domain] = damageAfter;
      
      // Update capacity modifiers
      updateCapacityModifiers(state, entityId, damage);
      
      // Get updated modifiers for event reporting
      const modifiers = getOrInitCapacityModifiers(state, entityId);
      
      // Record event
      appliedEvents.push({
        sid: entityId,
        domain,
        severity,
        effects: {
          damage_before: damageBefore,
          damage_after: damageAfter,
          authority_mult: modifiers.authority_mult,
          cohesion_mult: modifiers.cohesion_mult,
          supply_mult: modifiers.supply_mult,
          pressure_cap_mult: modifiers.pressure_cap_mult
        }
      });
      
      // Update stats
      collapsesAppliedCount++;
      if (severity > collapsesMaxSeverity) {
        collapsesMaxSeverity = severity;
      }
      damageSumByDomain[domain] += damageAfter;
    }
  }

  // Sort events by entity ID, then domain (deterministic ordering)
  appliedEvents.sort((a, b) => {
    if (a.sid !== b.sid) {
      return a.sid.localeCompare(b.sid);
    }
    const domainOrder: Record<CollapseDomain, number> = { authority: 0, cohesion: 1, spatial: 2 };
    return domainOrder[a.domain] - domainOrder[b.domain];
  });

  return {
    applied: true,
    reason_if_not_applied: '',
    stats: {
      entities_evaluated: entitiesEvaluated,
      collapses_applied_count: collapsesAppliedCount,
      collapses_max_severity: collapsesMaxSeverity,
      damage_sum_by_domain: damageSumByDomain
    },
    applied_events: appliedEvents.length > 0 ? appliedEvents : undefined
  };
}
