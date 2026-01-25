import { CURRENT_SCHEMA_VERSION, GameState } from '../state/game_state.js';
import { validateFactions } from './factions.js';
import { validateControlOverrides, validateControlRecognition } from './control_overrides.js';
import { validateSupplyRights } from './supply_rights.js';
import { validateEndState } from './end_state.js';

export type ValidationSeverity = 'error' | 'warn';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export function validateState(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Placeholder: required top-level fields present (and basic types).
  if (!state || typeof state !== 'object') {
    issues.push({
      severity: 'error',
      code: 'state.not_object',
      message: 'State must be an object',
      path: ''
    });
    return issues;
  }

  if (!('schema_version' in state)) {
    issues.push({
      severity: 'error',
      code: 'state.missing_schema_version',
      message: 'Missing required field `schema_version`',
      path: 'schema_version'
    });
  }

  if (!('meta' in state)) {
    issues.push({
      severity: 'error',
      code: 'state.missing_meta',
      message: 'Missing required field `meta`',
      path: 'meta'
    });
  }

  if (!('factions' in state)) {
    issues.push({
      severity: 'error',
      code: 'state.missing_factions',
      message: 'Missing required field `factions`',
      path: 'factions'
    });
  }

  // Placeholder: schema_version known.
  if (Number.isInteger(state.schema_version)) {
    if (state.schema_version !== CURRENT_SCHEMA_VERSION) {
      issues.push({
        severity: 'error',
        code: 'schema_version.unknown',
        message: `Unknown schema_version ${state.schema_version} (supported: ${CURRENT_SCHEMA_VERSION})`,
        path: 'schema_version'
      });
    }
  } else {
    issues.push({
      severity: 'error',
      code: 'schema_version.not_integer',
      message: 'schema_version must be an integer',
      path: 'schema_version'
    });
  }

  // Validate factions
  if (state.factions) {
    issues.push(...validateFactions(state));
  }

  // Phase 12C.2: Validate control_overrides and control_recognition
  issues.push(...validateControlOverrides(state));
  issues.push(...validateControlRecognition(state));

  // Phase 12C.3: Validate supply_rights
  issues.push(...validateSupplyRights(state));

  // Phase 12D.0: Validate end_state
  issues.push(...validateEndState(state));

  return issues;
}

