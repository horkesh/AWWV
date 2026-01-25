import { GameState } from '../state/game_state.js';
import { ValidationIssue } from './validate.js';

function isPostureLevel(value: unknown): boolean {
  return value === 'hold' || value === 'probe' || value === 'push';
}

export function validateFrontPosture(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const fp = (state as any)?.front_posture as Record<string, any> | undefined;
  if (!fp || typeof fp !== 'object') return issues;

  const segmentKeys = new Set(Object.keys((state as any)?.front_segments ?? {}));
  const factionIds = Object.keys(fp).sort();

  for (const factionId of factionIds) {
    const faction = fp[factionId];
    if (!faction || typeof faction !== 'object') continue;
    const assignments = (faction as any).assignments as Record<string, any> | undefined;
    if (!assignments || typeof assignments !== 'object') continue;

    const edgeIds = Object.keys(assignments).sort();
    for (const edge_id of edgeIds) {
      const a = assignments[edge_id];
      const basePath = `front_posture.${factionId}.assignments.${edge_id}`;
      if (!a || typeof a !== 'object') continue;

      // edge_id canonical format a__b with a<b
      if (typeof edge_id !== 'string' || !edge_id.includes('__')) {
        issues.push({
          severity: 'error',
          code: 'front_posture.edge_id.format',
          path: basePath,
          message: 'edge_id key must contain "__" delimiter'
        });
        continue;
      }
      const parts = edge_id.split('__');
      if (parts.length !== 2) {
        issues.push({
          severity: 'error',
          code: 'front_posture.edge_id.format',
          path: basePath,
          message: 'edge_id must split into exactly two settlement ids'
        });
        continue;
      }
      const [s0, s1] = parts;
      if (!(s0 < s1)) {
        issues.push({
          severity: 'error',
          code: 'front_posture.edge_id.non_canonical',
          path: basePath,
          message: 'edge_id must be canonical with a < b'
        });
      }

      // assignment.edge_id consistency (error if mismatched)
      if (typeof (a as any).edge_id === 'string' && (a as any).edge_id !== edge_id) {
        issues.push({
          severity: 'error',
          code: 'front_posture.edge_id.mismatch',
          path: `${basePath}.edge_id`,
          message: `assignment.edge_id must equal key "${edge_id}"`
        });
      }

      // posture value must be valid (normalize step may fix; validate should error)
      const posture = (a as any).posture;
      if (!isPostureLevel(posture)) {
        issues.push({
          severity: 'error',
          code: 'front_posture.posture.invalid',
          path: `${basePath}.posture`,
          message: 'posture must be one of hold|probe|push'
        });
      }

      // weight integer >= 0
      const weight = (a as any).weight;
      if (!Number.isInteger(weight) || weight < 0) {
        issues.push({
          severity: 'error',
          code: 'front_posture.weight.invalid',
          path: `${basePath}.weight`,
          message: 'weight must be an integer >= 0'
        });
      }

      // stale assignment reference (warning, not error)
      if (!segmentKeys.has(edge_id)) {
        issues.push({
          severity: 'warn',
          code: 'front_posture.edge_id.unknown',
          path: basePath,
          message: 'assignment references edge_id not present in front_segments (stale)'
        });
      }
    }
  }

  return issues;
}

