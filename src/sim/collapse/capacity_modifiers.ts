/**
 * Phase 3D: Capacity modifiers (consumption helpers)
 *
 * Side-effect free helpers to read per-SID capacity multipliers produced by Phase 3D.
 * These helpers must NOT introduce new mechanics: they only expose existing multipliers/caps
 * for consumption at existing hook points (e.g., pressure generation, supply penalties).
 */
 
import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import type { GameState } from '../../state/game_state.js';
 
loadMistakes();
assertNoRepeat('phase3d modifiers must be consumed only via existing multipliers/caps; do not introduce new mechanics or hidden side effects');
 
export type CapacityModifierKey = 'authority_mult' | 'cohesion_mult' | 'supply_mult' | 'pressure_cap_mult';
 
export interface SidCapacityModifiers {
  authority_mult: number;
  cohesion_mult: number;
  supply_mult: number;
  pressure_cap_mult: number;
}
 
const DEFAULT_MODIFIERS: SidCapacityModifiers = {
  authority_mult: 1,
  cohesion_mult: 1,
  supply_mult: 1,
  pressure_cap_mult: 1
};
 
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 1;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
 
/**
 * Safe per-SID modifier reader. Defaults to all 1s.
 */
export function getSidCapacityModifiers(state: GameState, sid: string): SidCapacityModifiers {
  const rec = state.capacity_modifiers?.by_sid?.[sid] as Partial<SidCapacityModifiers> | undefined;
  if (!rec || typeof rec !== 'object') return DEFAULT_MODIFIERS;
  return {
    authority_mult: clamp01(rec.authority_mult ?? 1),
    cohesion_mult: clamp01(rec.cohesion_mult ?? 1),
    supply_mult: clamp01(rec.supply_mult ?? 1),
    pressure_cap_mult: clamp01(rec.pressure_cap_mult ?? 1)
  };
}
 
/**
 * Conservative edge multiplier: min(endpoint multipliers).
 * This avoids inventing side attribution logic.
 */
export function getEdgeCapacityMultiplier(
  state: GameState,
  sidA: string,
  sidB: string,
  which: CapacityModifierKey
): number {
  const a = getSidCapacityModifiers(state, sidA)[which];
  const b = getSidCapacityModifiers(state, sidB)[which];
  return Math.min(a, b);
}
 
