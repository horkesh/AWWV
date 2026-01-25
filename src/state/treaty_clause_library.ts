/**
 * Phase 12B: Treaty clause library with deterministic costing
 *
 * Provides templates for clause generation with base costs, acceptance impacts,
 * and enforcement burdens. All costs are integers and intentionally coarse.
 *
 * Phase 12C.4: transfer_settlements pricing now uses territorial valuation.
 */

import type { TreatyClause, TreatyClauseKind, TreatyScope } from './treaty.js';
import type { GameState } from './game_state.js';
import type { LoadedSettlementGraph } from '../map/settlements.js';
import type { TerritorialValuationReport } from './territorial_valuation.js';

export interface ClauseTemplate {
  base_cost: number;
  base_acceptance_impact: number;
  base_enforcement_burden: number;
  allowed_scope_kinds: TreatyScope['kind'][];
  // Phase 12D.1: Deprecation metadata
  deprecated?: boolean;
  deprecated_reason?: string;
}

const CLAUSE_TEMPLATES: Record<TreatyClauseKind, ClauseTemplate> = {
  // MILITARY
  ceasefire_global: {
    base_cost: 8,
    base_acceptance_impact: 6,
    base_enforcement_burden: 4,
    allowed_scope_kinds: ['global']
  },
  freeze_region: {
    base_cost: 4,
    base_acceptance_impact: 3,
    base_enforcement_burden: 2,
    allowed_scope_kinds: ['region']
  },
  freeze_edges: {
    base_cost: 3,
    base_acceptance_impact: 2,
    base_enforcement_burden: 1,
    allowed_scope_kinds: ['edges']
  },
  monitoring_light: {
    base_cost: 2,
    base_acceptance_impact: 1,
    base_enforcement_burden: 2,
    allowed_scope_kinds: ['global', 'region', 'edges']
  },
  monitoring_robust: {
    base_cost: 5,
    base_acceptance_impact: 2,
    base_enforcement_burden: 5,
    allowed_scope_kinds: ['global', 'region', 'edges']
  },
  // TERRITORIAL
  recognize_control_settlements: {
    base_cost: 1, // per settlement (cap 10)
    base_acceptance_impact: 1, // per settlement
    base_enforcement_burden: 1,
    allowed_scope_kinds: ['settlements']
  },
  corridor_right_of_way: {
    base_cost: 6,
    base_acceptance_impact: 4,
    base_enforcement_burden: 4,
    allowed_scope_kinds: ['region', 'edges', 'settlements'],
    deprecated: true,
    deprecated_reason: 'Peace ends the war, corridors are achieved via territorial settlement, corridor rights unused post-peace.'
  },
  transfer_settlements: {
    base_cost: 0, // computed dynamically: min(10, number_of_settlements) * 2
    base_acceptance_impact: 0, // computed dynamically: min(10, number_of_settlements) * 2
    base_enforcement_burden: 0, // computed dynamically: 2 + floor(number_of_settlements / 3)
    allowed_scope_kinds: ['settlements']
  },
  brcko_special_status: {
    base_cost: 10, // Phase 12D.1: Fixed high cost for special status
    base_acceptance_impact: 8, // Phase 12D.1: High acceptance impact
    base_enforcement_burden: 6, // Phase 12D.1: High enforcement burden
    allowed_scope_kinds: ['settlements']
  },
  // INSTITUTIONAL
  autonomy_municipal: {
    base_cost: 5,
    base_acceptance_impact: 4,
    base_enforcement_burden: 4,
    allowed_scope_kinds: ['municipalities']
  },
  autonomy_regional: {
    base_cost: 8,
    base_acceptance_impact: 6,
    base_enforcement_burden: 6,
    allowed_scope_kinds: ['region']
  },
  independence_pathway_step1: {
    base_cost: 12,
    base_acceptance_impact: 10,
    base_enforcement_burden: 10,
    allowed_scope_kinds: ['region']
  },
  // Phase 13A.0: allocate_competence clause
  allocate_competence: {
    base_cost: 5, // Fixed deterministic cost per competence allocation
    base_acceptance_impact: 4, // Fixed deterministic acceptance impact
    base_enforcement_burden: 3, // Fixed deterministic enforcement burden
    allowed_scope_kinds: ['global'] // Competences are global allocations
  }
};

/**
 * Get template for a clause kind.
 */
export function getClauseTemplate(kind: TreatyClauseKind): ClauseTemplate {
  const template = CLAUSE_TEMPLATES[kind];
  if (!template) {
    throw new Error(`Unknown clause kind: ${kind}`);
  }
  return template;
}

/**
 * Compute cost for a clause based on its kind and scope.
 * All scaling is deterministic, capped, and documented.
 *
 * Phase 12C.4: transfer_settlements uses valuation-based pricing if valuation provided.
 */
export function computeClauseCost(
  kind: TreatyClauseKind,
  scope: TreatyScope,
  opts?: {
    valuation?: TerritorialValuationReport;
    giver_side?: string;
    receiver_side?: string;
  }
): number {
  const template = getClauseTemplate(kind);

  // Check scope kind is allowed
  if (!template.allowed_scope_kinds.includes(scope.kind)) {
    throw new Error(`Clause kind ${kind} does not allow scope kind ${scope.kind}`);
  }

  // Base cost
  let cost = template.base_cost;

  // Special scaling for recognize_control_settlements
  if (kind === 'recognize_control_settlements' && scope.kind === 'settlements') {
    const settlementCount = scope.sids.length;
    const perSettlementCost = template.base_cost;
    cost = Math.min(settlementCount * perSettlementCost, 10); // cap at 10
  }

  // Special scaling for transfer_settlements
  if (kind === 'transfer_settlements' && scope.kind === 'settlements') {
    // Phase 12C.4: Use valuation-based pricing if available
    if (opts?.valuation && opts.giver_side && opts.receiver_side) {
      let totalDelta = 0;
      for (const sid of scope.sids) {
        const valuationEntry = opts.valuation.per_settlement.find((e) => e.sid === sid);
        if (valuationEntry) {
          const valueToReceiver = valuationEntry.by_side[opts.receiver_side] ?? 0;
          const valueToGiver = valuationEntry.by_side[opts.giver_side] ?? 0;
          const delta = Math.max(0, valueToReceiver - valueToGiver);
          totalDelta += delta;
        }
      }
      cost = Math.max(2, Math.min(30, Math.floor(totalDelta / 10) + scope.sids.length));
    } else {
      // Fallback to old formula
      const settlementCount = scope.sids.length;
      cost = Math.min(10, settlementCount) * 2;
    }
  }

  return cost;
}

/**
 * Compute acceptance impact for a clause based on its kind and scope.
 *
 * Phase 12C.4: transfer_settlements uses valuation-based pricing if valuation provided.
 */
export function computeClauseAcceptanceImpact(
  kind: TreatyClauseKind,
  scope: TreatyScope,
  opts?: {
    valuation?: TerritorialValuationReport;
    giver_side?: string;
    receiver_side?: string;
  }
): number {
  const template = getClauseTemplate(kind);

  // Base impact
  let impact = template.base_acceptance_impact;

  // Special scaling for recognize_control_settlements
  if (kind === 'recognize_control_settlements' && scope.kind === 'settlements') {
    const settlementCount = scope.sids.length;
    const perSettlementImpact = template.base_acceptance_impact;
    impact = settlementCount * perSettlementImpact; // no cap for impact
  }

  // Special scaling for transfer_settlements
  if (kind === 'transfer_settlements' && scope.kind === 'settlements') {
    // Phase 12C.4: Use valuation-based pricing if available
    if (opts?.valuation && opts.giver_side && opts.receiver_side) {
      let totalDelta = 0;
      for (const sid of scope.sids) {
        const valuationEntry = opts.valuation.per_settlement.find((e) => e.sid === sid);
        if (valuationEntry) {
          const valueToReceiver = valuationEntry.by_side[opts.receiver_side] ?? 0;
          const valueToGiver = valuationEntry.by_side[opts.giver_side] ?? 0;
          const delta = Math.max(0, valueToReceiver - valueToGiver);
          totalDelta += delta;
        }
      }
      impact = Math.max(2, Math.min(30, Math.floor(totalDelta / 8) + scope.sids.length));
    } else {
      // Fallback to old formula
      const settlementCount = scope.sids.length;
      impact = Math.min(10, settlementCount) * 2;
    }
  }

  return impact;
}

/**
 * Get enforcement burden for a clause (with scaling for transfer_settlements).
 */
export function getClauseEnforcementBurden(kind: TreatyClauseKind, scope?: TreatyScope): number {
  const template = getClauseTemplate(kind);
  let burden = template.base_enforcement_burden;

  // Special scaling for transfer_settlements
  if (kind === 'transfer_settlements' && scope?.kind === 'settlements') {
    const settlementCount = scope.sids.length;
    burden = 2 + Math.floor(settlementCount / 3);
  }

  return burden;
}

/**
 * Validate that a scope is compatible with a clause kind.
 */
export function validateClauseScope(kind: TreatyClauseKind, scope: TreatyScope): boolean {
  const template = getClauseTemplate(kind);
  return template.allowed_scope_kinds.includes(scope.kind);
}

/**
 * Phase 12D.1: Check if a clause kind is deprecated.
 */
export function isClauseDeprecated(kind: TreatyClauseKind): boolean {
  const template = getClauseTemplate(kind);
  return template.deprecated === true;
}
