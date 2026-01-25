/**
 * Phase 15: Validator for competence valuation tables
 *
 * Ensures completeness: every competence_id has a valuation for every faction.
 * Validation failure is fatal (rejects run).
 */

import { ALL_COMPETENCES } from '../state/competences.js';
import { POLITICAL_SIDES } from '../state/identity.js';
import { COMPETENCE_VALUATIONS } from '../state/competence_valuations.js';
import type { CompetenceId } from '../state/competences.js';
import type { PoliticalSideId } from '../state/identity.js';

/**
 * Validate competence valuation tables for completeness.
 * 
 * Checks:
 * - Every competence_id has a valuation for every faction
 * - No NaN, undefined, or missing entries
 * - All values are integers
 * 
 * @throws Error if validation fails (fatal)
 */
export function validateCompetenceValuations(): void {
  const errors: string[] = [];

  for (const factionId of POLITICAL_SIDES) {
    const factionVals = COMPETENCE_VALUATIONS[factionId];
    if (!factionVals) {
      errors.push(`Missing valuation table for faction: ${factionId}`);
      continue;
    }

    for (const competenceId of ALL_COMPETENCES) {
      const value = factionVals[competenceId];
      if (value === undefined) {
        errors.push(`Missing valuation for competence ${competenceId} and faction ${factionId}`);
        continue;
      }
      if (!Number.isInteger(value)) {
        errors.push(`Non-integer valuation for competence ${competenceId} and faction ${factionId}: ${value}`);
        continue;
      }
      if (Number.isNaN(value)) {
        errors.push(`NaN valuation for competence ${competenceId} and faction ${factionId}`);
        continue;
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Competence valuation validation failed:\n${errors.join('\n')}`);
  }
}

// Validate at module load time (fatal if incomplete)
validateCompetenceValuations();
