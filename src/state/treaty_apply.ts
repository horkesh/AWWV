/**
 * Phase 12C.1: Apply treaty military annex clauses to game state
 * Phase 12C.2: Apply treaty territorial annex clauses (transfer_settlements, recognize_control_settlements)
 *
 * Applies military clauses to ceasefire freeze system.
 * Applies territorial clauses to control_overrides and control_recognition.
 */

import type { GameState, SettlementId, PoliticalSideId, NegotiationLedgerEntry, SupplyRightsState, SupplyCorridorRight } from './game_state.js';
import type { TreatyDraft, TreatyClause, TreatyScope } from './treaty.js';
import type { TreatyAcceptanceReport } from './treaty_acceptance.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import { getEffectiveSettlementSide } from './control_effective.js';
import type { LoadedSettlementGraph } from '../map/settlements.js';
import { isClauseDeprecated } from './treaty_clause_library.js';
import { BRCKO_SIDS, BRCKO_CONTROLLER_ID } from './brcko.js';
import { buildEndStateSnapshot } from './end_state_snapshot.js';
import { ALL_COMPETENCES, isValidCompetence } from './competences.js';

export interface TreatyApplyReport {
  schema: 1 | 2 | 3;
  turn: number;
  treaty_id: string;
  applied: boolean;
  reason?: string; // fixed string if not applied
  military: {
    freeze_edges_added: number;
    freeze_edges_total: number;
    monitoring_level: 'none' | 'light' | 'robust';
    duration_turns: number | 'indefinite';
  };
  freeze_edges: string[]; // sorted unique final applied set
  territorial?: {
    applied_transfers: number;
    applied_recognitions: number;
    spent_capital: number;
    transfers: Array<{
      sid: string;
      from: PoliticalSideId;
      to: PoliticalSideId;
      kind: 'transfer';
    }>;
    recognitions: Array<{
      sid: string;
      side: PoliticalSideId;
      kind: 'recognition';
    }>;
    failures?: string[]; // fixed reason codes, sorted
    applied_brcko?: number; // Phase 12D.1: count of Brčko settlements with special status applied
  };
  corridor?: {
    applied_corridors: number;
    spent_capital: number;
    corridors: Array<{
      id: string;
      beneficiary: PoliticalSideId;
      scope_kind: string;
    }>;
    failures?: string[]; // fixed reason codes, sorted
  };
  end_state?: {
    set: boolean;
    kind?: 'peace_treaty';
    treaty_id?: string;
    since_turn?: number;
    reason?: string; // if not set, e.g. "no_territorial_effects" or "already_in_end_state"
    outcome_hash?: string; // Phase 12D.1: snapshot outcome_hash if snapshot exists
    settlements_by_controller?: Record<string, number>; // Phase 12D.1: for human readability only, build deterministically from sorted totals
  };
  warnings: string[]; // sorted
}

interface ApplyOptions {
  derivedFrontEdges?: FrontEdge[];
  frontRegions?: FrontRegionsFile;
  settlementGraph?: LoadedSettlementGraph;
}

/**
 * Apply treaty military annex clauses to game state.
 * Only applies if treaty is accepted by all targets and turn matches.
 */
export function applyTreatyMilitaryAnnex(
  state: GameState,
  treatyDraft: TreatyDraft,
  treatyEval: TreatyAcceptanceReport,
  opts: ApplyOptions = {}
): { state: GameState; report: TreatyApplyReport } {
  const currentTurn = state.meta.turn;
  const warnings: string[] = [];

  // Check if treaty should be applied
  if (!treatyEval.accepted_by_all_targets) {
    return {
      state,
      report: {
        schema: 1,
        turn: currentTurn,
        treaty_id: treatyDraft.treaty_id,
        applied: false,
        reason: 'not_accepted_by_all_targets',
        military: {
          freeze_edges_added: 0,
          freeze_edges_total: 0,
          monitoring_level: 'none',
          duration_turns: 0
        },
        freeze_edges: [],
        warnings: []
      }
    };
  }

  if (treatyDraft.turn !== currentTurn) {
    return {
      state,
      report: {
        schema: 1,
        turn: currentTurn,
        treaty_id: treatyDraft.treaty_id,
        applied: false,
        reason: 'turn_mismatch',
        military: {
          freeze_edges_added: 0,
          freeze_edges_total: 0,
          monitoring_level: 'none',
          duration_turns: 0
        },
        freeze_edges: [],
        warnings: []
      }
    };
  }

  // Filter to only military clauses
  const militaryClauses = treatyDraft.clauses.filter((c) => c.annex === 'military');
  if (militaryClauses.length === 0) {
    return {
      state,
      report: {
        schema: 1,
        turn: currentTurn,
        treaty_id: treatyDraft.treaty_id,
        applied: false,
        reason: 'no_military_clauses',
        military: {
          freeze_edges_added: 0,
          freeze_edges_total: 0,
          monitoring_level: 'none',
          duration_turns: 0
        },
        freeze_edges: [],
        warnings: []
      }
    };
  }

  // Determine monitoring level
  const hasMonitoringRobust = militaryClauses.some((c) => c.kind === 'monitoring_robust');
  const hasMonitoringLight = militaryClauses.some((c) => c.kind === 'monitoring_light');
  const monitoringLevel: 'none' | 'light' | 'robust' = hasMonitoringRobust ? 'robust' : hasMonitoringLight ? 'light' : 'none';

  // Get active front edges (sorted)
  const derivedFrontEdges = opts.derivedFrontEdges ?? [];
  const activeEdgeIds = new Set<string>();
  for (const edge of derivedFrontEdges) {
    const seg = state.front_segments?.[edge.edge_id];
    if (seg && typeof seg === 'object' && (seg as any).active === true) {
      activeEdgeIds.add(edge.edge_id);
    }
  }
  const sortedActiveEdgeIds = Array.from(activeEdgeIds).sort();

  // Collect edges to freeze
  const edgesToFreeze = new Set<string>();

  // Process ceasefire_global: freeze all active edges
  const globalClauses = militaryClauses.filter((c) => c.kind === 'ceasefire_global');
  if (globalClauses.length > 0) {
    for (const edgeId of sortedActiveEdgeIds) {
      edgesToFreeze.add(edgeId);
    }
  }

  // Process freeze_region: freeze active edges in specified regions
  const regionClauses = militaryClauses.filter((c) => c.kind === 'freeze_region');
  if (regionClauses.length > 0 && opts.frontRegions) {
    const regionById = new Map<string, string[]>();
    for (const region of opts.frontRegions.regions ?? []) {
      if (region && typeof region === 'object' && typeof (region as any).region_id === 'string') {
        const edgeIds = Array.isArray((region as any).edge_ids) ? (region as any).edge_ids : [];
        regionById.set((region as any).region_id, edgeIds);
      }
    }

    for (const clause of regionClauses) {
      if (clause.scope.kind === 'region') {
        const regionEdgeIds = regionById.get(clause.scope.region_id) ?? [];
        for (const edgeId of regionEdgeIds) {
          if (activeEdgeIds.has(edgeId)) {
            edgesToFreeze.add(edgeId);
          }
        }
      }
    }
  }

  // Process freeze_edges: freeze specified edges
  const edgeClauses = militaryClauses.filter((c) => c.kind === 'freeze_edges');
  for (const clause of edgeClauses) {
    if (clause.scope.kind === 'edges') {
      for (const edgeId of clause.scope.edge_ids) {
        if (activeEdgeIds.has(edgeId)) {
          edgesToFreeze.add(edgeId);
        } else {
          warnings.push(`edge_not_active:${edgeId}`);
        }
      }
    }
  }

  // Initialize ceasefire if needed
  if (!state.ceasefire || typeof state.ceasefire !== 'object') {
    state.ceasefire = {};
  }

  // Initialize negotiation_status if needed
  if (!state.negotiation_status || typeof state.negotiation_status !== 'object') {
    state.negotiation_status = { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null };
  }

  // Determine base durations for each edge to freeze
  // Priority: global (indefinite) > region (6 turns) > edges (4 turns)
  const baseDurations = new Map<string, number | null>();

  // First, mark all edges frozen by global ceasefire as indefinite
  if (globalClauses.length > 0) {
    for (const edgeId of Array.from(edgesToFreeze).sort()) {
      baseDurations.set(edgeId, null); // indefinite
    }
  }

  // Then, mark edges frozen by region clauses (6 turns, unless already indefinite)
  for (const clause of regionClauses) {
    if (clause.scope.kind === 'region' && opts.frontRegions) {
      const regionId = clause.scope.region_id;
      const regionEdgeIds = opts.frontRegions.regions
        ?.find((r) => (r as any).region_id === regionId)
        ?.edge_ids ?? [];
      for (const edgeId of regionEdgeIds) {
        if (edgesToFreeze.has(edgeId) && !baseDurations.has(edgeId)) {
          baseDurations.set(edgeId, 6);
        }
      }
    }
  }

  // Finally, mark edges frozen by edge clauses (4 turns, unless already set)
  for (const clause of edgeClauses) {
    if (clause.scope.kind === 'edges') {
      for (const edgeId of clause.scope.edge_ids) {
        if (edgesToFreeze.has(edgeId) && !baseDurations.has(edgeId)) {
          baseDurations.set(edgeId, 4);
        }
      }
    }
  }

  // Ensure all edges to freeze have a duration (default to 4 if somehow missing)
  for (const edgeId of edgesToFreeze) {
    if (!baseDurations.has(edgeId)) {
      baseDurations.set(edgeId, 4);
    }
  }

  // Apply monitoring duration modifications
  // none: duration stays as above
  // light: +2 turns for finite freezes, indefinite unchanged
  // robust: +4 turns for finite freezes, indefinite unchanged
  const finalDurations = new Map<string, number | null>();
  for (const [edgeId, baseDuration] of baseDurations.entries()) {
    if (baseDuration === null) {
      // Indefinite stays indefinite
      finalDurations.set(edgeId, null);
    } else {
      // Apply monitoring bonus
      if (monitoringLevel === 'light') {
        finalDurations.set(edgeId, baseDuration + 2);
      } else if (monitoringLevel === 'robust') {
        finalDurations.set(edgeId, baseDuration + 4);
      } else {
        finalDurations.set(edgeId, baseDuration);
      }
    }
  }

  // Merge with existing freeze entries deterministically
  let freezeEdgesAdded = 0;
  for (const edgeId of Array.from(edgesToFreeze).sort()) {
    const existing = state.ceasefire[edgeId];
    const newDuration = finalDurations.get(edgeId) ?? null;
    const newUntilTurn = newDuration === null ? null : currentTurn + newDuration;

    if (!existing) {
      // New freeze entry
      state.ceasefire[edgeId] = {
        since_turn: currentTurn,
        until_turn: newUntilTurn
      };
      freezeEdgesAdded += 1;
    } else {
      // Merge: keep earliest since_turn, extend until_turn if new one is later (null wins as indefinite)
      const existingSinceTurn = Number.isInteger(existing.since_turn) ? existing.since_turn : currentTurn;
      const existingUntilTurn = existing.until_turn;

      const mergedSinceTurn = Math.min(existingSinceTurn, currentTurn);
      let mergedUntilTurn: number | null;
      if (newUntilTurn === null || existingUntilTurn === null) {
        // null (indefinite) wins
        mergedUntilTurn = null;
      } else {
        // Take the later one
        mergedUntilTurn = Math.max(existingUntilTurn, newUntilTurn);
      }

      state.ceasefire[edgeId] = {
        since_turn: mergedSinceTurn,
        until_turn: mergedUntilTurn
      };

      // Count as added if this is a new freeze (not just extension)
      if (existingUntilTurn === null || existingUntilTurn <= currentTurn) {
        freezeEdgesAdded += 1;
      }
    }
  }

  // Update negotiation status
  state.negotiation_status.ceasefire_active = true;
  state.negotiation_status.last_offer_turn = currentTurn;

  // Get final sorted list of frozen edges
  const finalFrozenEdges = Object.keys(state.ceasefire ?? {})
    .filter((edgeId) => {
      const entry = state.ceasefire?.[edgeId];
      if (!entry || typeof entry !== 'object') return false;
      const untilTurn = entry.until_turn;
      // Include if indefinite or not yet expired
      return untilTurn === null || untilTurn > currentTurn;
    })
    .sort();

  // Determine overall duration for report
  const allDurations = Array.from(finalDurations.values());
  const hasAnyIndefinite = allDurations.some((d) => d === null);
  const maxFiniteDuration = allDurations.filter((d) => d !== null).reduce((max, d) => Math.max(max, d ?? 0), 0);
  const durationTurns: number | 'indefinite' = hasAnyIndefinite ? 'indefinite' : maxFiniteDuration;

  // Sort warnings
  warnings.sort();

  return {
    state,
    report: {
      schema: 1,
      turn: currentTurn,
      treaty_id: treatyDraft.treaty_id,
      applied: true,
      military: {
        freeze_edges_added: freezeEdgesAdded,
        freeze_edges_total: finalFrozenEdges.length,
        monitoring_level: monitoringLevel,
        duration_turns: durationTurns
      },
      freeze_edges: finalFrozenEdges,
      warnings
    }
  };
}

/**
 * Get next sequence number for negotiation ledger entry.
 * Deterministic: count existing entries for this turn/faction/kind, then increment.
 */
function getNextLedgerSeq(
  state: GameState,
  turn: number,
  factionId: string,
  kind: 'gain' | 'spend' | 'adjust'
): number {
  if (!state.negotiation_ledger || !Array.isArray(state.negotiation_ledger)) {
    return 1;
  }
  const matching = state.negotiation_ledger.filter(
    (e) => e.turn === turn && e.faction_id === factionId && e.kind === kind
  );
  return matching.length + 1;
}

/**
 * Phase 12C.2: Apply treaty territorial annex clauses to game state.
 *
 * Applies ONLY territorial clauses:
 * - transfer_settlements (giver_side → receiver_side for sids list)
 * - recognize_control_settlements (recognition only, no ownership transfer)
 *
 * Preconditions:
 * - accepted_by_all_targets must be true
 * - treatyDraft.turn must equal state.meta.turn
 * - Proposer must have sufficient negotiation capital
 *
 * Effects:
 * - Creates control_overrides entries for transfers
 * - Creates control_recognition entries for transfers and recognitions
 * - Spends proposer negotiation capital
 */
export function applyTreatyTerritorialAnnex(
  state: GameState,
  treatyDraft: TreatyDraft,
  treatyEval: TreatyAcceptanceReport,
  opts: ApplyOptions = {}
): { state: GameState; report: TreatyApplyReport['territorial'] } {
  const currentTurn = state.meta.turn;
  const warnings: string[] = [];
  const failures: string[] = [];

  // Check if treaty should be applied
  if (!treatyEval.accepted_by_all_targets) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['not_accepted_by_all_targets']
      }
    };
  }

  if (treatyDraft.turn !== currentTurn) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['turn_mismatch']
      }
    };
  }

  // Filter to only territorial clauses
  const territorialClauses = treatyDraft.clauses.filter((c) => c.annex === 'territorial');
  if (territorialClauses.length === 0) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: []
      }
    };
  }

  // Validate settlement graph is available
  const settlementGraph = opts.settlementGraph;
  if (!settlementGraph) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['settlement_graph_required']
      }
    };
  }

  const validSettlementIds = new Set(settlementGraph.settlements.keys());

  // Initialize control_overrides and control_recognition if needed
  if (!state.control_overrides || typeof state.control_overrides !== 'object') {
    state.control_overrides = {};
  }
  if (!state.control_recognition || typeof state.control_recognition !== 'object') {
    state.control_recognition = {};
  }

  // Get proposer faction
  const proposerFaction = state.factions.find((f) => f.id === treatyDraft.proposer_faction_id);
  if (!proposerFaction) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['proposer_faction_not_found']
      }
    };
  }

  // Ensure negotiation state exists
  if (!proposerFaction.negotiation || typeof proposerFaction.negotiation !== 'object') {
    proposerFaction.negotiation = {
      pressure: 0,
      last_change_turn: null,
      capital: 0,
      spent_total: 0,
      last_capital_change_turn: null
    };
  }

  // Phase 12D.1: Validate that BRCKO_SIDS are not in normal territorial clauses
  for (const clause of territorialClauses) {
    if (clause.kind === 'transfer_settlements' || clause.kind === 'recognize_control_settlements') {
      if (clause.scope.kind === 'settlements') {
        for (const sid of clause.scope.sids) {
          const sidNum = parseInt(sid, 10);
          if (BRCKO_SIDS.includes(sidNum)) {
            failures.push(`brcko_requires_special_clause:${clause.id}:${sid}`);
            break; // One failure per clause is enough
          }
        }
      }
    }
  }
  
  // If validation failures, return early
  if (failures.length > 0) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: failures.sort()
      }
    };
  }

  // Calculate total cost for territorial clauses
  let totalCost = 0;
  for (const clause of territorialClauses) {
    if (clause.kind === 'transfer_settlements' || clause.kind === 'recognize_control_settlements' || clause.kind === 'brcko_special_status') {
      totalCost += clause.cost;
    } else {
      warnings.push(`unsupported_clause_skipped:${clause.kind}`);
    }
  }

  // Check if proposer has sufficient capital
  if (proposerFaction.negotiation.capital < totalCost) {
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['insufficient_capital']
      }
    };
  }

  // Phase 12D.1: Process brcko_special_status clauses first
  const brckoClauses = territorialClauses.filter((c) => c.kind === 'brcko_special_status');
  const appliedBrckoSids: string[] = [];
  
  for (const clause of brckoClauses) {
    if (clause.scope.kind !== 'settlements') {
      warnings.push(`brcko_clause_invalid_scope:${clause.id}`);
      continue;
    }

    // Phase 12D.1: Validate sids: must be omitted or equal to BRCKO_SIDS
    // If clause.sids is provided, it must match BRCKO_SIDS exactly
    const expectedSids = BRCKO_SIDS.map(String).sort();
    let clauseSids: string[];
    
    if (clause.sids && Array.isArray(clause.sids)) {
      // sids provided: must match BRCKO_SIDS exactly (sorted)
      clauseSids = clause.sids.map(String).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      if (clauseSids.length !== expectedSids.length || !clauseSids.every((sid, i) => sid === expectedSids[i])) {
        failures.push(`brcko_invalid_sids:${clause.id}`);
        continue;
      }
    } else {
      // sids omitted: use default BRCKO_SIDS
      clauseSids = expectedSids;
    }

    // Apply Brčko special status: set control to BRCKO_CONTROLLER_ID
    for (const sid of clauseSids) {
      if (!validSettlementIds.has(sid)) {
        failures.push(`brcko_invalid_sid:${sid}`);
        continue;
      }

      // Set control override to BRCKO_CONTROLLER_ID
      state.control_overrides![sid] = {
        side: BRCKO_CONTROLLER_ID,
        kind: 'treaty_transfer',
        treaty_id: treatyDraft.treaty_id,
        since_turn: currentTurn
      };

      // Also write recognition
      state.control_recognition![sid] = {
        side: BRCKO_CONTROLLER_ID,
        treaty_id: treatyDraft.treaty_id,
        since_turn: currentTurn
      };

      appliedBrckoSids.push(sid);
    }
  }

  // Process transfer_settlements clauses
  const transferClauses = territorialClauses.filter((c) => c.kind === 'transfer_settlements');
  const appliedTransfers: Array<{ sid: string; from: PoliticalSideId; to: PoliticalSideId; kind: 'transfer' }> = [];
  const infeasibleSids: string[] = [];

  for (const clause of transferClauses) {
    if (clause.scope.kind !== 'settlements') {
      warnings.push(`transfer_clause_invalid_scope:${clause.id}`);
      continue;
    }

    if (!clause.giver_side || !clause.receiver_side) {
      failures.push(`transfer_missing_sides:${clause.id}`);
      continue;
    }

    if (clause.giver_side === clause.receiver_side) {
      failures.push(`transfer_same_sides:${clause.id}`);
      continue;
    }

    // Validate giver and receiver are valid factions
    const giverFaction = state.factions.find((f) => f.id === clause.giver_side);
    const receiverFaction = state.factions.find((f) => f.id === clause.receiver_side);
    if (!giverFaction || !receiverFaction) {
      failures.push(`transfer_invalid_faction:${clause.id}`);
      continue;
    }

    const sids = clause.scope.sids;
    if (!Array.isArray(sids) || sids.length === 0) {
      warnings.push(`transfer_empty_sids:${clause.id}`);
      continue;
    }

    // Validate all sids exist and check feasibility
    for (const sid of sids) {
      if (typeof sid !== 'string') {
        infeasibleSids.push(sid);
        continue;
      }

      if (!validSettlementIds.has(sid)) {
        infeasibleSids.push(sid);
        continue;
      }

      // Check handover feasibility: giver must be in effective control
      const effectiveControl = getEffectiveSettlementSide(state, sid);
      if (effectiveControl !== clause.giver_side) {
        infeasibleSids.push(sid);
        continue;
      }

      // Apply transfer
      state.control_overrides![sid] = {
        side: clause.receiver_side,
        kind: 'treaty_transfer',
        treaty_id: treatyDraft.treaty_id,
        since_turn: currentTurn
      };

      // Also write recognition
      state.control_recognition![sid] = {
        side: clause.receiver_side,
        treaty_id: treatyDraft.treaty_id,
        since_turn: currentTurn
      };

      appliedTransfers.push({
        sid,
        from: clause.giver_side,
        to: clause.receiver_side,
        kind: 'transfer'
      });
    }
  }

  // If any transfers were infeasible, fail the whole territorial apply
  if (infeasibleSids.length > 0) {
    // Rollback any transfers we already applied
    for (const transfer of appliedTransfers) {
      delete state.control_overrides![transfer.sid];
      delete state.control_recognition![transfer.sid];
    }
    return {
      state,
      report: {
        applied_transfers: 0,
        applied_recognitions: 0,
        spent_capital: 0,
        transfers: [],
        recognitions: [],
        failures: ['infeasible_transfer', ...infeasibleSids.map((sid) => `giver_not_in_effective_control:${sid}`)]
      }
    };
  }

  // Process recognize_control_settlements clauses
  const recognitionClauses = territorialClauses.filter((c) => c.kind === 'recognize_control_settlements');
  const appliedRecognitions: Array<{ sid: string; side: PoliticalSideId; kind: 'recognition' }> = [];

  for (const clause of recognitionClauses) {
    if (clause.scope.kind !== 'settlements') {
      warnings.push(`recognition_clause_invalid_scope:${clause.id}`);
      continue;
    }

    // Recognition recognizes settlements as belonging to proposer side
    const recognizedSide = treatyDraft.proposer_faction_id;
    const sids = clause.scope.sids;
    if (!Array.isArray(sids) || sids.length === 0) {
      warnings.push(`recognition_empty_sids:${clause.id}`);
      continue;
    }

    for (const sid of sids) {
      if (typeof sid !== 'string') {
        continue;
      }

      if (!validSettlementIds.has(sid)) {
        continue;
      }

      // Recognition only applies if effective control matches recognized side
      const effectiveControl = getEffectiveSettlementSide(state, sid);
      if (effectiveControl !== recognizedSide) {
        failures.push(`cannot_recognize_without_effective_control:${sid}`);
        continue;
      }

      // Apply recognition (recognition-only, no control override)
      state.control_recognition![sid] = {
        side: recognizedSide,
        treaty_id: treatyDraft.treaty_id,
        since_turn: currentTurn
      };

      appliedRecognitions.push({
        sid,
        side: recognizedSide,
        kind: 'recognition'
      });
    }
  }

  // Spend negotiation capital (only if we actually applied transfers, recognitions, or Brčko)
  const actuallyApplied = appliedTransfers.length > 0 || appliedRecognitions.length > 0 || appliedBrckoSids.length > 0;
  let actualSpent = 0;
  if (totalCost > 0 && actuallyApplied) {
    // Calculate actual cost based on what was applied
    let appliedCost = 0;
    for (const clause of territorialClauses) {
      if (clause.kind === 'transfer_settlements' && clause.scope.kind === 'settlements') {
        const clauseSids = clause.scope.sids;
        const appliedFromClause = appliedTransfers.filter((t) => clauseSids.includes(t.sid));
        if (appliedFromClause.length > 0) {
          appliedCost += clause.cost;
        }
      } else if (clause.kind === 'recognize_control_settlements' && clause.scope.kind === 'settlements') {
        const clauseSids = clause.scope.sids;
        const appliedFromClause = appliedRecognitions.filter((r) => clauseSids.includes(r.sid));
        if (appliedFromClause.length > 0) {
          appliedCost += clause.cost;
        }
      } else if (clause.kind === 'brcko_special_status') {
        // Phase 12D.1: Brčko clause cost is included if any Brčko settlements were applied
        if (appliedBrckoSids.length > 0) {
          appliedCost += clause.cost;
        }
      }
    }
    
    // Phase 13A.0: Add competence allocation costs (only if peace is triggered)
    // Note: Competence costs are spent when end_state is set, not here
    // This is handled separately in the main applyTreaty function

    if (appliedCost > 0) {
      proposerFaction.negotiation.capital -= appliedCost;
      proposerFaction.negotiation.spent_total += appliedCost;
      proposerFaction.negotiation.last_capital_change_turn = currentTurn;

      // Ensure ledger exists
      if (!state.negotiation_ledger || !Array.isArray(state.negotiation_ledger)) {
        state.negotiation_ledger = [];
      }

      // Append ledger entry
      const seq = getNextLedgerSeq(state, currentTurn, treatyDraft.proposer_faction_id, 'spend');
      const ledgerId = `NLED_${currentTurn}_${treatyDraft.proposer_faction_id}_spend_treaty_territory_${seq}`;
      const entry: NegotiationLedgerEntry = {
        id: ledgerId,
        turn: currentTurn,
        faction_id: treatyDraft.proposer_faction_id,
        kind: 'spend',
        amount: appliedCost,
        reason: 'treaty_territory'
      };
      state.negotiation_ledger.push(entry);
      actualSpent = appliedCost;
    }
  }

  // Sort results deterministically
  appliedTransfers.sort((a, b) => a.sid.localeCompare(b.sid));
  appliedRecognitions.sort((a, b) => a.sid.localeCompare(b.sid));
  failures.sort();
  const uniqueFailures = Array.from(new Set(failures));

  // Phase 12D.1: Include Brčko applied count in report
  return {
    state,
    report: {
      applied_transfers: appliedTransfers.length,
      applied_recognitions: appliedRecognitions.length,
      spent_capital: actualSpent,
      transfers: appliedTransfers,
      recognitions: appliedRecognitions,
      failures: uniqueFailures.length > 0 ? uniqueFailures : undefined,
      // Phase 12D.1: Brčko special status applied count (for end_state detection)
      applied_brcko: appliedBrckoSids.length
    }
  };
}

/**
 * Generate deterministic scope hash for corridor ID.
 */
function generateCorridorScopeHash(scope: { kind: 'region'; region_id: string } | { kind: 'edges'; edge_ids: string[] } | { kind: 'settlements'; sids: string[] }): string {
  if (scope.kind === 'region') {
    return scope.region_id.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16);
  } else if (scope.kind === 'edges') {
    const sorted = [...scope.edge_ids].sort();
    return sorted.join('|').replace(/[^a-zA-Z0-9|_]/g, '_').substring(0, 32);
  } else {
    // settlements
    const sorted = [...scope.sids].sort();
    return sorted.join('|').replace(/[^a-zA-Z0-9|_]/g, '_').substring(0, 32);
  }
}

/**
 * Phase 12C.3: Apply treaty corridor right-of-way clauses to game state.
 *
 * Applies ONLY corridor_right_of_way clauses:
 * - Creates supply_rights entries for corridor traversal rights
 * - Does NOT change control_overrides or control_recognition
 *
 * Preconditions:
 * - accepted_by_all_targets must be true
 * - treatyDraft.turn must equal state.meta.turn
 * - Proposer must have sufficient negotiation capital
 */
export function applyTreatyCorridorRights(
  state: GameState,
  treatyDraft: TreatyDraft,
  treatyEval: TreatyAcceptanceReport,
  opts: ApplyOptions = {}
): { state: GameState; report: { applied_corridors: number; spent_capital: number; corridors: Array<{ id: string; beneficiary: PoliticalSideId; scope_kind: string }>; failures?: string[] } } {
  const currentTurn = state.meta.turn;
  const failures: string[] = [];

  // Check if treaty should be applied
  if (!treatyEval.accepted_by_all_targets) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['not_accepted_by_all_targets']
      }
    };
  }

  if (treatyDraft.turn !== currentTurn) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['turn_mismatch']
      }
    };
  }

  // Filter to only corridor_right_of_way clauses
  // Phase 12D.1: Treat deprecated corridor clauses as no-op
  const corridorClauses = treatyDraft.clauses.filter((c) => c.kind === 'corridor_right_of_way' && c.annex === 'territorial');
  if (corridorClauses.length === 0) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: []
      }
    };
  }

  // Phase 12D.1: If all corridor clauses are deprecated, treat as no-op
  const allDeprecated = corridorClauses.every((c) => isClauseDeprecated(c.kind));
  if (allDeprecated) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['deprecated_clause_noop']
      }
    };
  }

  // Validate settlement graph is available for scope validation
  const settlementGraph = opts.settlementGraph;
  if (!settlementGraph) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['settlement_graph_required']
      }
    };
  }

  const validSettlementIds = new Set(settlementGraph.settlements.keys());
  const validEdgeIds = new Set<string>();
  for (const edge of settlementGraph.edges) {
    const edgeId = edge.a < edge.b ? `${edge.a}__${edge.b}` : `${edge.b}__${edge.a}`;
    validEdgeIds.add(edgeId);
  }

  // Initialize supply_rights if needed
  if (!state.supply_rights || typeof state.supply_rights !== 'object') {
    state.supply_rights = { corridors: [] };
  }
  if (!Array.isArray(state.supply_rights.corridors)) {
    state.supply_rights.corridors = [];
  }

  // Get proposer faction
  const proposerFaction = state.factions.find((f) => f.id === treatyDraft.proposer_faction_id);
  if (!proposerFaction) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['proposer_faction_not_found']
      }
    };
  }

  // Ensure negotiation state exists
  if (!proposerFaction.negotiation || typeof proposerFaction.negotiation !== 'object') {
    proposerFaction.negotiation = {
      pressure: 0,
      last_change_turn: null,
      capital: 0,
      spent_total: 0,
      last_capital_change_turn: null
    };
  }

  // Calculate total cost for corridor clauses
  let totalCost = 0;
  for (const clause of corridorClauses) {
    totalCost += clause.cost;
  }

  // Check if proposer has sufficient capital
  if (proposerFaction.negotiation.capital < totalCost) {
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: ['insufficient_capital']
      }
    };
  }

  // Determine monitoring level for duration calculation
  const militaryClauses = treatyDraft.clauses.filter((c) => c.annex === 'military');
  const hasMonitoringRobust = militaryClauses.some((c) => c.kind === 'monitoring_robust');
  const hasMonitoringLight = militaryClauses.some((c) => c.kind === 'monitoring_light');
  const monitoringLevel: 'none' | 'light' | 'robust' = hasMonitoringRobust ? 'robust' : hasMonitoringLight ? 'light' : 'none';

  // Base duration: 4 turns
  // Monitoring modifies: light +2, robust +4
  let baseDuration = 4;
  if (monitoringLevel === 'light') {
    baseDuration = 6;
  } else if (monitoringLevel === 'robust') {
    baseDuration = 8;
  }

  // Process corridor clauses
  const appliedCorridors: Array<{ id: string; beneficiary: PoliticalSideId; scope_kind: string }> = [];
  const corridorSeqByHash = new Map<string, number>();

  for (const clause of corridorClauses) {
    if (!clause.beneficiary) {
      failures.push(`corridor_missing_beneficiary:${clause.id}`);
      continue;
    }

    // Validate beneficiary is a valid faction
    const beneficiaryFaction = state.factions.find((f) => f.id === clause.beneficiary);
    if (!beneficiaryFaction) {
      failures.push(`corridor_invalid_beneficiary:${clause.id}`);
      continue;
    }

    // Validate scope
    let scope: { kind: 'region'; region_id: string } | { kind: 'edges'; edge_ids: string[] } | { kind: 'settlements'; sids: string[] };
    if (clause.scope.kind === 'region') {
      // Validate region exists if frontRegions provided
      if (opts.frontRegions) {
        const regionId = (clause.scope as { kind: 'region'; region_id: string }).region_id;
        const regionExists = opts.frontRegions.regions?.some((r: any) => (r as any).region_id === regionId);
        if (!regionExists) {
          failures.push(`corridor_invalid_region:${clause.id}`);
          continue;
        }
      }
      scope = { kind: 'region', region_id: (clause.scope as { kind: 'region'; region_id: string }).region_id };
    } else if (clause.scope.kind === 'edges') {
      // Validate all edge IDs exist
      const invalidEdges = clause.scope.edge_ids.filter((eid) => !validEdgeIds.has(eid));
      if (invalidEdges.length > 0) {
        failures.push(`corridor_invalid_edges:${clause.id}`);
        continue;
      }
      scope = { kind: 'edges', edge_ids: [...clause.scope.edge_ids].sort() };
    } else if (clause.scope.kind === 'settlements') {
      // Validate all settlement IDs exist
      const invalidSids = clause.scope.sids.filter((sid) => !validSettlementIds.has(sid));
      if (invalidSids.length > 0) {
        failures.push(`corridor_invalid_settlements:${clause.id}`);
        continue;
      }
      scope = { kind: 'settlements', sids: [...clause.scope.sids].sort() };
    } else {
      failures.push(`corridor_invalid_scope_kind:${clause.id}`);
      continue;
    }

    // Generate deterministic scope hash
    const scopeHash = generateCorridorScopeHash(scope);
    const key = `${clause.beneficiary}_${scopeHash}`;

    // Check for existing identical corridor (same beneficiary + same scope_hash)
    const existingIndex = state.supply_rights.corridors.findIndex(
      (c) => c.beneficiary === clause.beneficiary && generateCorridorScopeHash(c.scope) === scopeHash
    );

    if (existingIndex >= 0) {
      // Merge: extend until_turn if new is later, null wins
      const existing = state.supply_rights.corridors[existingIndex];
      const newUntilTurn = currentTurn + baseDuration;
      if (existing.until_turn === null) {
        existing.until_turn = null; // null (indefinite) wins
      } else {
        existing.until_turn = Math.max(existing.until_turn, newUntilTurn);
      }
      // Update treaty_id to latest
      existing.treaty_id = treatyDraft.treaty_id;
    } else {
      // Create new corridor right
      const seq = (corridorSeqByHash.get(key) ?? 0) + 1;
      corridorSeqByHash.set(key, seq);
      const corridorId = `COR_${currentTurn}_${clause.beneficiary}_${scopeHash}_${seq}`;
      const untilTurn = currentTurn + baseDuration;

      const corridor: SupplyCorridorRight = {
        id: corridorId,
        treaty_id: treatyDraft.treaty_id,
        beneficiary: clause.beneficiary,
        scope,
        since_turn: currentTurn,
        until_turn: untilTurn
      };

      state.supply_rights.corridors.push(corridor);
      appliedCorridors.push({
        id: corridorId,
        beneficiary: clause.beneficiary,
        scope_kind: scope.kind
      });
    }
  }

  // If any failures, rollback and fail
  if (failures.length > 0) {
    // Rollback any corridors we added
    for (const corridor of appliedCorridors) {
      const index = state.supply_rights.corridors.findIndex((c) => c.id === corridor.id);
      if (index >= 0) {
        state.supply_rights.corridors.splice(index, 1);
      }
    }
    return {
      state,
      report: {
        applied_corridors: 0,
        spent_capital: 0,
        corridors: [],
        failures: failures.sort()
      }
    };
  }

  // Spend negotiation capital (only if we actually applied corridors)
  let actualSpent = 0;
  if (totalCost > 0 && appliedCorridors.length > 0) {
    proposerFaction.negotiation.capital -= totalCost;
    proposerFaction.negotiation.spent_total += totalCost;
    proposerFaction.negotiation.last_capital_change_turn = currentTurn;

    // Ensure ledger exists
    if (!state.negotiation_ledger || !Array.isArray(state.negotiation_ledger)) {
      state.negotiation_ledger = [];
    }

    // Append ledger entry
    const seq = getNextLedgerSeq(state, currentTurn, treatyDraft.proposer_faction_id, 'spend');
    const ledgerId = `NLED_${currentTurn}_${treatyDraft.proposer_faction_id}_spend_treaty_corridor_${seq}`;
    const entry: NegotiationLedgerEntry = {
      id: ledgerId,
      turn: currentTurn,
      faction_id: treatyDraft.proposer_faction_id,
      kind: 'spend',
      amount: totalCost,
      reason: 'treaty_corridor'
    };
    state.negotiation_ledger.push(entry);
    actualSpent = totalCost;
  }

  // Ensure corridors are sorted by id (deterministic ordering)
  state.supply_rights.corridors.sort((a, b) => a.id.localeCompare(b.id));

  // Sort results deterministically
  appliedCorridors.sort((a, b) => a.id.localeCompare(b.id));

  return {
    state,
    report: {
      applied_corridors: appliedCorridors.length,
      spent_capital: actualSpent,
      corridors: appliedCorridors,
      failures: failures.length > 0 ? failures.sort() : undefined
    }
  };
}

/**
 * Apply treaty (military + territorial annexes + corridor rights).
 * Phase 12C.3: Now applies military, territorial, and corridor clauses.
 */
export function applyTreaty(
  state: GameState,
  treatyDraft: TreatyDraft,
  treatyEval: TreatyAcceptanceReport,
  opts: ApplyOptions = {}
): { state: GameState; report: TreatyApplyReport } {
  // Apply military annex first
  const militaryResult = applyTreatyMilitaryAnnex(state, treatyDraft, treatyEval, opts);

  // Apply territorial annex
  const territorialResult = applyTreatyTerritorialAnnex(militaryResult.state, treatyDraft, treatyEval, opts);

  // Apply corridor rights (Phase 12C.3)
  const corridorResult = applyTreatyCorridorRights(territorialResult.state, treatyDraft, treatyEval, opts);

  // Phase 13A.0: Collect competence allocations (validation only, no state mutation until peace)
  const competenceResult = collectCompetenceAllocations(corridorResult.state, treatyDraft, treatyEval);

  // Combine reports
  const territorialReport = territorialResult.report;
  const corridorReport = corridorResult.report;
  
  // Phase 12D.0: Determine if end_state should be set
  const currentTurn = corridorResult.state.meta.turn;
  let endStateSet = false;
  let endStateReason: string | undefined = undefined;
  
  // Check if end_state already exists
  if (corridorResult.state.end_state) {
    endStateReason = 'already_in_end_state';
  } else {
    // Phase 12D.1: Check if treaty has territorial effects (including Brčko) or corridor effects
    // Note: corridor_right_of_way is deprecated and does not trigger end_state
    const hasTerritorialEffects = 
      territorialReport && 
      (territorialReport.applied_transfers > 0 || 
       territorialReport.applied_recognitions > 0 || 
       (territorialReport.applied_brcko ?? 0) > 0) &&
      (!territorialReport.failures || territorialReport.failures.length === 0);
    
    // Phase 12D.1: corridor_right_of_way is deprecated and does not trigger end_state
    // Only non-deprecated corridor effects would trigger, but corridor_right_of_way is the only corridor type
    const hasCorridorEffects = false; // Deprecated clauses don't trigger end_state
    
    if (hasTerritorialEffects || hasCorridorEffects) {
      if (treatyEval.accepted_by_all_targets) {
        // Phase 13A.0: Spend capital for competence allocations
        const proposerFaction = corridorResult.state.factions.find((f) => f.id === treatyDraft.proposer_faction_id);
        if (proposerFaction && proposerFaction.negotiation && competenceResult.allocations.length > 0) {
          let competenceCost = 0;
          for (const clause of treatyDraft.clauses) {
            if (clause.kind === 'allocate_competence' && competenceResult.allocations.some((a) => a.competence === clause.competence)) {
              competenceCost += clause.cost;
            }
          }
          
          if (competenceCost > 0) {
            proposerFaction.negotiation.capital -= competenceCost;
            proposerFaction.negotiation.spent_total += competenceCost;
            proposerFaction.negotiation.last_capital_change_turn = currentTurn;
            
            // Ensure ledger exists
            if (!corridorResult.state.negotiation_ledger || !Array.isArray(corridorResult.state.negotiation_ledger)) {
              corridorResult.state.negotiation_ledger = [];
            }
            
            // Append ledger entry
            const seq = getNextLedgerSeq(corridorResult.state, currentTurn, treatyDraft.proposer_faction_id, 'spend');
            const ledgerId = `NLED_${currentTurn}_${treatyDraft.proposer_faction_id}_spend_treaty_competence_${seq}`;
            const entry: NegotiationLedgerEntry = {
              id: ledgerId,
              turn: currentTurn,
              faction_id: treatyDraft.proposer_faction_id,
              kind: 'spend',
              amount: competenceCost,
              reason: 'treaty_competence'
            };
            corridorResult.state.negotiation_ledger.push(entry);
          }
        }
        
        // Phase 12D.1: Set end_state and build snapshot
        // Phase 13A.0: Include competence allocations in snapshot
        corridorResult.state.end_state = {
          kind: 'peace_treaty',
          treaty_id: treatyDraft.treaty_id,
          since_turn: currentTurn
        };
        // Build snapshot from post-apply state with competence allocations
        const snapshot = buildEndStateSnapshot(corridorResult.state, competenceResult.allocations);
        corridorResult.state.end_state.snapshot = snapshot;
        endStateSet = true;
      }
    } else {
      endStateReason = 'no_territorial_effects';
    }
  }
  
  const report: TreatyApplyReport = {
    schema: 3,
    turn: militaryResult.report.turn,
    treaty_id: militaryResult.report.treaty_id,
    applied: militaryResult.report.applied && (territorialReport?.failures?.length ?? 0) === 0 && (corridorReport?.failures?.length ?? 0) === 0 && (competenceResult.failures.length === 0),
    reason: militaryResult.report.applied
      ? territorialReport?.failures && territorialReport.failures.length > 0
        ? territorialReport.failures[0]
        : corridorReport?.failures && corridorReport.failures.length > 0
        ? corridorReport.failures[0]
        : competenceResult.failures.length > 0
        ? competenceResult.failures[0]
        : undefined
      : militaryResult.report.reason,
    military: militaryResult.report.military,
    freeze_edges: militaryResult.report.freeze_edges,
    territorial: territorialReport,
    corridor: corridorReport,
    end_state: (() => {
      const base: TreatyApplyReport['end_state'] = {
        set: endStateSet,
        kind: endStateSet ? ('peace_treaty' as const) : undefined,
        treaty_id: endStateSet ? treatyDraft.treaty_id : undefined,
        since_turn: endStateSet ? currentTurn : undefined,
        reason: endStateReason
      };
      
      // Phase 12D.1: Add snapshot info if end_state was set
      if (endStateSet && corridorResult.state.end_state?.snapshot) {
        const snapshot = corridorResult.state.end_state.snapshot;
        base.outcome_hash = snapshot.outcome_hash;
        base.settlements_by_controller = Object.fromEntries(snapshot.settlements_by_controller);
      }
      
      return base;
    })(),
    warnings: [
      ...militaryResult.report.warnings,
      ...(opts.settlementGraph ? [] : ['settlement_graph_missing_for_territorial']),
      ...(opts.settlementGraph ? [] : ['settlement_graph_missing_for_corridor']),
      ...(competenceResult.failures.length > 0 ? competenceResult.failures : [])
    ]
  };

  return {
    state: corridorResult.state,
    report
  };
}

/**
 * Phase 13A.0: Collect and validate competence allocations from treaty.
 * Does NOT mutate state - competences are only applied when end_state is set.
 * Returns validated allocations and any validation failures.
 */
function collectCompetenceAllocations(
  state: GameState,
  treatyDraft: TreatyDraft,
  treatyEval: TreatyAcceptanceReport
): {
  allocations: Array<{ competence: string; holder: string }>;
  failures: string[];
} {
  const allocations: Array<{ competence: string; holder: string }> = [];
  const failures: string[] = [];
  const seenCompetences = new Set<string>();

  // Get all allocate_competence clauses
  const competenceClauses = treatyDraft.clauses.filter((c) => c.kind === 'allocate_competence');

  // Validate each clause
  for (const clause of competenceClauses) {
    // Validate competence field exists and is valid
    if (!clause.competence || typeof clause.competence !== 'string') {
      failures.push(`invalid_competence:${clause.id}:missing`);
      continue;
    }

    if (!isValidCompetence(clause.competence)) {
      failures.push(`invalid_competence:${clause.id}:${clause.competence}`);
      continue;
    }

    // Validate holder field exists and is non-empty
    if (!clause.holder || typeof clause.holder !== 'string' || clause.holder.trim().length === 0) {
      failures.push(`competence_missing_holder:${clause.id}`);
      continue;
    }

    // Check for duplicate competence allocation in same treaty
    if (seenCompetences.has(clause.competence)) {
      failures.push(`duplicate_competence_allocation:${clause.competence}`);
      continue;
    }

    // Validate that treaty has territorial effects (competences require peace)
    const hasTerritorialClauses = treatyDraft.clauses.some(
      (c) =>
        c.kind === 'transfer_settlements' ||
        c.kind === 'recognize_control_settlements' ||
        c.kind === 'brcko_special_status'
    );

    if (!hasTerritorialClauses) {
      failures.push(`competence_requires_peace:${clause.id}`);
      continue;
    }

    // All validations passed - collect allocation
    seenCompetences.add(clause.competence);
    allocations.push({
      competence: clause.competence,
      holder: clause.holder
    });
  }

  // Sort allocations by competence ID for deterministic ordering
  allocations.sort((a, b) => a.competence.localeCompare(b.competence));
  failures.sort();

  return {
    allocations,
    failures: failures.length > 0 ? failures : []
  };
}
