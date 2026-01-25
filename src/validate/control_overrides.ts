/**
 * Phase 12C.2: Validation for control_overrides and control_recognition
 */

import type { GameState, SettlementId, PoliticalSideId } from '../state/game_state.js';
import type { ValidationIssue } from './validate.js';

/**
 * Validate control_overrides structure and values.
 */
export function validateControlOverrides(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.control_overrides) {
    return issues; // Optional field, absence is fine
  }

  if (typeof state.control_overrides !== 'object' || Array.isArray(state.control_overrides)) {
    issues.push({
      severity: 'error',
      code: 'control_overrides.invalid_type',
      message: 'control_overrides must be an object (Record)',
      path: 'control_overrides'
    });
    return issues;
  }

  // Get valid faction IDs
  const validFactionIds = new Set(state.factions.map((f) => f.id));
  const currentTurn = state.meta.turn;

  for (const [sid, override] of Object.entries(state.control_overrides)) {
    const path = `control_overrides.${sid}`;

    if (typeof sid !== 'string' || sid.length === 0) {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_key',
        message: `Invalid settlement ID key: ${sid}`,
        path
      });
      continue;
    }

    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_value',
        message: `Override value must be an object`,
        path
      });
      continue;
    }

    // Validate side
    if (typeof override.side !== 'string' || !validFactionIds.has(override.side)) {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_side',
        message: `Invalid side: ${override.side} (must be valid faction ID)`,
        path: `${path}.side`
      });
    }

    // Validate kind
    if (override.kind !== 'treaty_transfer' && override.kind !== 'treaty_recognition') {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_kind',
        message: `Invalid kind: ${override.kind} (must be 'treaty_transfer' or 'treaty_recognition')`,
        path: `${path}.kind`
      });
    }

    // Validate treaty_id
    if (typeof override.treaty_id !== 'string' || override.treaty_id.length === 0) {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_treaty_id',
        message: `treaty_id must be non-empty string`,
        path: `${path}.treaty_id`
      });
    }

    // Validate since_turn
    if (!Number.isInteger(override.since_turn) || override.since_turn > currentTurn) {
      issues.push({
        severity: 'error',
        code: 'control_overrides.invalid_since_turn',
        message: `since_turn must be integer <= current turn (${currentTurn})`,
        path: `${path}.since_turn`
      });
    }
  }

  return issues;
}

/**
 * Validate control_recognition structure and values.
 */
export function validateControlRecognition(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!state.control_recognition) {
    return issues; // Optional field, absence is fine
  }

  if (typeof state.control_recognition !== 'object' || Array.isArray(state.control_recognition)) {
    issues.push({
      severity: 'error',
      code: 'control_recognition.invalid_type',
      message: 'control_recognition must be an object (Record)',
      path: 'control_recognition'
    });
    return issues;
  }

  // Get valid faction IDs
  const validFactionIds = new Set(state.factions.map((f) => f.id));
  const currentTurn = state.meta.turn;

  for (const [sid, recognition] of Object.entries(state.control_recognition)) {
    const path = `control_recognition.${sid}`;

    if (typeof sid !== 'string' || sid.length === 0) {
      issues.push({
        severity: 'error',
        code: 'control_recognition.invalid_key',
        message: `Invalid settlement ID key: ${sid}`,
        path
      });
      continue;
    }

    if (!recognition || typeof recognition !== 'object' || Array.isArray(recognition)) {
      issues.push({
        severity: 'error',
        code: 'control_recognition.invalid_value',
        message: `Recognition value must be an object`,
        path
      });
      continue;
    }

    // Validate side
    if (typeof recognition.side !== 'string' || !validFactionIds.has(recognition.side)) {
      issues.push({
        severity: 'error',
        code: 'control_recognition.invalid_side',
        message: `Invalid side: ${recognition.side} (must be valid faction ID)`,
        path: `${path}.side`
      });
    }

    // Validate treaty_id
    if (typeof recognition.treaty_id !== 'string' || recognition.treaty_id.length === 0) {
      issues.push({
        severity: 'error',
        code: 'control_recognition.invalid_treaty_id',
        message: `treaty_id must be non-empty string`,
        path: `${path}.treaty_id`
      });
    }

    // Validate since_turn
    if (!Number.isInteger(recognition.since_turn) || recognition.since_turn > currentTurn) {
      issues.push({
        severity: 'error',
        code: 'control_recognition.invalid_since_turn',
        message: `since_turn must be integer <= current turn (${currentTurn})`,
        path: `${path}.since_turn`
      });
    }
  }

  return issues;
}
