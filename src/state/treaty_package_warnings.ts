/**
 * Phase 12B: Package validity warnings (Dayton-like linkage, warnings only)
 *
 * Generates deterministic warnings for treaty packages.
 * Warnings do not block evaluation in 12B, but affect acceptance scoring.
 */

import type { TreatyDraft, TreatyAnnex } from './treaty.js';

export type PackageWarning =
  | 'territorial_requires_military_annex'
  | 'institutional_requires_military_annex'
  | 'institutional_requires_territorial_scope'
  | 'high_cost_without_monitoring';

/**
 * Compute deterministic package warnings for a treaty draft.
 * Warnings are returned in a fixed order.
 */
export function computePackageWarnings(draft: TreatyDraft): PackageWarning[] {
  const warnings: PackageWarning[] = [];

  // Group clauses by annex
  const hasMilitary = draft.clauses.some((c) => c.annex === 'military');
  const hasTerritorial = draft.clauses.some((c) => c.annex === 'territorial');
  const hasInstitutional = draft.clauses.some((c) => c.annex === 'institutional');

  // Check for territorial clauses without military annex
  if (hasTerritorial && !hasMilitary) {
    warnings.push('territorial_requires_military_annex');
  }

  // Check for institutional clauses without military annex
  if (hasInstitutional && !hasMilitary) {
    warnings.push('institutional_requires_military_annex');
  }

  // Check for institutional clauses with global scope without territorial scope
  const hasInstitutionalGlobal = draft.clauses.some(
    (c) => c.annex === 'institutional' && c.scope.kind === 'global'
  );
  if (hasInstitutionalGlobal && !hasTerritorial) {
    warnings.push('institutional_requires_territorial_scope');
  }

  // Check for high cost without robust monitoring
  const hasMonitoringRobust = draft.clauses.some((c) => c.kind === 'monitoring_robust');
  if (draft.totals.cost_total >= 15 && !hasMonitoringRobust) {
    warnings.push('high_cost_without_monitoring');
  }

  return warnings;
}
