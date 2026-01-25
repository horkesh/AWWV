import type { GameState } from '../state/game_state.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import type { ValidationIssue } from './validate.js';

function isPostureLevel(value: unknown): boolean {
  return value === 'hold' || value === 'probe' || value === 'push';
}

export function validateFrontPostureRegions(state: GameState, frontRegions: FrontRegionsFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const rec = (state as any)?.front_posture_regions as Record<string, any> | undefined;
  if (!rec || typeof rec !== 'object') return issues;

  const knownRegionIds = new Set<string>();
  for (const r of frontRegions.regions ?? []) {
    if (r && typeof r === 'object' && typeof (r as any).region_id === 'string') knownRegionIds.add((r as any).region_id);
  }

  const factionIds = Object.keys(rec).sort();
  for (const factionId of factionIds) {
    const fp = rec[factionId];
    if (!fp || typeof fp !== 'object') continue;
    const assignments = (fp as any).assignments as Record<string, any> | undefined;
    if (!assignments || typeof assignments !== 'object') continue;

    const regionIds = Object.keys(assignments).sort();
    for (const region_id of regionIds) {
      const a = assignments[region_id];
      const basePath = `front_posture_regions.${factionId}.assignments.${region_id}`;
      if (!a || typeof a !== 'object') continue;

      if (typeof region_id !== 'string' || region_id.length === 0) {
        issues.push({
          severity: 'error',
          code: 'front_posture_regions.region_id.invalid',
          path: basePath,
          message: 'region_id key must be a non-empty string'
        });
        continue;
      }

      const posture = (a as any).posture;
      if (!isPostureLevel(posture)) {
        issues.push({
          severity: 'error',
          code: 'front_posture_regions.posture.invalid',
          path: `${basePath}.posture`,
          message: 'posture must be one of hold|probe|push'
        });
      }

      const weight = (a as any).weight;
      if (!Number.isInteger(weight) || weight < 0) {
        issues.push({
          severity: 'error',
          code: 'front_posture_regions.weight.invalid',
          path: `${basePath}.weight`,
          message: 'weight must be an integer >= 0'
        });
      }

      if (!knownRegionIds.has(region_id)) {
        issues.push({
          severity: 'warn',
          code: 'front_posture_regions.region_id.unknown',
          path: basePath,
          message: 'assignment references region_id not present in derived front_regions for this save'
        });
      }
    }
  }

  return issues;
}

