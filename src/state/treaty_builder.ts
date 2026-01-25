/**
 * Phase 12B: Treaty builder utilities
 *
 * Helper functions for creating and sorting treaty drafts.
 */

import type { TreatyClause, TreatyDraft, TreatyScope } from './treaty.js';
import { computeClauseCost, computeClauseAcceptanceImpact, getClauseEnforcementBurden } from './treaty_clause_library.js';
import { computePackageWarnings } from './treaty_package_warnings.js';

/**
 * Generate deterministic scope hash for sorting.
 */
function generateScopeHash(scope: TreatyScope): string {
  if (scope.kind === 'global') {
    return 'GLOBAL';
  } else if (scope.kind === 'region') {
    return `REGION_${scope.region_id}`;
  } else if (scope.kind === 'edges') {
    const sorted = [...scope.edge_ids].sort();
    return `EDGES_${sorted.join('|')}`;
  } else if (scope.kind === 'settlements') {
    const sorted = [...scope.sids].sort();
    return `SETTLEMENTS_${sorted.join('|')}`;
  } else {
    // municipalities
    const sorted = [...scope.mun_ids].sort();
    return `MUNICIPALITIES_${sorted.join('|')}`;
  }
}

/**
 * Sort clauses deterministically: by annex, then kind, then scope hash, then id.
 */
function sortClauses(clauses: TreatyClause[]): TreatyClause[] {
  return [...clauses].sort((a, b) => {
    // First by annex
    const annexOrder: Record<string, number> = { military: 0, territorial: 1, institutional: 2 };
    const annexDiff = (annexOrder[a.annex] ?? 999) - (annexOrder[b.annex] ?? 999);
    if (annexDiff !== 0) return annexDiff;

    // Then by kind
    const kindDiff = a.kind.localeCompare(b.kind);
    if (kindDiff !== 0) return kindDiff;

    // Then by scope hash
    const scopeHashA = generateScopeHash(a.scope);
    const scopeHashB = generateScopeHash(b.scope);
    const scopeDiff = scopeHashA.localeCompare(scopeHashB);
    if (scopeDiff !== 0) return scopeDiff;

    // Finally by id
    return a.id.localeCompare(b.id);
  });
}

/**
 * Generate deterministic treaty ID from sorted clause IDs.
 */
function generateTreatyId(clauses: TreatyClause[]): string {
  const sortedIds = clauses.map((c) => c.id).sort();
  const combined = sortedIds.join('|');
  // Simple hash: take first 32 chars, replace non-alphanumeric
  const hash = combined.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 32);
  return `TREATY_${hash}`;
}

/**
 * Build a treaty draft from clauses.
 */
export function buildTreatyDraft(
  turn: number,
  proposerFactionId: string,
  clauses: TreatyClause[]
): TreatyDraft {
  // Sort clauses deterministically
  const sortedClauses = sortClauses(clauses);

  // Compute totals
  const costTotal = sortedClauses.reduce((sum, c) => sum + c.cost, 0);
  const acceptanceImpactTotal = sortedClauses.reduce((sum, c) => sum + c.acceptance_impact, 0);
  const enforcementBurdenTotal = sortedClauses.reduce((sum, c) => sum + c.enforcement_burden, 0);

  // Generate treaty ID
  const treatyId = generateTreatyId(sortedClauses);

  // Create draft
  const draft: TreatyDraft = {
    schema: 1,
    turn,
    treaty_id: treatyId,
    proposer_faction_id: proposerFactionId,
    clauses: sortedClauses,
    totals: {
      cost_total: costTotal,
      acceptance_impact_total: acceptanceImpactTotal,
      enforcement_burden_total: enforcementBurdenTotal
    },
    package_warnings: []
  };

  // Compute warnings
  draft.package_warnings = computePackageWarnings(draft);

  return draft;
}

/**
 * Create a clause from parameters.
 *
 * Phase 12C.4: Optional valuation data for transfer_settlements pricing.
 */
export function createClause(
  id: string,
  annex: TreatyClause['annex'],
  kind: TreatyClause['kind'],
  proposerFactionId: string,
  targetFactionIds: string[],
  scope: TreatyScope,
  tags?: string[],
  giverSide?: string,
  receiverSide?: string,
  beneficiary?: string,
  valuationOpts?: { valuation?: any; giver_side?: string; receiver_side?: string },
  competence?: string, // Phase 13A.0: CompetenceId for allocate_competence
  holder?: string // Phase 13A.0: Holder for allocate_competence
): TreatyClause {
  // Sort and deduplicate target faction IDs
  const sortedTargets = Array.from(new Set(targetFactionIds)).sort();

  // Compute costs (Phase 12C.4: pass valuation if available)
  const cost = computeClauseCost(kind, scope, valuationOpts);
  const acceptanceImpact = computeClauseAcceptanceImpact(kind, scope, valuationOpts);
  const enforcementBurden = getClauseEnforcementBurden(kind, scope);

  // Normalize tags
  const normalizedTags = tags
    ? Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))).sort()
    : undefined;

  return {
    id,
    annex,
    kind,
    proposer_faction_id: proposerFactionId,
    target_faction_ids: sortedTargets,
    scope,
    cost,
    acceptance_impact: acceptanceImpact,
    enforcement_burden: enforcementBurden,
    tags: normalizedTags,
    giver_side: giverSide,
    receiver_side: receiverSide,
    beneficiary,
    competence, // Phase 13A.0
    holder // Phase 13A.0
  };
}
