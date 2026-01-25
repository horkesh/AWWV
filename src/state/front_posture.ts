import { GameState, PostureLevel } from './game_state.js';

function isPostureLevel(value: unknown): value is PostureLevel {
  return value === 'hold' || value === 'probe' || value === 'push';
}

function clampWeight(value: unknown): number {
  if (!Number.isInteger(value)) return 0;
  const n = value as number;
  return n < 0 ? 0 : n;
}

/**
 * Deterministically normalize front posture assignments (state hygiene only).
 *
 * - Removes stale edge assignments not present in state.front_segments.
 * - Keeps assignments for inactive segments but forces weight=0.
 * - Clamps weight to integer >= 0.
 * - Coerces invalid posture values to "hold".
 *
 * No gameplay effects are applied.
 */
export function normalizeFrontPosture(state: GameState): void {
  if (!state.front_posture || typeof state.front_posture !== 'object') {
    state.front_posture = {};
    return;
  }

  const segmentKeys = new Set(Object.keys(state.front_segments ?? {}));
  const factionIdsSorted = Object.keys(state.front_posture).sort();

  for (const factionId of factionIdsSorted) {
    const fp = (state.front_posture as any)[factionId];
    if (!fp || typeof fp !== 'object') continue;
    const assignments = (fp as any).assignments as Record<string, any> | undefined;
    if (!assignments || typeof assignments !== 'object') {
      (fp as any).assignments = {};
      continue;
    }

    const edgeIdsSorted = Object.keys(assignments).sort();
    const next: Record<string, any> = {};

    for (const edge_id of edgeIdsSorted) {
      const a = assignments[edge_id];
      if (!a || typeof a !== 'object') continue;

      // Remove stale edge assignments not present in front_segments.
      if (!segmentKeys.has(edge_id)) continue;

      const seg = (state.front_segments as any)[edge_id];
      const isActive = seg && typeof seg === 'object' && (seg as any).active === true;

      const posture: PostureLevel = isPostureLevel((a as any).posture) ? (a as any).posture : 'hold';
      const weight = isActive ? clampWeight((a as any).weight) : 0;

      next[edge_id] = { edge_id, posture, weight };
    }

    (fp as any).assignments = next;
  }
}

