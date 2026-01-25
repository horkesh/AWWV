import { FrontEdge } from '../map/front_edges.js';
import { GameState } from './game_state.js';

export const EXHAUSTION_WORK_DIVISOR = 10;

export interface ExhaustionStats {
  per_faction: Array<{
    faction_id: string;
    exhaustion_before: number;
    exhaustion_after: number;
    delta: number;
    work_supplied: number;
    work_unsupplied: number;
  }>;
}

export function accumulateExhaustion(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  pressureDeltasByEdge: Map<string, number>,
  localSupplyByEdgeSide: Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }>
): ExhaustionStats {
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const workSuppliedByFaction = new Map<string, number>();
  const workUnsuppliedByFaction = new Map<string, number>();

  for (const f of factions) {
    workSuppliedByFaction.set(f.id, 0);
    workUnsuppliedByFaction.set(f.id, 0);
  }

  const edgesSorted = [...derivedFrontEdges]
    .filter((e) => e && typeof e.edge_id === 'string')
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));

  for (const edge of edgesSorted) {
    const edge_id = edge.edge_id;
    const seg = (state.front_segments as any)?.[edge_id];
    const isActive = seg && typeof seg === 'object' && (seg as any).active === true;
    if (!isActive) continue;

    const side_a = edge.side_a;
    const side_b = edge.side_b;
    if (typeof side_a !== 'string' || typeof side_b !== 'string') continue;

    const deltaRaw = pressureDeltasByEdge.get(edge_id);
    if (!Number.isInteger(deltaRaw)) continue;
    const delta = deltaRaw as number;
    const work = Math.abs(delta);

    const supply = localSupplyByEdgeSide.get(edge_id);
    if (!supply) continue;

    // Attribute the same abs(delta) "work" to both sides; bucket by supplied vs unsupplied.
    if (supply.side_a_supplied) {
      workSuppliedByFaction.set(side_a, (workSuppliedByFaction.get(side_a) ?? 0) + work);
    } else {
      workUnsuppliedByFaction.set(side_a, (workUnsuppliedByFaction.get(side_a) ?? 0) + work);
    }

    if (supply.side_b_supplied) {
      workSuppliedByFaction.set(side_b, (workSuppliedByFaction.get(side_b) ?? 0) + work);
    } else {
      workUnsuppliedByFaction.set(side_b, (workUnsuppliedByFaction.get(side_b) ?? 0) + work);
    }
  }

  const per_faction: ExhaustionStats['per_faction'] = [];

  for (const f of factions) {
    const before = Number.isFinite(f.profile?.exhaustion) ? f.profile.exhaustion : 0;
    const work_supplied = workSuppliedByFaction.get(f.id) ?? 0;
    const work_unsupplied = workUnsuppliedByFaction.get(f.id) ?? 0;
    const total_work = work_supplied + 2 * work_unsupplied;
    const inc = Math.floor(total_work / EXHAUSTION_WORK_DIVISOR);
    const after = before + inc;

    // Irreversible: never decrease.
    f.profile.exhaustion = after;

    per_faction.push({
      faction_id: f.id,
      exhaustion_before: before,
      exhaustion_after: after,
      delta: inc,
      work_supplied,
      work_unsupplied
    });
  }

  return { per_faction };
}

