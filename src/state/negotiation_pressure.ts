import type { GameState, FactionId } from './game_state.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { ExhaustionStats } from './exhaustion.js';
import type { FormationFatigueStepReport } from './formation_fatigue.js';
import type { MilitiaFatigueStepReport } from './militia_fatigue.js';
import type { SustainabilityStepReport } from './sustainability.js';
import { computeFrontBreaches } from './front_breaches.js';

/**
 * Per-faction negotiation pressure component breakdown.
 */
export interface NegotiationPressureComponents {
  faction_id: FactionId;
  pressure_before: number;
  pressure_after: number;
  delta: number;
  components: {
    exhaustion_delta: number;
    instability_breaches: number;
    supply_formations: number;
    supply_militia: number;
    sustainability_collapse: number; // Phase 22
  };
  total_increment: number;
}

/**
 * Negotiation pressure step report.
 */
export interface NegotiationPressureStepReport {
  per_faction: NegotiationPressureComponents[];
}

/**
 * Update negotiation pressure for all factions based on auditable inputs.
 *
 * Rules:
 * 1) Exhaustion driver: If faction exhaustion increased this turn by X, negotiation_pressure += X
 * 2) Instability driver: If there were N breach candidates for this faction's fronts this turn, negotiation_pressure += min(N, 3)
 * 3) Supply isolation driver:
 *    - If faction had U unsupplied active formations this turn, negotiation_pressure += floor(U / 5)
 *    - If faction had M unsupplied militia pools this turn, negotiation_pressure += floor(M / 10)
 * 4) Phase 22: Sustainability collapse driver:
 *    - For each collapsed municipality controlled by this faction, negotiation_pressure += 1 per turn
 *
 * All components are integers, deterministic, capped as specified.
 * Monotonic rule: negotiation_pressure never decreases.
 * Set last_change_turn if any increment occurred.
 */
export function updateNegotiationPressure(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  exhaustionReport: ExhaustionStats | undefined,
  formationFatigueReport: FormationFatigueStepReport | undefined,
  militiaFatigueReport: MilitiaFatigueStepReport | undefined,
  sustainabilityReport: SustainabilityStepReport | undefined
): NegotiationPressureStepReport {
  const currentTurn = state.meta.turn;
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));

  // Compute breach candidates (deterministic)
  const breaches = computeFrontBreaches(state, derivedFrontEdges);

  // Build breach count per faction (count breaches where faction is on either side)
  const breachCountByFaction = new Map<FactionId, number>();
  for (const f of factions) {
    breachCountByFaction.set(f.id, 0);
  }
  for (const breach of breaches) {
    if (typeof breach.side_a === 'string') {
      const count = breachCountByFaction.get(breach.side_a) ?? 0;
      breachCountByFaction.set(breach.side_a, count + 1);
    }
    if (typeof breach.side_b === 'string') {
      const count = breachCountByFaction.get(breach.side_b) ?? 0;
      breachCountByFaction.set(breach.side_b, count + 1);
    }
  }

  // Build exhaustion delta map
  const exhaustionDeltaByFaction = new Map<FactionId, number>();
  if (exhaustionReport) {
    for (const f of exhaustionReport.per_faction) {
      exhaustionDeltaByFaction.set(f.faction_id, f.delta);
    }
  }

  // Build unsupplied formation count per faction
  const unsuppliedFormationsByFaction = new Map<FactionId, number>();
  if (formationFatigueReport) {
    for (const f of formationFatigueReport.by_faction) {
      unsuppliedFormationsByFaction.set(f.faction_id, f.formations_unsupplied);
    }
  }

  // Build unsupplied militia pool count per faction
  const unsuppliedMilitiaByFaction = new Map<FactionId, number>();
  if (militiaFatigueReport) {
    for (const f of militiaFatigueReport.by_faction) {
      if (f.faction_id !== 'null') {
        unsuppliedMilitiaByFaction.set(f.faction_id, f.pools_unsupplied);
      }
    }
  }

  // Build collapsed municipality count per faction (Phase 22)
  const collapsedByFaction = new Map<FactionId, number>();
  if (sustainabilityReport) {
    for (const rec of sustainabilityReport.by_municipality) {
      if (rec.collapsed && rec.faction_id) {
        const count = collapsedByFaction.get(rec.faction_id) ?? 0;
        collapsedByFaction.set(rec.faction_id, count + 1);
      }
    }
  }

  const per_faction: NegotiationPressureComponents[] = [];

  for (const faction of factions) {
    // Ensure negotiation state exists
    if (!faction.negotiation || typeof faction.negotiation !== 'object') {
      faction.negotiation = { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null };
    }
    if (!Number.isInteger(faction.negotiation.pressure) || faction.negotiation.pressure < 0) {
      faction.negotiation.pressure = 0;
    }

    const pressureBefore = faction.negotiation.pressure;

    // Component 1: Exhaustion delta
    const exhaustionDelta = exhaustionDeltaByFaction.get(faction.id) ?? 0;
    const exhaustionIncrement = exhaustionDelta;

    // Component 2: Instability (breach count, capped at 3)
    const breachCount = breachCountByFaction.get(faction.id) ?? 0;
    const instabilityIncrement = Math.min(breachCount, 3);

    // Component 3: Supply isolation - formations
    const unsuppliedFormations = unsuppliedFormationsByFaction.get(faction.id) ?? 0;
    const supplyFormationsIncrement = Math.floor(unsuppliedFormations / 5);

    // Component 3: Supply isolation - militia pools
    const unsuppliedMilitia = unsuppliedMilitiaByFaction.get(faction.id) ?? 0;
    const supplyMilitiaIncrement = Math.floor(unsuppliedMilitia / 10);

    // Component 4: Sustainability collapse (Phase 22)
    const collapsedCount = collapsedByFaction.get(faction.id) ?? 0;
    const sustainabilityCollapseIncrement = collapsedCount; // 1 per collapsed municipality

    // Total increment
    const totalIncrement = exhaustionIncrement + instabilityIncrement + supplyFormationsIncrement + supplyMilitiaIncrement + sustainabilityCollapseIncrement;

    // Apply increment (monotonic: never decreases)
    const pressureAfter = pressureBefore + totalIncrement;
    faction.negotiation.pressure = pressureAfter;

    // Update last_change_turn if any increment occurred
    if (totalIncrement > 0) {
      faction.negotiation.last_change_turn = currentTurn;
    }

    per_faction.push({
      faction_id: faction.id,
      pressure_before: pressureBefore,
      pressure_after: pressureAfter,
      delta: totalIncrement,
      components: {
        exhaustion_delta: exhaustionIncrement,
        instability_breaches: instabilityIncrement,
        supply_formations: supplyFormationsIncrement,
        supply_militia: supplyMilitiaIncrement,
        sustainability_collapse: sustainabilityCollapseIncrement
      },
      total_increment: totalIncrement
    });
  }

  // Sort deterministically
  per_faction.sort((a, b) => a.faction_id.localeCompare(b.faction_id));

  return { per_faction };
}
