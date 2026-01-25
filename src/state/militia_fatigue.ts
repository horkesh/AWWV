import type { GameState, MunicipalityId, FactionId } from './game_state.js';
import type { SettlementRecord } from '../map/settlements.js';
import { computeSupplyReachability } from './supply_reachability.js';
import { buildAdjacencyMap, type AdjacencyMap } from '../map/adjacency_map.js';
import type { EdgeRecord } from '../map/settlements.js';

/**
 * Per-municipality militia pool fatigue update record.
 */
export interface MilitiaFatigueRecord {
  mun_id: MunicipalityId;
  faction_id: FactionId | null;
  supplied: boolean;
  fatigue_before: number;
  fatigue_after: number;
}

/**
 * Per-faction militia fatigue totals.
 */
export interface MilitiaFatigueFactionTotals {
  faction_id: FactionId | 'null';
  pools_total: number;
  pools_supplied: number;
  pools_unsupplied: number;
  total_fatigue: number;
}

/**
 * Militia fatigue step report.
 */
export interface MilitiaFatigueStepReport {
  by_municipality: MilitiaFatigueRecord[];
  by_faction: MilitiaFatigueFactionTotals[];
}

/**
 * Determine if a municipality is supplied for a faction.
 *
 * A municipality is "supplied" for a faction if:
 * - at least one settlement in that municipality is reachable from that faction's supply sources
 * - determine municipal mapping via settlement.mun_code (which matches mun_id)
 *
 * Deterministic: iterate municipalities and settlements in sorted order.
 */
function isMunicipalitySupplied(
  factionId: FactionId,
  munId: MunicipalityId,
  settlements: Map<string, SettlementRecord>,
  reachableSettlements: Set<string>
): boolean {
  // Find all settlements in this municipality
  const munSettlements: string[] = [];
  for (const [sid, settlement] of settlements.entries()) {
    if (settlement.mun_code === munId) {
      munSettlements.push(sid);
    }
  }

  // Sort deterministically
  munSettlements.sort();

  // Check if at least one settlement in the municipality is reachable
  for (const sid of munSettlements) {
    if (reachableSettlements.has(sid)) {
      return true;
    }
  }

  return false;
}

/**
 * Update militia pool fatigue based on municipal supply status and faction exhaustion.
 *
 * Rules:
 * - For each militia pool where faction != null:
 *   - Determine municipality supplied boolean
 *   - If unsupplied: fatigue += 1 per turn
 *   - Additionally, when faction exhaustion increased this turn by X:
 *     - simplest: militia_pools with that faction each get +1 if exhaustion increased at all this turn
 *     - DO NOT use floats or proportional allocations unless fixed-point and clearly auditable
 */
export function updateMilitiaFatigue(
  state: GameState,
  settlements: Map<string, SettlementRecord>,
  settlementEdges: EdgeRecord[],
  exhaustionDeltas: Map<FactionId, number> // faction_id -> exhaustion delta this turn
): MilitiaFatigueStepReport {
  const militiaPools = (state as any).militia_pools as Record<string, any> | undefined;
  if (!militiaPools || typeof militiaPools !== 'object') {
    return { by_municipality: [], by_faction: [] };
  }

  // Compute supply reachability once
  const adjacencyMap = buildAdjacencyMap(settlementEdges);
  const supplyReport = computeSupplyReachability(state, adjacencyMap);

  // Build reachable sets by faction
  const reachableByFaction = new Map<FactionId, Set<string>>();
  for (const f of supplyReport.factions) {
    reachableByFaction.set(f.faction_id, new Set(f.reachable_controlled));
  }

  const records: MilitiaFatigueRecord[] = [];
  const factionTotals = new Map<FactionId | 'null', { pools_total: number; pools_supplied: number; pools_unsupplied: number; total_fatigue: number }>();

  const munIds = Object.keys(militiaPools).sort(); // deterministic ordering
  for (const munId of munIds) {
    const pool = militiaPools[munId];
    if (!pool || typeof pool !== 'object') continue;

    const factionId = pool.faction;
    if (factionId === null || factionId === undefined) continue; // only process pools with faction

    if (typeof factionId !== 'string') continue; // defensive

    // Ensure fatigue field exists
    if (!Number.isInteger(pool.fatigue) || pool.fatigue < 0) {
      pool.fatigue = 0;
    }

    const fatigueBefore = pool.fatigue;
    const reachableSettlements = reachableByFaction.get(factionId) ?? new Set<string>();
    const supplied = isMunicipalitySupplied(factionId, munId, settlements, reachableSettlements);

    let fatigueAfter = fatigueBefore;

    // If unsupplied: fatigue += 1 per turn
    if (!supplied) {
      fatigueAfter += 1;
    }

    // Additionally, if faction exhaustion increased this turn: add +1 to each pool with that faction
    const exhaustionDelta = exhaustionDeltas.get(factionId) ?? 0;
    if (exhaustionDelta > 0) {
      fatigueAfter += 1;
    }

    pool.fatigue = fatigueAfter;

    records.push({
      mun_id: munId,
      faction_id: factionId,
      supplied,
      fatigue_before: fatigueBefore,
      fatigue_after: fatigueAfter
    });

    // Update faction totals
    const totals = factionTotals.get(factionId) ?? { pools_total: 0, pools_supplied: 0, pools_unsupplied: 0, total_fatigue: 0 };
    totals.pools_total += 1;
    if (supplied) {
      totals.pools_supplied += 1;
    } else {
      totals.pools_unsupplied += 1;
    }
    totals.total_fatigue += fatigueAfter;
    factionTotals.set(factionId, totals);
  }

  // Build sorted faction totals array
  const byFaction: MilitiaFatigueFactionTotals[] = Array.from(factionTotals.entries())
    .sort((a, b) => {
      if (a[0] === 'null' && b[0] !== 'null') return 1;
      if (a[0] !== 'null' && b[0] === 'null') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([faction_id, totals]) => ({
      faction_id: faction_id === 'null' ? 'null' : faction_id,
      pools_total: totals.pools_total,
      pools_supplied: totals.pools_supplied,
      pools_unsupplied: totals.pools_unsupplied,
      total_fatigue: totals.total_fatigue
    }));

  // Sort records deterministically
  records.sort((a, b) => {
    const mc = a.mun_id.localeCompare(b.mun_id);
    if (mc !== 0) return mc;
    const fa = a.faction_id ?? '';
    const fb = b.faction_id ?? '';
    return fa.localeCompare(fb);
  });

  return { by_municipality: records, by_faction: byFaction };
}
