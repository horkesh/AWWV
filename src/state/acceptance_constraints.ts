/**
 * Phase 13B.0: Deterministic structural constraints for treaty acceptance
 * Phase 13B.1: Brčko completeness (require_brcko_resolution) for peace-triggering treaties
 * Phase 14: Defence bundle added (defence_policy + armed_forces_command)
 *
 * Hard constraints applied after baseline acceptance scoring but before
 * final acceptance. No new mechanics, no simulation, no randomness.
 * Ordered deterministically; first violation wins.
 *
 * Constraint ordering (authoritative):
 * 1. Competence bundle (require_bundle)
 * 2. Brčko completeness (require_brcko_resolution) — after bundles, before vetoes
 * 3. Faction/holder vetoes (forbid_competence, forbid_holder)
 */

import type { CompetenceId } from './competences.js';

export type AcceptanceConstraint =
  | { type: 'require_bundle'; competences: CompetenceId[]; reason: 'competence_bundle_incomplete' }
  | { type: 'require_brcko_resolution'; reason: 'brcko_unresolved' }
  | { type: 'forbid_competence'; faction: string; competence: CompetenceId; reason: 'competence_forbidden_to_faction' }
  | { type: 'forbid_holder'; competence: CompetenceId; holder: string; reason: 'competence_forbidden_holder' };

/**
 * Authoritative, ordered list of acceptance constraints.
 * Applied in order; first violation rejects the treaty.
 * Brčko constraint is evaluated only when treaty would trigger peace (territorial effects)
 * and does not include brcko_special_status; it is placed after bundles, before vetoes.
 * Phase 14: Added defence bundle (defence_policy + armed_forces_command).
 */
export const ACCEPTANCE_CONSTRAINTS: AcceptanceConstraint[] = [
  { type: 'require_bundle', competences: ['customs', 'indirect_taxation'], reason: 'competence_bundle_incomplete' },
  { type: 'require_bundle', competences: ['defence_policy', 'armed_forces_command'], reason: 'competence_bundle_incomplete' },
  { type: 'require_brcko_resolution', reason: 'brcko_unresolved' },
  { type: 'forbid_competence', faction: 'RS', competence: 'currency_authority', reason: 'competence_forbidden_to_faction' },
  { type: 'forbid_competence', faction: 'RS', competence: 'airspace_control', reason: 'competence_forbidden_to_faction' },
  { type: 'forbid_holder', competence: 'international_representation', holder: 'RS', reason: 'competence_forbidden_holder' }
];

export type RejectionReason =
  | 'competence_bundle_incomplete'
  | 'brcko_unresolved'
  | 'competence_forbidden_to_faction'
  | 'competence_forbidden_holder';

export interface RejectionDetails {
  constraint_type: AcceptanceConstraint['type'];
  competences?: string[];
  competence?: string;
  faction?: string;
  holder?: string;
}

/** Phase 13B.1: Context passed when applying constraints. Used for require_brcko_resolution. */
export interface AcceptanceConstraintContext {
  would_trigger_peace: boolean;
  has_brcko_resolution: boolean;
}

export interface ConstraintCheckResult {
  violated: boolean;
  rejection_reason?: RejectionReason;
  rejection_details?: RejectionDetails;
}

/**
 * Build competence -> holder map from allocate_competence clauses.
 * Caller passes collected allocations (e.g. from treaty clauses).
 */
export function buildCompetenceHolderMap(
  allocations: Array<{ competence: string; holder: string }>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of allocations) {
    if (a.competence && a.holder) {
      m.set(a.competence, a.holder);
    }
  }
  return m;
}

/**
 * Apply ACCEPTANCE_CONSTRAINTS in order.
 * Returns first violation, if any.
 * Phase 13B.1: Optional context for require_brcko_resolution (would_trigger_peace, has_brcko_resolution).
 */
export function applyAcceptanceConstraints(
  allocations: Array<{ competence: string; holder: string }>,
  context?: AcceptanceConstraintContext
): ConstraintCheckResult {
  const map = buildCompetenceHolderMap(allocations);

  for (const c of ACCEPTANCE_CONSTRAINTS) {
    if (c.type === 'require_bundle') {
      const present = c.competences.filter((comp) => map.has(comp));
      if (present.length > 0 && present.length < c.competences.length) {
        // Return sorted competences array for bundle violations
        const sortedCompetences = [...c.competences].sort();
        return {
          violated: true,
          rejection_reason: 'competence_bundle_incomplete',
          rejection_details: {
            constraint_type: 'require_bundle',
            competences: sortedCompetences
          }
        };
      }
      // Phase 14: Check that all competences in bundle are allocated to the same holder
      if (present.length === c.competences.length) {
        const holders = new Set<string>();
        for (const comp of c.competences) {
          const holder = map.get(comp);
          if (holder) {
            holders.add(holder);
          }
        }
        if (holders.size > 1) {
          // Bundle split across holders - return violation
          const sortedCompetences = [...c.competences].sort();
          return {
            violated: true,
            rejection_reason: 'competence_bundle_incomplete',
            rejection_details: {
              constraint_type: 'require_bundle',
              competences: sortedCompetences
            }
          };
        }
      }
    }

    if (c.type === 'require_brcko_resolution') {
      if (context?.would_trigger_peace === true && context?.has_brcko_resolution === false) {
        return {
          violated: true,
          rejection_reason: 'brcko_unresolved',
          rejection_details: { constraint_type: 'require_brcko_resolution' }
        };
      }
    }

    if (c.type === 'forbid_competence') {
      const holder = map.get(c.competence);
      if (holder === c.faction) {
        return {
          violated: true,
          rejection_reason: 'competence_forbidden_to_faction',
          rejection_details: {
            constraint_type: 'forbid_competence',
            competence: c.competence,
            faction: c.faction
          }
        };
      }
    }

    if (c.type === 'forbid_holder') {
      const holder = map.get(c.competence);
      if (holder === c.holder) {
        return {
          violated: true,
          rejection_reason: 'competence_forbidden_holder',
          rejection_details: {
            constraint_type: 'forbid_holder',
            competence: c.competence,
            holder: c.holder
          }
        };
      }
    }
  }

  return { violated: false };
}
