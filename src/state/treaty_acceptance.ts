/**
 * Phase 12B: Acceptance calculator (deterministic, auditable)
 *
 * Computes acceptance scores for each target faction based on:
 * - BaseWill + PressureFactor + RealityFactor + GuaranteeFactor
 *   - CostFactor - HumiliationFactor - WarningPenalty
 *
 * All components are integers, deterministic.
 */

import type { GameState, FactionId } from './game_state.js';
import type { TreatyDraft } from './treaty.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { FormationFatigueStepReport } from './formation_fatigue.js';
import { getSettlementSide } from '../map/front_edges.js';
import { computeSettlementValues } from './territorial_valuation.js';
import type { LoadedSettlementGraph } from '../map/settlements.js';
import type { TerritorialValuationReport } from './territorial_valuation.js';
import { isClauseDeprecated } from './treaty_clause_library.js';
import { applyAcceptanceConstraints } from './acceptance_constraints.js';
import { computeCompetenceUtility } from './competence_valuations.js';

export interface AcceptanceBreakdown {
  base_will: number;
  pressure_factor: number;
  reality_factor: number;
  guarantee_factor: number;
  cost_factor: number;
  humiliation_factor: number;
  warning_penalty: number;
  heldness_factor: number; // Phase 12C.0: negative impact when giving up controlled settlements
  trade_fairness_factor: number; // Phase 12C.4: positive impact when ceding low-value-to-you territory
  competence_factor: number; // Phase 15: utility from competence allocations
  total_score: number;
}

export interface TargetAcceptance {
  faction_id: FactionId;
  accept: boolean;
  breakdown: AcceptanceBreakdown;
  reasons: string[]; // deterministic order
}

/** Phase 13B.0/13B.1: Deterministic rejection diagnostics when constraints gate acceptance */
export interface RejectionDetails {
  constraint_type: 'require_bundle' | 'require_brcko_resolution' | 'forbid_competence' | 'forbid_holder';
  competences?: string[];
  competence?: string;
  faction?: string;
  holder?: string;
}

export interface TreatyAcceptanceReport {
  treaty_id: string;
  turn: number;
  proposer_faction_id: FactionId;
  per_target: TargetAcceptance[];
  accepted_by_all_targets: boolean;
  rejecting_factions: FactionId[];
  /** Phase 13B.0: Stable string when rejected (e.g. competence_bundle_incomplete) */
  rejection_reason?: string;
  /** Phase 13B.0: Inspectable constraint violation details */
  rejection_details?: RejectionDetails;
  warnings: string[];
  totals: {
    cost_total: number;
    acceptance_impact_total: number;
    enforcement_burden_total: number;
  };
}

/**
 * Compute front stability proxies from front segments.
 */
function computeFrontStabilityProxies(
  state: GameState,
  activeEdgeIds: string[]
): { avg_friction: number; max_active_streak: number } {
  let totalFriction = 0;
  let maxStreak = 0;
  let activeCount = 0;

  for (const edgeId of activeEdgeIds) {
    const seg = state.front_segments?.[edgeId];
    if (seg && typeof seg === 'object' && (seg as any).active === true) {
      activeCount += 1;
      const friction = Number.isInteger((seg as any).friction) ? (seg as any).friction : 0;
      totalFriction += friction;
      const streak = Number.isInteger((seg as any).max_active_streak) ? (seg as any).max_active_streak : 0;
      if (streak > maxStreak) maxStreak = streak;
    }
  }

  const avgFriction = activeCount > 0 ? Math.floor((totalFriction / activeCount) * 100) / 100 : 0;

  return {
    avg_friction: avgFriction,
    max_active_streak: maxStreak
  };
}

/**
 * Compute acceptance score for a target faction.
 *
 * Phase 12C.4: Optional valuation for TradeFairnessFactor.
 */
function computeAcceptanceScore(
  state: GameState,
  draft: TreatyDraft,
  targetFactionId: FactionId,
  proposerFactionId: FactionId,
  formationFatigueReport: FormationFatigueStepReport | undefined,
  activeEdgeIds: string[],
  valuation?: TerritorialValuationReport
): { breakdown: AcceptanceBreakdown; reasons: string[] } {
  const targetFaction = state.factions.find((f) => f.id === targetFactionId);
  const proposerFaction = state.factions.find((f) => f.id === proposerFactionId);

  if (!targetFaction || !proposerFaction) {
    throw new Error(`Faction not found: ${targetFactionId} or ${proposerFactionId}`);
  }

  const targetPressure = targetFaction.negotiation?.pressure ?? 0;
  const proposerPressure = proposerFaction.negotiation?.pressure ?? 0;

  // BaseWill: 0
  const baseWill = 0;

  // PressureFactor: floor(target_pressure / 5)
  const pressureFactor = Math.floor(targetPressure / 5);

  // RealityFactor: if target has higher pressure than proposer => +1 else 0
  const realityFactor = targetPressure > proposerPressure ? 1 : 0;

  // GuaranteeFactor: +2 if monitoring_robust present, +1 if monitoring_light present, +0 otherwise
  const hasMonitoringRobust = draft.clauses.some((c) => c.kind === 'monitoring_robust');
  const hasMonitoringLight = draft.clauses.some((c) => c.kind === 'monitoring_light');
  let guaranteeFactor = 0;
  if (hasMonitoringRobust) {
    guaranteeFactor = 2;
  } else if (hasMonitoringLight) {
    guaranteeFactor = 1;
  }

  // CostFactor: acceptance_impact_total (negative)
  const costFactor = -draft.totals.acceptance_impact_total;

  // HumiliationFactor: +2 if cost_total >= 10 else 0
  const humiliationFactor = draft.totals.cost_total >= 10 ? 2 : 0;

  // WarningPenalty: +2 for each package warning (cap at 6)
  const warningPenalty = Math.min(draft.package_warnings.length * 2, 6);

  // HeldnessFactor (Phase 12C.0): negative impact when target is giver in transfer_settlements clauses
  let heldnessFactor = 0;
  for (const clause of draft.clauses) {
    if (clause.kind === 'transfer_settlements' && clause.giver_side === targetFactionId && clause.scope.kind === 'settlements') {
      // Count settlements currently controlled by target
      let controlledCount = 0;
      for (const sid of clause.scope.sids) {
        const controller = getSettlementSide(state, sid);
        if (controller === targetFactionId) {
          controlledCount += 1;
        }
      }
      heldnessFactor -= controlledCount;
    }
  }
  // Cap at -6 per target per treaty
  heldnessFactor = Math.max(heldnessFactor, -6);

  // TradeFairnessFactor (Phase 12C.4): positive impact when ceding low-value-to-you territory
  let tradeFairnessFactor = 0;
  if (valuation) {
    for (const clause of draft.clauses) {
      if (
        clause.kind === 'transfer_settlements' &&
        clause.giver_side === targetFactionId &&
        clause.receiver_side &&
        clause.scope.kind === 'settlements'
      ) {
        let totalLiability = 0;
        for (const sid of clause.scope.sids) {
          const valuationEntry = valuation.per_settlement.find((e) => e.sid === sid);
          if (valuationEntry) {
            const valueToGiver = valuationEntry.by_side[targetFactionId] ?? 0;
            const valueToReceiver = valuationEntry.by_side[clause.receiver_side] ?? 0;
            const liability = Math.max(0, valueToGiver - valueToReceiver);
            totalLiability += liability;
          }
        }
        // Bonus when liability is low (territory is less valuable to you than to them)
        tradeFairnessFactor += Math.min(4, Math.floor(totalLiability / 20));
      }
    }
  }

  // CompetenceFactor (Phase 15): utility from competence allocations
  let competenceFactor = 0;
  const competenceClauses = draft.clauses.filter((c) => c.kind === 'allocate_competence');
  if (competenceClauses.length > 0) {
    const allocations: Array<{ competence: string; holder: string }> = [];
    for (const c of competenceClauses) {
      if (c.competence && c.holder) {
        allocations.push({ competence: c.competence, holder: c.holder });
      }
    }
    // Only compute if targetFactionId is a valid political side (for valuation lookup)
    if (targetFactionId === 'RBiH' || targetFactionId === 'RS' || targetFactionId === 'HRHB') {
      competenceFactor = computeCompetenceUtility(allocations, targetFactionId);
    }
  }

  // Total score
  const totalScore =
    baseWill +
    pressureFactor +
    realityFactor +
    guaranteeFactor +
    costFactor -
    humiliationFactor -
    warningPenalty +
    heldnessFactor +
    tradeFairnessFactor +
    competenceFactor;

  // Generate reasons (deterministic order)
  const reasons: string[] = [];
  if (pressureFactor > 0) {
    reasons.push(`pressure_factor_+${pressureFactor}`);
  }
  if (realityFactor > 0) {
    reasons.push('reality_factor_+1');
  }
  if (guaranteeFactor > 0) {
    reasons.push(`guarantee_factor_+${guaranteeFactor}`);
  }
  if (costFactor < 0) {
    reasons.push(`cost_factor_${costFactor}`);
  }
  if (humiliationFactor > 0) {
    reasons.push(`humiliation_factor_-${humiliationFactor}`);
  }
  if (warningPenalty > 0) {
    reasons.push(`warning_penalty_-${warningPenalty}`);
  }
  if (heldnessFactor < 0) {
    reasons.push(`heldness_factor_${heldnessFactor}`);
  }
  if (tradeFairnessFactor > 0) {
    reasons.push(`trade_fairness_factor_+${tradeFairnessFactor}`);
  }
  if (competenceFactor !== 0) {
    if (competenceFactor > 0) {
      reasons.push(`competence_factor_+${competenceFactor}`);
    } else {
      reasons.push(`competence_factor_${competenceFactor}`);
    }
  }
  if (reasons.length === 0) {
    reasons.push('no_factors');
  }

  return {
      breakdown: {
        base_will: baseWill,
        pressure_factor: pressureFactor,
        reality_factor: realityFactor,
        guarantee_factor: guaranteeFactor,
        cost_factor: costFactor,
        humiliation_factor: humiliationFactor,
        warning_penalty: warningPenalty,
        heldness_factor: heldnessFactor,
        trade_fairness_factor: tradeFairnessFactor,
        competence_factor: competenceFactor,
        total_score: totalScore
      },
    reasons
  };
}

/**
 * Evaluate treaty acceptance for all target factions.
 *
 * Phase 12C.4: Optional settlement graph for valuation computation.
 * Phase 12D.1: Rejects treaties containing deprecated clauses.
 */
export function evaluateTreatyAcceptance(
  state: GameState,
  draft: TreatyDraft,
  derivedFrontEdges: FrontEdge[],
  formationFatigueReport: FormationFatigueStepReport | undefined,
  settlementsGraph?: LoadedSettlementGraph
): TreatyAcceptanceReport {
  // Phase 12D.1: Check for deprecated clauses
  const deprecatedClauses = draft.clauses.filter((c) => isClauseDeprecated(c.kind));
  if (deprecatedClauses.length > 0) {
    // Reject treaty if it contains any deprecated clauses
    const allTargetIds = new Set<FactionId>();
    for (const clause of draft.clauses) {
      for (const targetId of clause.target_faction_ids) {
        allTargetIds.add(targetId);
      }
    }
    const sortedTargetIds = Array.from(allTargetIds).sort();
    
    // All targets reject with reason "contains_deprecated_clause"
    const perTarget: TargetAcceptance[] = sortedTargetIds.map((targetId) => ({
      faction_id: targetId,
      accept: false,
      breakdown: {
        base_will: 0,
        pressure_factor: 0,
        reality_factor: 0,
        guarantee_factor: 0,
        cost_factor: 0,
        humiliation_factor: 0,
        warning_penalty: 0,
        heldness_factor: 0,
        trade_fairness_factor: 0,
        competence_factor: 0,
        total_score: -1 // Negative to ensure rejection
      },
      reasons: ['contains_deprecated_clause']
    }));

    return {
      treaty_id: draft.treaty_id,
      turn: draft.turn,
      proposer_faction_id: draft.proposer_faction_id,
      per_target: perTarget,
      accepted_by_all_targets: false,
      rejecting_factions: sortedTargetIds,
      warnings: draft.package_warnings,
      totals: draft.totals
    };
  }

  // Collect all unique target faction IDs (sorted)
  const allTargetIds = new Set<FactionId>();
  for (const clause of draft.clauses) {
    for (const targetId of clause.target_faction_ids) {
      allTargetIds.add(targetId);
    }
  }
  const sortedTargetIds = Array.from(allTargetIds).sort();

  // Get active edge IDs for stability proxies
  const activeEdgeIds = derivedFrontEdges.map((e) => e.edge_id);

  // Phase 12C.4: Compute valuation if we have transfer_settlements clauses and graph available
  const hasTransferClauses = draft.clauses.some((c) => c.kind === 'transfer_settlements');
  let valuation: TerritorialValuationReport | undefined;
  if (hasTransferClauses && settlementsGraph) {
    valuation = computeSettlementValues(state, settlementsGraph);
  }

  // Compute acceptance for each target
  const perTarget: TargetAcceptance[] = [];
  for (const targetId of sortedTargetIds) {
    const { breakdown, reasons } = computeAcceptanceScore(
      state,
      draft,
      targetId,
      draft.proposer_faction_id,
      formationFatigueReport,
      activeEdgeIds,
      valuation
    );

    const accept = breakdown.total_score >= 0;

    perTarget.push({
      faction_id: targetId,
      accept,
      breakdown,
      reasons
    });
  }

  // Determine if all targets accept (baseline scoring)
  let acceptedByAll = perTarget.every((t) => t.accept);
  let rejectingFactions = perTarget.filter((t) => !t.accept).map((t) => t.faction_id);
  let rejectionReason: string | undefined;
  let rejectionDetails: TreatyAcceptanceReport['rejection_details'];

  // Phase 13B.0/13B.1: Apply structural constraints only when baseline would accept
  if (acceptedByAll) {
    const peaceTriggeringKinds = ['transfer_settlements', 'recognize_control_settlements', 'brcko_special_status'] as const;
    const wouldTriggerPeace = draft.clauses.some((c) => peaceTriggeringKinds.includes(c.kind as (typeof peaceTriggeringKinds)[number]));
    const hasBrckoResolution = draft.clauses.some((c) => c.kind === 'brcko_special_status');

    const competenceClauses = draft.clauses.filter((c) => c.kind === 'allocate_competence');
    const seen = new Set<string>();
    const allocations: Array<{ competence: string; holder: string }> = [];
    for (const c of competenceClauses) {
      if (c.competence && c.holder && !seen.has(c.competence)) {
        seen.add(c.competence);
        allocations.push({ competence: c.competence, holder: c.holder });
      }
    }
    const constraintResult = applyAcceptanceConstraints(allocations, {
      would_trigger_peace: wouldTriggerPeace,
      has_brcko_resolution: hasBrckoResolution
    });
    if (constraintResult.violated && constraintResult.rejection_reason && constraintResult.rejection_details) {
      acceptedByAll = false;
      rejectionReason = constraintResult.rejection_reason;
      rejectionDetails = constraintResult.rejection_details;
      rejectingFactions = sortedTargetIds;
      for (const t of perTarget) {
        (t as { accept: boolean }).accept = false;
      }
    }
  }

  return {
    treaty_id: draft.treaty_id,
    turn: draft.turn,
    proposer_faction_id: draft.proposer_faction_id,
    per_target: perTarget,
    accepted_by_all_targets: acceptedByAll,
    rejecting_factions: rejectingFactions,
    ...(rejectionReason !== undefined && { rejection_reason: rejectionReason }),
    ...(rejectionDetails !== undefined && { rejection_details: rejectionDetails }),
    warnings: draft.package_warnings,
    totals: draft.totals
  };
}
