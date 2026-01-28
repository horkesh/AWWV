/**
 * Phase 3B: Pressure → Exhaustion Coupling
 * 
 * Couples sustained front pressure into irreversible exhaustion accrual.
 * Deterministic, conservative w.r.t. pressure (does not modify pressure values).
 * 
 * Feature-gated: ENABLE_PHASE3B_PRESSURE_EXHAUSTION (default: false).
 */

import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import type { GameState, FactionId } from '../../state/game_state.js';
import type { FrontEdge } from '../../map/front_edges.js';
import type { EffectivePressureEdge } from './phase3a_pressure_eligibility.js';
import { getEnablePhase3A } from './phase3a_pressure_eligibility.js';

loadMistakes();
assertNoRepeat('phase3b implementation must not change phase3a conservation and must keep exhaustion irreversible, gated, and deterministic');

// Feature flag (OFF by default)
let _enablePhase3BOverride: boolean | null = null;

export function getEnablePhase3B(): boolean {
  return _enablePhase3BOverride !== null ? _enablePhase3BOverride : false;
}

export function setEnablePhase3B(enable: boolean): void {
  _enablePhase3BOverride = enable;
}

export function resetEnablePhase3B(): void {
  _enablePhase3BOverride = null;
}

// Legacy const export for backward compatibility (uses getter)
export const ENABLE_PHASE3B_PRESSURE_EXHAUSTION = false; // Default, but use getEnablePhase3B() for runtime value

// Phase 3B coupling constants (conservative, explicit)
const COUPLE_FRACTION = 0.02;
const COUPLE_MAX_PER_EDGE = 1.0;
const COUPLE_EPS = 1e-9;

export interface Phase3BExhaustionResult {
  applied: boolean;
  reason_if_not_applied: string;
  stats: {
    edges_processed: number;
    edges_generating_exhaustion: number;
    exhaustion_delta_by_faction: Record<string, number>;
    exhaustion_delta_max_edge: number;
  };
}

/**
 * Apply Phase 3B pressure → exhaustion coupling.
 * 
 * For each pressure-bearing front edge e with pressure p_e:
 * - Determine coupling eligibility and coupling weight w_e (0..1)
 * - Compute exhaustion increment inc_e = min(p_e * COUPLE_FRACTION * w_e, COUPLE_MAX_PER_EDGE)
 * - Sum increments by faction/side
 * - Apply increments to exhaustion accumulator in state (monotonic)
 * 
 * Pressure is NOT reduced (no dissipation here).
 * 
 * @param state Game state (mutated: exhaustion accumulator updated)
 * @param derivedFrontEdges Front edges (for side attribution)
 * @param effectiveEdges Phase 3A effective edges with eligibility weights (if Phase 3A enabled)
 * @returns Result object with applied flag, reason if not applied, and stats
 */
export function applyPhase3BPressureExhaustion(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  effectiveEdges?: EffectivePressureEdge[]
): Phase3BExhaustionResult {
  // Feature gate check
  if (!getEnablePhase3B()) {
    return {
      applied: false,
      reason_if_not_applied: 'feature_flag_disabled',
      stats: {
        edges_processed: 0,
        edges_generating_exhaustion: 0,
        exhaustion_delta_by_faction: {},
        exhaustion_delta_max_edge: 0
      }
    };
  }

  // Phase 3A prerequisite: if Phase 3A is disabled, Phase 3B should not apply
  // (safer option: not apply, with explicit reason message)
  if (!getEnablePhase3A()) {
    return {
      applied: false,
      reason_if_not_applied: 'phase3a_eligibility_disabled',
      stats: {
        edges_processed: 0,
        edges_generating_exhaustion: 0,
        exhaustion_delta_by_faction: {},
        exhaustion_delta_max_edge: 0
      }
    };
  }

  // Require effective edges from Phase 3A
  if (!effectiveEdges || !Array.isArray(effectiveEdges) || effectiveEdges.length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_phase3a_effective_edges',
      stats: {
        edges_processed: 0,
        edges_generating_exhaustion: 0,
        exhaustion_delta_by_faction: {},
        exhaustion_delta_max_edge: 0
      }
    };
  }

  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') {
    return {
      applied: false,
      reason_if_not_applied: 'no_pressure_field',
      stats: {
        edges_processed: 0,
        edges_generating_exhaustion: 0,
        exhaustion_delta_by_faction: {},
        exhaustion_delta_max_edge: 0
      }
    };
  }

  // Build map of effective edges by canonical edge key (a__b with a < b)
  const effectiveEdgeMap = new Map<string, EffectivePressureEdge>();
  for (const e of effectiveEdges) {
    if (!e.eligible || e.w < COUPLE_EPS) continue;
    const key = e.a < e.b ? `${e.a}__${e.b}` : `${e.b}__${e.a}`;
    effectiveEdgeMap.set(key, e);
  }

  // Build map of front edges by edge_id for side attribution
  const frontEdgeMap = new Map<string, FrontEdge>();
  for (const e of derivedFrontEdges) {
    if (e && typeof e.edge_id === 'string') {
      frontEdgeMap.set(e.edge_id, e);
    }
  }

  // Get all pressure-bearing edges in stable sorted order
  const edgeIds = Object.keys(fp)
    .filter((k) => {
      const v = (fp as Record<string, { value?: unknown }>)[k];
      return v && typeof v === 'object' && typeof (v as { value: number }).value === 'number';
    })
    .sort((a, b) => a.localeCompare(b));

  if (edgeIds.length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_pressure_bearing_edges',
      stats: {
        edges_processed: 0,
        edges_generating_exhaustion: 0,
        exhaustion_delta_by_faction: {},
        exhaustion_delta_max_edge: 0
      }
    };
  }

  // Accumulate exhaustion increments by faction
  const exhaustionDeltas = new Map<FactionId, number>();
  let edgesProcessed = 0;
  let edgesGeneratingExhaustion = 0;
  let exhaustionDeltaMaxEdge = 0;

  for (const edgeId of edgeIds) {
    const rec = (fp as Record<string, { value: number }>)[edgeId];
    const p_e = Math.abs(rec?.value ?? 0);
    if (p_e <= 0) continue;

    edgesProcessed++;

    // Find effective edge for this pressure edge
    // Edge IDs are canonical: a__b with a < b
    const effectiveEdge = effectiveEdgeMap.get(edgeId);
    if (!effectiveEdge) continue; // Not eligible for coupling

    // Get coupling weight (already clamped to [0,1] by Phase 3A)
    const w_e = Math.max(0, Math.min(1, effectiveEdge.w));

    // Compute exhaustion increment for this edge
    const inc_e = Math.min(p_e * COUPLE_FRACTION * w_e, COUPLE_MAX_PER_EDGE);
    if (inc_e < COUPLE_EPS) continue; // Negligible increment

    edgesGeneratingExhaustion++;
    if (inc_e > exhaustionDeltaMaxEdge) {
      exhaustionDeltaMaxEdge = inc_e;
    }

    // Attribute exhaustion to sides based on front edge
    const frontEdge = frontEdgeMap.get(edgeId);
    if (!frontEdge || typeof frontEdge.side_a !== 'string' || typeof frontEdge.side_b !== 'string') {
      continue; // Skip if side attribution unavailable
    }

    // For undirected edges, split deterministically (half/half)
    // This matches the existing "edge-keyed pressure attribution" scheme
    const inc_a = inc_e / 2;
    const inc_b = inc_e / 2;

    exhaustionDeltas.set(
      frontEdge.side_a,
      (exhaustionDeltas.get(frontEdge.side_a) ?? 0) + inc_a
    );
    exhaustionDeltas.set(
      frontEdge.side_b,
      (exhaustionDeltas.get(frontEdge.side_b) ?? 0) + inc_b
    );
  }

  // Apply exhaustion increments to state (monotonic, irreversible)
  const exhaustionDeltaByFaction: Record<string, number> = {};
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));

  for (const f of factions) {
    const delta = exhaustionDeltas.get(f.id) ?? 0;
    if (delta < COUPLE_EPS) {
      exhaustionDeltaByFaction[f.id] = 0;
      continue;
    }

    // Round deterministically (use integer exhaustion like existing accumulateExhaustion)
    // Exhaustion is stored as integer, so we floor the delta
    const deltaRounded = Math.floor(delta);

    const before = Number.isFinite(f.profile?.exhaustion) ? f.profile.exhaustion : 0;
    const after = before + deltaRounded;

    // Irreversible: never decrease (monotonic non-decreasing)
    f.profile.exhaustion = Math.max(before, after);
    exhaustionDeltaByFaction[f.id] = f.profile.exhaustion - before;
  }

  return {
    applied: edgesGeneratingExhaustion > 0,
    reason_if_not_applied: edgesGeneratingExhaustion > 0 ? '' : 'no_exhaustion_generated',
    stats: {
      edges_processed: edgesProcessed,
      edges_generating_exhaustion: edgesGeneratingExhaustion,
      exhaustion_delta_by_faction: exhaustionDeltaByFaction,
      exhaustion_delta_max_edge: exhaustionDeltaMaxEdge
    }
  };
}
