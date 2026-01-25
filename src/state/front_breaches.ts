import { FrontEdge } from '../map/front_edges.js';
import { GameState } from './game_state.js';

export type FavoredSide = 'side_a' | 'side_b';

export interface FrontBreach {
  edge_id: string;
  turn: number;
  side_a: string;
  side_b: string;
  pressure_value: number;
  threshold: number;
  favored_side: FavoredSide;
  reason: 'pressure_exceeded';
}

export const FRONT_BREACH_THRESHOLD = 20;

/**
 * Compute deterministic breach candidates from current persistent pressure state.
 * Scaffolding only: does not mutate state and does not change territory/control.
 */
export function computeFrontBreaches(state: GameState, derivedFrontEdges: FrontEdge[]): FrontBreach[] {
  const turn = state.meta.turn;

  // Map derived edge_id -> edge for side lookup (use first; derived is deterministic anyway).
  const edgeById = new Map<string, FrontEdge>();
  for (const e of derivedFrontEdges) {
    if (!e || typeof e.edge_id !== 'string') continue;
    if (!edgeById.has(e.edge_id)) edgeById.set(e.edge_id, e);
  }

  const edgeIdsSorted = Array.from(edgeById.keys()).sort();
  const breaches: FrontBreach[] = [];

  for (const edge_id of edgeIdsSorted) {
    const seg = (state.front_segments as any)?.[edge_id];
    const isActive = seg && typeof seg === 'object' && (seg as any).active === true;
    if (!isActive) continue;

    const edge = edgeById.get(edge_id)!;
    if (typeof edge.side_a !== 'string' || typeof edge.side_b !== 'string') continue;

    const pressure_value = Number.isInteger((state.front_pressure as any)?.[edge_id]?.value)
      ? ((state.front_pressure as any)[edge_id].value as number)
      : 0;

    const abs = Math.abs(pressure_value);
    if (abs < FRONT_BREACH_THRESHOLD) continue;

    const favored_side: FavoredSide = pressure_value >= FRONT_BREACH_THRESHOLD ? 'side_a' : 'side_b';

    breaches.push({
      edge_id,
      turn,
      side_a: edge.side_a,
      side_b: edge.side_b,
      pressure_value,
      threshold: FRONT_BREACH_THRESHOLD,
      favored_side,
      reason: 'pressure_exceeded'
    });
  }

  // Deterministic ordering: abs(pressure) desc, then edge_id asc
  breaches.sort((a, b) => {
    const absA = Math.abs(a.pressure_value);
    const absB = Math.abs(b.pressure_value);
    if (absA !== absB) return absB - absA;
    return a.edge_id.localeCompare(b.edge_id);
  });

  return breaches;
}

