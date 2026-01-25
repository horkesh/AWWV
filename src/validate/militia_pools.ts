import type { GameState, MunicipalityId } from '../state/game_state.js';
import type { ValidationIssue } from './validate.js';
import { POLITICAL_SIDES } from '../state/identity.js';

/**
 * Validates militia_pools field.
 * - Keys must match MilitiaPoolState.mun_id
 * - mun_id must exist in valid municipality set
 * - faction must be valid faction id or null
 * - available, committed, exhausted must be integers >= 0
 * - updated_turn must be <= current turn
 * - tags must be normalized (trimmed, no empty, unique, sorted)
 */
export function validateMilitiaPools(
  state: GameState,
  validMunicipalityIds: Iterable<MunicipalityId>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const militiaPools = (state as any)?.militia_pools as Record<string, any> | undefined;
  if (!militiaPools || typeof militiaPools !== 'object') return issues;

  const validMunIds = new Set(validMunicipalityIds);
  const factionIds = new Set<string>((state.factions ?? []).map((f) => (f as any)?.id).filter((x) => typeof x === 'string'));

  const poolKeys = Object.keys(militiaPools).sort(); // deterministic ordering
  const currentTurn = state.meta?.turn ?? 0;

  for (const key of poolKeys) {
    const pool = militiaPools[key];
    const basePath = `militia_pools.${key}`;

    if (!pool || typeof pool !== 'object') {
      issues.push({
        severity: 'error',
        code: 'militia_pools.entry.invalid',
        path: basePath,
        message: 'militia pool entry must be an object'
      });
      continue;
    }

    // Key must match mun_id
    const mun_id = (pool as any).mun_id;
    if (typeof mun_id !== 'string' || mun_id !== key) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.mun_id.mismatch',
        path: `${basePath}.mun_id`,
        message: `militia_pools key (${key}) must equal MilitiaPoolState.mun_id (${String(mun_id)})`
      });
    }

    // mun_id must exist in valid municipality set
    if (typeof mun_id === 'string' && !validMunIds.has(mun_id)) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.mun_id.invalid',
        path: `${basePath}.mun_id`,
        message: `mun_id must reference a valid municipality id (unknown: ${mun_id})`
      });
    }

    // faction must be valid political side id or null
    const faction = (pool as any).faction;
    if (faction !== null && faction !== undefined) {
      if (typeof faction !== 'string' || faction.length === 0) {
        issues.push({
          severity: 'error',
          code: 'militia_pools.faction.invalid',
          path: `${basePath}.faction`,
          message: 'faction must be null or a non-empty string'
        });
      } else if (!POLITICAL_SIDES.includes(faction as any)) {
        issues.push({
          severity: 'error',
          code: 'militia_pools.faction.not_political_side',
          path: `${basePath}.faction`,
          message: `faction must be null or one of: ${POLITICAL_SIDES.join(', ')}`
        });
      } else if (!factionIds.has(faction)) {
        issues.push({
          severity: 'error',
          code: 'militia_pools.faction.not_found',
          path: `${basePath}.faction`,
          message: 'faction must reference an existing faction id'
        });
      }
    }

    // available, committed, exhausted must be integers >= 0
    const available = (pool as any).available;
    if (!Number.isInteger(available) || available < 0) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.available.invalid',
        path: `${basePath}.available`,
        message: 'available must be an integer >= 0'
      });
    }

    const committed = (pool as any).committed;
    if (!Number.isInteger(committed) || committed < 0) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.committed.invalid',
        path: `${basePath}.committed`,
        message: 'committed must be an integer >= 0'
      });
    }

    const exhausted = (pool as any).exhausted;
    if (!Number.isInteger(exhausted) || exhausted < 0) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.exhausted.invalid',
        path: `${basePath}.exhausted`,
        message: 'exhausted must be an integer >= 0'
      });
    }

    // updated_turn must be <= current turn
    const updated_turn = (pool as any).updated_turn;
    if (!Number.isInteger(updated_turn) || updated_turn > currentTurn) {
      issues.push({
        severity: 'error',
        code: 'militia_pools.updated_turn.invalid',
        path: `${basePath}.updated_turn`,
        message: `updated_turn must be an integer <= current turn (${currentTurn})`
      });
    }

    // Phase 10: fatigue validation (if present)
    const fatigue = (pool as any).fatigue;
    if (fatigue !== undefined && fatigue !== null) {
      if (!Number.isInteger(fatigue) || fatigue < 0) {
        issues.push({
          severity: 'error',
          code: 'militia_pools.fatigue.invalid',
          path: `${basePath}.fatigue`,
          message: 'fatigue must be an integer >= 0 if present'
        });
      }
    }

    // tags validation (if present)
    const tags = (pool as any).tags;
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags)) {
        issues.push({
          severity: 'error',
          code: 'militia_pools.tags.invalid',
          path: `${basePath}.tags`,
          message: 'tags must be an array if present'
        });
      } else {
        const seen = new Set<string>();
        for (let i = 0; i < tags.length; i += 1) {
          const tag = tags[i];
          if (typeof tag !== 'string') {
            issues.push({
              severity: 'error',
              code: 'militia_pools.tags.item.invalid',
              path: `${basePath}.tags[${i}]`,
              message: 'tags items must be strings'
            });
          } else {
            const trimmed = tag.trim();
            if (trimmed.length === 0) {
              issues.push({
                severity: 'error',
                code: 'militia_pools.tags.empty',
                path: `${basePath}.tags[${i}]`,
                message: 'tags items must not be empty or whitespace-only'
              });
            } else if (seen.has(trimmed)) {
              issues.push({
                severity: 'error',
                code: 'militia_pools.tags.duplicate',
                path: `${basePath}.tags[${i}]`,
                message: `duplicate tag: ${trimmed}`
              });
            } else {
              seen.add(trimmed);
            }
            // Check if tags are sorted (deterministic ordering)
            if (i > 0 && typeof tags[i - 1] === 'string' && trimmed < tags[i - 1].trim()) {
              issues.push({
                severity: 'error',
                code: 'militia_pools.tags.not_sorted',
                path: `${basePath}.tags`,
                message: 'tags must be sorted deterministically'
              });
            }
          }
        }
      }
    }
  }

  // Sort issues deterministically: by mun_id, then by field
  return issues.sort((a, b) => {
    const pathA = a.path ?? '';
    const pathB = b.path ?? '';
    return pathA.localeCompare(pathB);
  });
}
