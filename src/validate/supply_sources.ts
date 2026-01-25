import { GameState } from '../state/game_state.js';
import { ValidationIssue } from './validate.js';

/**
 * Validates supply_sources field for all factions.
 * - Error if non-string in array
 * - Warning if sid not in settlementIds
 * - Warning if duplicates (should be normalized, prefer warning only)
 */
export function validateSupplySources(
  state: GameState,
  settlementIds: Iterable<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const settlementSet = new Set(settlementIds);

  const factions = state.factions ?? [];
  for (let i = 0; i < factions.length; i += 1) {
    const faction = factions[i];
    const basePath = `factions[${i}]`;

    if (!faction || typeof faction !== 'object') continue;

    const supplySources = faction.supply_sources;
    if (supplySources === undefined || supplySources === null) {
      // Migration should have defaulted this, but warn if missing
      issues.push({
        severity: 'warn',
        code: 'supply_sources.missing',
        path: `${basePath}.supply_sources`,
        message: 'supply_sources missing (should default to [])'
      });
      continue;
    }

    if (!Array.isArray(supplySources)) {
      issues.push({
        severity: 'error',
        code: 'supply_sources.not_array',
        path: `${basePath}.supply_sources`,
        message: 'supply_sources must be an array'
      });
      continue;
    }

    // Check for non-string items
    const seen = new Set<string>();
    for (let j = 0; j < supplySources.length; j += 1) {
      const sid = supplySources[j];
      const itemPath = `${basePath}.supply_sources[${j}]`;

      if (typeof sid !== 'string') {
        issues.push({
          severity: 'error',
          code: 'supply_sources.item_not_string',
          path: itemPath,
          message: 'supply_sources items must be strings'
        });
        continue;
      }

      // Check for duplicates
      if (seen.has(sid)) {
        issues.push({
          severity: 'warn',
          code: 'supply_sources.duplicate',
          path: itemPath,
          message: `Duplicate supply source: ${sid}`
        });
      }
      seen.add(sid);

      // Check if sid exists in settlement graph
      if (!settlementSet.has(sid)) {
        issues.push({
          severity: 'warn',
          code: 'supply_sources.invalid_sid',
          path: itemPath,
          message: `Supply source sid not found in settlement graph: ${sid}`
        });
      }
    }
  }

  return issues;
}
