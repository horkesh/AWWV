import type { GameState, FactionId, NegotiationLedgerEntry } from './game_state.js';
import type { NegotiationPressureStepReport } from './negotiation_pressure.js';
import type { FormationFatigueStepReport } from './formation_fatigue.js';
import type { AcceptanceReport } from './negotiation_offers.js';

/**
 * Per-faction negotiation capital component breakdown.
 */
export interface NegotiationCapitalComponents {
  faction_id: FactionId;
  capital_before: number;
  capital_gain: number;
  capital_after: number;
  components: {
    pressure_gain: number;
    supply_viability: number;
    diplomatic_momentum: number;
  };
}

/**
 * Negotiation capital step report.
 */
export interface NegotiationCapitalStepReport {
  per_faction: NegotiationCapitalComponents[];
  ledger_entries_added: number;
}

/**
 * Update negotiation capital for all factions based on auditable inputs.
 *
 * Capital gain rules (deterministic):
 * capital_gain = 0
 *   + floor(pressure_delta_this_turn / 2)          // pressure delta from negotiation pressure report
 *   + floor(supplied_active_formations / 10)       // "capacity to bargain" proxy
 *   + floor(accepted_offers_count_this_turn * 2)  // diplomatic momentum
 *
 * Caps:
 * - Per turn gain capped at 5 (min(capital_gain, 5)) to prevent runaway.
 *
 * Ledger reason strings (fixed set):
 * - "pressure_gain"
 * - "supply_viability"
 * - "diplomatic_momentum"
 *
 * Ledger id format:
 * - "NLED_<turn>_<faction_id>_<kind>_<seq>"
 * Where seq is 1..N within that faction+turn, deterministic order by reason.
 */
export function updateNegotiationCapital(
  state: GameState,
  negotiationPressureReport: NegotiationPressureStepReport | undefined,
  formationFatigueReport: FormationFatigueStepReport | undefined,
  acceptanceReport: AcceptanceReport | undefined
): NegotiationCapitalStepReport {
  const currentTurn = state.meta.turn;
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));

  // Ensure ledger exists
  if (!state.negotiation_ledger || !Array.isArray(state.negotiation_ledger)) {
    state.negotiation_ledger = [];
  }

  // Build pressure delta map
  const pressureDeltaByFaction = new Map<FactionId, number>();
  if (negotiationPressureReport) {
    for (const f of negotiationPressureReport.per_faction) {
      pressureDeltaByFaction.set(f.faction_id, f.delta);
    }
  }

  // Build supplied formations count per faction
  const suppliedFormationsByFaction = new Map<FactionId, number>();
  if (formationFatigueReport) {
    for (const f of formationFatigueReport.by_faction) {
      suppliedFormationsByFaction.set(f.faction_id, f.formations_supplied);
    }
  }

  // Count accepted offers this turn (only if acceptanceReport exists and accepted is true)
  const acceptedOffersCount = acceptanceReport && acceptanceReport.accepted ? 1 : 0;

  const per_faction: NegotiationCapitalComponents[] = [];
  let ledgerEntriesAdded = 0;

  for (const faction of factions) {
    // Ensure negotiation state exists with capital fields
    if (!faction.negotiation || typeof faction.negotiation !== 'object') {
      faction.negotiation = { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null };
    }
    if (!Number.isInteger(faction.negotiation.capital) || faction.negotiation.capital < 0) {
      faction.negotiation.capital = 0;
    }
    if (!Number.isInteger(faction.negotiation.spent_total) || faction.negotiation.spent_total < 0) {
      faction.negotiation.spent_total = 0;
    }

    const capitalBefore = faction.negotiation.capital;

    // Component 1: Pressure gain
    const pressureDelta = pressureDeltaByFaction.get(faction.id) ?? 0;
    const pressureGain = Math.floor(pressureDelta / 2);

    // Component 2: Supply viability
    const suppliedFormations = suppliedFormationsByFaction.get(faction.id) ?? 0;
    const supplyViability = Math.floor(suppliedFormations / 10);

    // Component 3: Diplomatic momentum (only if this faction was involved in accepted offer)
    // For simplicity in Phase 12A, if any offer was accepted, all factions get the bonus
    // (This is a placeholder; Phase 12B+ will track per-faction acceptance)
    const diplomaticMomentum = acceptedOffersCount > 0 ? Math.floor(acceptedOffersCount * 2) : 0;

    // Total gain (capped at 5 per turn)
    const totalGain = Math.min(pressureGain + supplyViability + diplomaticMomentum, 5);

    // Apply gain
    const capitalAfter = capitalBefore + totalGain;
    faction.negotiation.capital = capitalAfter;

    // Update last_capital_change_turn if any gain occurred
    if (totalGain > 0) {
      faction.negotiation.last_capital_change_turn = currentTurn;
    }

    // Append ledger entries only when delta != 0
    if (totalGain > 0) {
      // Determine sequence numbers by reason (deterministic order)
      const reasons: Array<{ reason: string; amount: number }> = [];
      if (pressureGain > 0) {
        reasons.push({ reason: 'pressure_gain', amount: pressureGain });
      }
      if (supplyViability > 0) {
        reasons.push({ reason: 'supply_viability', amount: supplyViability });
      }
      if (diplomaticMomentum > 0) {
        reasons.push({ reason: 'diplomatic_momentum', amount: diplomaticMomentum });
      }

      // Sort reasons deterministically
      reasons.sort((a, b) => a.reason.localeCompare(b.reason));

      // Create ledger entries
      for (let seq = 1; seq <= reasons.length; seq += 1) {
        const { reason, amount } = reasons[seq - 1];
        const ledgerId = `NLED_${currentTurn}_${faction.id}_gain_${seq}`;
        const entry: NegotiationLedgerEntry = {
          id: ledgerId,
          turn: currentTurn,
          faction_id: faction.id,
          kind: 'gain',
          amount,
          reason
        };
        state.negotiation_ledger.push(entry);
        ledgerEntriesAdded += 1;
      }
    }

    per_faction.push({
      faction_id: faction.id,
      capital_before: capitalBefore,
      capital_gain: totalGain,
      capital_after: capitalAfter,
      components: {
        pressure_gain: pressureGain,
        supply_viability: supplyViability,
        diplomatic_momentum: diplomaticMomentum
      }
    });
  }

  // Sort deterministically
  per_faction.sort((a, b) => a.faction_id.localeCompare(b.faction_id));

  return { per_faction, ledger_entries_added: ledgerEntriesAdded };
}

/**
 * Spend negotiation capital for a faction (ledger-only, no treaty effects in Phase 12A).
 *
 * Rules:
 * - If amount > capital => error
 * - capital -= amount
 * - spent_total += amount
 * - append ledger entry kind="spend", reason="pre_treaty_reserve"
 */
export function spendNegotiationCapital(
  state: GameState,
  factionId: FactionId,
  amount: number,
  reason: string
): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid amount: ${amount} (must be integer >= 0)`);
  }

  const faction = state.factions.find((f) => f.id === factionId);
  if (!faction) {
    throw new Error(`Faction not found: ${factionId}`);
  }

  // Ensure negotiation state exists
  if (!faction.negotiation || typeof faction.negotiation !== 'object') {
    faction.negotiation = { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null };
  }
  if (!Number.isInteger(faction.negotiation.capital) || faction.negotiation.capital < 0) {
    faction.negotiation.capital = 0;
  }
  if (!Number.isInteger(faction.negotiation.spent_total) || faction.negotiation.spent_total < 0) {
    faction.negotiation.spent_total = 0;
  }

  if (amount > faction.negotiation.capital) {
    throw new Error(`Insufficient capital: requested ${amount}, available ${faction.negotiation.capital}`);
  }

  // Validate reason is in fixed set
  const validReasons = ['pre_treaty_reserve'];
  if (!validReasons.includes(reason)) {
    throw new Error(`Invalid reason: ${reason} (must be one of: ${validReasons.join(', ')})`);
  }

  const currentTurn = state.meta.turn;

  // Deduct capital
  faction.negotiation.capital -= amount;
  faction.negotiation.spent_total += amount;
  faction.negotiation.last_capital_change_turn = currentTurn;

  // Ensure ledger exists
  if (!state.negotiation_ledger || !Array.isArray(state.negotiation_ledger)) {
    state.negotiation_ledger = [];
  }

  // Append ledger entry
  const ledgerId = `NLED_${currentTurn}_${factionId}_spend_1`;
  const entry: NegotiationLedgerEntry = {
    id: ledgerId,
    turn: currentTurn,
    faction_id: factionId,
    kind: 'spend',
    amount,
    reason
  };
  state.negotiation_ledger.push(entry);
}
