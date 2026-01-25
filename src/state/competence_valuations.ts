/**
 * Phase 15: Institutional competence valuation tables (acceptance scoring inputs only)
 *
 * Defines per-faction utility weights for each competence_id.
 * These are static tables used as inputs to treaty acceptance scoring.
 * They do NOT affect post-peace behavior or gameplay mechanics.
 *
 * Valuation philosophy:
 * - Core statehood competences (currency, international representation, border control)
 *   have high positive value to RBiH (central state aspirations).
 * - RS values autonomy-preserving competences (police, education, health) and devalues
 *   central ones (currency, international representation).
 * - HRHB values education, police, and cultural/social competences relatively higher.
 * - Some competences may be liabilities for all factions (negative values).
 * - Valuations are integers in range -10 to +10 (recommended small range).
 * - Zero is meaningful (neutral value).
 *
 * Determinism:
 * - Tables are fully explicit and statically defined.
 * - Stable ordering when iterating (sort by competence_id asc).
 */

import type { CompetenceId } from './competences.js';
import { ALL_COMPETENCES } from './competences.js';
import type { PoliticalSideId } from './identity.js';
import { POLITICAL_SIDES } from './identity.js';

/**
 * Per-competence valuation for a single faction.
 * Integer value: -10 to +10 (recommended range).
 * Positive = valuable to accept, negative = liability.
 */
export type CompetenceValuation = Record<CompetenceId, number>;

/**
 * Per-faction competence valuations.
 * Every competence_id must have an explicit valuation for every faction.
 */
export type FactionCompetenceValuations = Record<PoliticalSideId, CompetenceValuation>;

/**
 * Canonical competence valuation tables.
 * 
 * Every competence_id in ALL_COMPETENCES must have an explicit numeric valuation
 * for every faction in POLITICAL_SIDES.
 * 
 * No missing keys, no defaults, no fallbacks.
 */
export const COMPETENCE_VALUATIONS: FactionCompetenceValuations = {
  RBiH: {
    // Core statehood competences: high value to central state
    airspace_control: 8,
    armed_forces_command: 7,
    border_control: 9,
    currency_authority: 10,
    customs: 8,
    defence_policy: 7,
    education_policy: 6,
    health_policy: 5,
    indirect_taxation: 7,
    international_representation: 10,
    police_internal_security: 6
  },
  RS: {
    // Autonomy-preserving competences: higher value
    // Central state competences: lower value or negative
    airspace_control: 3,
    armed_forces_command: 5,
    border_control: 4,
    currency_authority: -2, // Central state competence, liability for RS
    customs: 2,
    defence_policy: 6,
    education_policy: 7,
    health_policy: 7,
    indirect_taxation: 3,
    international_representation: -3, // Central state competence, liability for RS
    police_internal_security: 8
  },
  HRHB: {
    // Education, police, and social competences: higher value
    // Central state competences: moderate value
    airspace_control: 4,
    armed_forces_command: 5,
    border_control: 5,
    currency_authority: 2,
    customs: 4,
    defence_policy: 5,
    education_policy: 8,
    health_policy: 7,
    indirect_taxation: 4,
    international_representation: 3,
    police_internal_security: 7
  }
};

/**
 * Get competence valuation for a faction.
 * Returns the integer valuation value for the given competence and faction.
 * 
 * @throws Error if competence_id or faction_id is invalid or missing
 */
export function getCompetenceValuation(
  competenceId: CompetenceId,
  factionId: PoliticalSideId
): number {
  const factionVals = COMPETENCE_VALUATIONS[factionId];
  if (!factionVals) {
    throw new Error(`Invalid faction_id: ${factionId}`);
  }
  const value = factionVals[competenceId];
  if (value === undefined) {
    throw new Error(`Missing valuation for competence ${competenceId} and faction ${factionId}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`Non-integer valuation for competence ${competenceId} and faction ${factionId}: ${value}`);
  }
  return value;
}

/**
 * Compute total competence utility for a faction from a list of competence allocations.
 * 
 * Sums valuations for all competences allocated to the given faction (as holder).
 * Used in acceptance scoring as an additive term.
 * 
 * @param allocations Array of { competence, holder } allocations
 * @param factionId Faction to compute utility for
 * @returns Total integer utility (sum of valuations)
 */
export function computeCompetenceUtility(
  allocations: Array<{ competence: string; holder: string }>,
  factionId: PoliticalSideId
): number {
  let total = 0;
  for (const alloc of allocations) {
    if (alloc.holder === factionId && alloc.competence) {
      // Validate competence_id is in catalog
      if (!ALL_COMPETENCES.includes(alloc.competence as CompetenceId)) {
        // Skip invalid competences (should be caught by validation elsewhere)
        continue;
      }
      const value = getCompetenceValuation(alloc.competence as CompetenceId, factionId);
      total += value;
    }
  }
  return total;
}
