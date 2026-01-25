import type { GameState, PostureLevel } from './game_state.js';
import type { FrontRegionsFile } from '../map/front_regions.js';

function isPostureLevel(value: unknown): value is PostureLevel {
  return value === 'hold' || value === 'probe' || value === 'push';
}

function clampWeight(value: unknown): number {
  if (!Number.isInteger(value)) return 0;
  const n = value as number;
  return n < 0 ? 0 : n;
}

/**
 * Deterministically expand region-level posture commands into per-edge posture assignments.
 *
 * Rules:
 * - For each faction (sorted):
 *   - For each region_id assignment (sorted):
 *     - Find region in frontRegions by region_id (missing => ignore)
 *     - For each edge_id in region.edge_ids (already sorted):
 *       - Skip inactive segments (state.front_segments[edge_id]?.active !== true)
 *       - If edge posture already exists for this faction, do nothing (edge overrides region)
 *       - Else write edge posture = region posture/weight (clamped/coerced)
 *
 * This mutates state.front_posture but never deletes or clears existing edge assignments.
 * Cleanup/zeroing of inactive/stale edges remains the responsibility of normalizeFrontPosture.
 */
export function expandRegionPostureToEdges(
  state: GameState,
  frontRegions: FrontRegionsFile
): { expanded_edges_count: number } {
  if (!state.front_posture || typeof state.front_posture !== 'object') state.front_posture = {};
  if (!state.front_posture_regions || typeof state.front_posture_regions !== 'object') state.front_posture_regions = {};

  const regionById = new Map<string, { edge_ids: string[] }>();
  for (const r of frontRegions.regions ?? []) {
    if (r && typeof r === 'object' && typeof (r as any).region_id === 'string' && Array.isArray((r as any).edge_ids)) {
      regionById.set((r as any).region_id, { edge_ids: (r as any).edge_ids as string[] });
    }
  }

  let expanded = 0;
  const factionIdsSorted = Object.keys(state.front_posture_regions).sort();

  for (const factionId of factionIdsSorted) {
    const rp = (state.front_posture_regions as any)[factionId];
    if (!rp || typeof rp !== 'object') continue;
    const regionAssignments = (rp as any).assignments as Record<string, any> | undefined;
    if (!regionAssignments || typeof regionAssignments !== 'object') continue;

    if (!state.front_posture[factionId]) state.front_posture[factionId] = { assignments: {} };
    if (!state.front_posture[factionId].assignments) state.front_posture[factionId].assignments = {};
    const edgeAssignments = state.front_posture[factionId].assignments as Record<string, any>;

    const regionIdsSorted = Object.keys(regionAssignments).sort();
    for (const region_id of regionIdsSorted) {
      const a = regionAssignments[region_id];
      if (!a || typeof a !== 'object') continue;

      const region = regionById.get(region_id);
      if (!region) continue;

      const posture: PostureLevel = isPostureLevel((a as any).posture) ? (a as any).posture : 'hold';
      const weight = clampWeight((a as any).weight);

      for (const edge_id of region.edge_ids) {
        const seg = (state.front_segments as any)?.[edge_id];
        const isActive = seg && typeof seg === 'object' && (seg as any).active === true;
        if (!isActive) continue;

        if (edgeAssignments[edge_id] && typeof edgeAssignments[edge_id] === 'object') {
          // explicit per-edge override wins
          continue;
        }

        edgeAssignments[edge_id] = { edge_id, posture, weight };
        expanded += 1;
      }
    }
  }

  return { expanded_edges_count: expanded };
}

