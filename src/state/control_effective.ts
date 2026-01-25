/**
 * Phase 12C.2: Effective settlement control resolution
 *
 * Single source of truth for "effective control" that considers:
 * 1. Negotiated control overrides (treaty-based)
 * 2. AoR-derived control (combat-based)
 *
 * This allows negotiated territorial changes to overlay combat control
 * without conflating the two channels.
 */

import type { GameState } from './game_state.js';
import type { SettlementId, PoliticalSideId } from './game_state.js';
import { getSettlementSide } from '../map/front_edges.js';

/**
 * Get the effective controlling side for a settlement.
 *
 * Logic:
 * - If control_overrides[sid] exists => return override.side
 * - Else return AoR-derived control side (getSettlementSide)
 * - Else null
 *
 * This is the single source of truth for effective control used in:
 * - Treaty apply validation (preconditions)
 * - Reports and UI
 *
 * Note: Treaty acceptance evaluation still uses AoR control directly
 * (it's fine to evaluate based on current AoR, not effective control).
 */
export function getEffectiveSettlementSide(
  state: GameState,
  sid: SettlementId
): PoliticalSideId | null {
  // Check control overrides first (negotiated control)
  if (state.control_overrides && typeof state.control_overrides === 'object') {
    const override = state.control_overrides[sid];
    if (override && typeof override === 'object' && typeof override.side === 'string') {
      return override.side;
    }
  }

  // Fall back to AoR-derived control
  return getSettlementSide(state, sid);
}
