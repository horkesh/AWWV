/**
 * Phase 12D.1: End-state snapshot builder
 *
 * Creates a deterministic frozen snapshot of the game state at peace entry.
 * The snapshot includes canonical control outcomes and optional summaries.
 */

import { createHash } from 'node:crypto';
import type { GameState } from './game_state.js';
import type { EndStateSnapshot } from './game_state.js';
import { getEffectiveSettlementSide } from './control_effective.js';
import { BRCKO_CONTROLLER_ID } from './brcko.js';

/**
 * Build end-state snapshot from current game state.
 * Snapshot is deterministic, stable-sorted, and includes outcome_hash.
 * 
 * Phase 13A.0: Accepts optional competence allocations to include in snapshot.
 */
export function buildEndStateSnapshot(
  state: GameState,
  competenceAllocations?: Array<{ competence: string; holder: string }>
): EndStateSnapshot {
  const turn = state.meta.turn;

  // Collect all settlement controllers (sorted by sid ascending)
  const controllers: Array<[number, string]> = [];
  const controllerCounts = new Map<string, number>();

  // Get all settlements from control_overrides, control_recognition, and faction AoRs
  const allSids = new Set<string>();
  
  if (state.control_overrides) {
    for (const sid of Object.keys(state.control_overrides)) {
      allSids.add(sid);
    }
  }
  
  if (state.control_recognition) {
    for (const sid of Object.keys(state.control_recognition)) {
      allSids.add(sid);
    }
  }
  
  // Also include all settlements from faction AoRs
  for (const faction of state.factions) {
    if (faction.areasOfResponsibility && Array.isArray(faction.areasOfResponsibility)) {
      for (const sid of faction.areasOfResponsibility) {
        allSids.add(sid);
      }
    }
  }

  // Get effective control for each settlement
  for (const sid of Array.from(allSids).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const controller = getEffectiveSettlementSide(state, sid);
    if (controller) {
      const sidNum = parseInt(sid, 10);
      controllers.push([sidNum, controller]);
      const count = controllerCounts.get(controller) ?? 0;
      controllerCounts.set(controller, count + 1);
    }
  }

  // Build settlements_by_controller (sorted by controller_id ascending)
  const settlementsByController: Array<[string, number]> = Array.from(controllerCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([controller, count]) => [controller, count]);

  // Optional: exhaustion totals (if available in state)
  const exhaustionTotals: Array<[string, number]> | undefined = state.factions
    .map((f) => [f.id, f.profile.exhaustion] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Optional: negotiation spend (if available)
  const negotiationSpend: Array<{ side_id: string; category: string; amount: number }> | undefined = 
    state.negotiation_ledger
      ? state.negotiation_ledger
          .filter((entry) => entry.kind === 'spend')
          .map((entry) => ({
            side_id: entry.faction_id,
            category: entry.reason,
            amount: entry.amount
          }))
          .sort((a, b) => {
            const sideCmp = a.side_id.localeCompare(b.side_id);
            if (sideCmp !== 0) return sideCmp;
            const catCmp = a.category.localeCompare(b.category);
            if (catCmp !== 0) return catCmp;
            return a.amount - b.amount;
          })
      : undefined;

  // Phase 13A.0: Process competence allocations
  let competences: Array<{ competence: string; holder: string }> | undefined = undefined;
  if (competenceAllocations && competenceAllocations.length > 0) {
    // Sort by competence ID (already sorted, but ensure)
    competences = [...competenceAllocations].sort((a, b) => a.competence.localeCompare(b.competence));
  }

  // Build canonical snapshot object for hashing
  const canonicalSnapshot: any = {
    turn,
    controllers,
    settlements_by_controller: settlementsByController
  };

  if (exhaustionTotals) {
    canonicalSnapshot.exhaustion_totals = exhaustionTotals;
  }

  if (negotiationSpend) {
    canonicalSnapshot.negotiation_spend = negotiationSpend;
  }

  // Phase 13A.0: Include competences in canonical snapshot for hashing
  if (competences && competences.length > 0) {
    // Convert to array of tuples for canonical representation
    canonicalSnapshot.competences = competences.map((c) => [c.competence, c.holder]);
  }

  // Compute deterministic hash
  const snapshotJson = JSON.stringify(canonicalSnapshot);
  const hash = createHash('sha256').update(snapshotJson).digest('hex');

  return {
    turn,
    controllers,
    settlements_by_controller: settlementsByController,
    exhaustion_totals: exhaustionTotals,
    negotiation_spend: negotiationSpend,
    competences,
    outcome_hash: hash
  };
}
