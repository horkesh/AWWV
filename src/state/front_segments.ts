import { GameState, FrontSegmentState } from './game_state.js';
import { FrontEdge } from '../map/front_edges.js';

/**
 * Deterministically sync persistent front segment state from derived front edges.
 *
 * - Does not delete segments (inactive segments are retained).
 * - Deterministic: iterates edge_ids and existing keys in sorted order.
 */
export function syncFrontSegments(state: GameState, derivedFrontEdges: FrontEdge[]): void {
  const turn = state.meta.turn;

  // Build sorted, de-duplicated active edge_id set.
  const activeEdgeIds = new Set<string>();
  for (const edge of derivedFrontEdges) {
    if (edge && typeof edge.edge_id === 'string') activeEdgeIds.add(edge.edge_id);
  }
  const activeIdsSorted = Array.from(activeEdgeIds).sort();

  // Ensure container exists (migration should provide this, but keep defensive).
  if (!state.front_segments || typeof state.front_segments !== 'object') {
    state.front_segments = {};
  }

  // Activate / upsert in deterministic order.
  for (const edge_id of activeIdsSorted) {
    const existing = state.front_segments[edge_id] as FrontSegmentState | undefined;

    if (!existing) {
      state.front_segments[edge_id] = {
        edge_id,
        active: true,
        created_turn: turn,
        since_turn: turn,
        last_active_turn: turn,
        active_streak: 1,
        max_active_streak: 1,
        friction: 1,
        max_friction: 1
      };
      continue;
    }

    const prevWasActive = existing.active === true;
    const prevLastActiveTurn = existing.last_active_turn;
    const prevActiveStreak = Number.isInteger(existing.active_streak) ? existing.active_streak : 0;
    const prevMaxActiveStreak = Number.isInteger(existing.max_active_streak) ? existing.max_active_streak : 0;
    const prevFriction = Number.isInteger(existing.friction) ? existing.friction : 0;
    const prevMaxFriction = Number.isInteger(existing.max_friction) ? existing.max_friction : 0;
    existing.edge_id = edge_id; // keep canonical
    existing.active = true;

    // Only reset since_turn if it was inactive previously (or invalid/missing).
    if (!prevWasActive || !Number.isInteger(existing.since_turn)) {
      existing.since_turn = turn;
    }

    // Deterministic streak maintenance using only prior state + last_active_turn.
    const wasActiveLastTurn = prevWasActive && prevLastActiveTurn === turn - 1;
    existing.active_streak = wasActiveLastTurn ? prevActiveStreak + 1 : 1;
    existing.max_active_streak = Math.max(prevMaxActiveStreak, existing.active_streak);

    // Deterministic friction scaffolding using only prior segment state.
    existing.friction = prevFriction + 1;
    existing.max_friction = Math.max(prevMaxFriction, existing.friction);

    existing.last_active_turn = turn;
  }

  // Deactivate segments not currently active (retain record), deterministic by key order.
  const existingKeysSorted = Object.keys(state.front_segments).sort();
  for (const edge_id of existingKeysSorted) {
    if (activeEdgeIds.has(edge_id)) continue;
    const seg = state.front_segments[edge_id];
    if (!seg) continue;
    seg.active = false;
    // Streak resets when inactive; max is retained.
    seg.active_streak = 0;
    // Friction decays deterministically toward 0; max is retained.
    const prevFriction = Number.isInteger(seg.friction) ? seg.friction : 0;
    seg.friction = Math.max(prevFriction - 1, 0);
  }
}

