/**
 * Phase 16: Tests for treaty UI guardrails and competence utility visualization
 * 
 * Tests bundle auto-completion, Brčko guard, deterministic ordering, and utility calculation.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { ALL_COMPETENCES, type CompetenceId } from '../src/state/competences.js';
import { COMPETENCE_VALUATIONS, computeCompetenceUtility } from '../src/state/competence_valuations.js';
import { ACCEPTANCE_CONSTRAINTS } from '../src/state/acceptance_constraints.js';
import type { TreatyDraft, TreatyClause } from '../src/state/treaty.js';
import { POLITICAL_SIDES } from '../src/state/identity.js';

// Phase 16: Helper functions (mirroring UI logic)
function getBundlePartner(competence: CompetenceId): CompetenceId | null {
  for (const constraint of ACCEPTANCE_CONSTRAINTS) {
    if (constraint.type === 'require_bundle' && constraint.competences.includes(competence)) {
      const partner = constraint.competences.find(c => c !== competence);
      return partner || null;
    }
  }
  return null;
}

function wouldTriggerPeace(draft: TreatyDraft | null): boolean {
  if (!draft) return false;
  const peaceTriggeringKinds = ['transfer_settlements', 'recognize_control_settlements', 'brcko_special_status'] as const;
  return draft.clauses.some(c => peaceTriggeringKinds.includes(c.kind as (typeof peaceTriggeringKinds)[number]));
}

function hasBrckoResolution(draft: TreatyDraft | null): boolean {
  if (!draft) return false;
  return draft.clauses.some(c => c.kind === 'brcko_special_status');
}

// Test bundle partner detection
test('dev_ui phase16: getBundlePartner returns correct partner for customs', () => {
  const partner = getBundlePartner('customs');
  assert.strictEqual(partner, 'indirect_taxation');
});

test('dev_ui phase16: getBundlePartner returns correct partner for indirect_taxation', () => {
  const partner = getBundlePartner('indirect_taxation');
  assert.strictEqual(partner, 'customs');
});

test('dev_ui phase16: getBundlePartner returns correct partner for defence_policy', () => {
  const partner = getBundlePartner('defence_policy');
  assert.strictEqual(partner, 'armed_forces_command');
});

test('dev_ui phase16: getBundlePartner returns correct partner for armed_forces_command', () => {
  const partner = getBundlePartner('armed_forces_command');
  assert.strictEqual(partner, 'defence_policy');
});

test('dev_ui phase16: getBundlePartner returns null for non-bundled competence', () => {
  const partner = getBundlePartner('border_control');
  assert.strictEqual(partner, null);
});

// Test peace-trigger detection
test('dev_ui phase16: wouldTriggerPeace detects transfer_settlements', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'transfer_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['1'] },
        cost: 5,
        acceptance_impact: 3,
        enforcement_burden: 2,
        giver_side: 'RS',
        receiver_side: 'RBiH'
      }
    ],
    totals: { cost_total: 5, acceptance_impact_total: 3, enforcement_burden_total: 2 },
    package_warnings: []
  };
  assert.strictEqual(wouldTriggerPeace(draft), true);
});

test('dev_ui phase16: wouldTriggerPeace detects recognize_control_settlements', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'recognize_control_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['1'] },
        cost: 5,
        acceptance_impact: 3,
        enforcement_burden: 2
      }
    ],
    totals: { cost_total: 5, acceptance_impact_total: 3, enforcement_burden_total: 2 },
    package_warnings: []
  };
  assert.strictEqual(wouldTriggerPeace(draft), true);
});

test('dev_ui phase16: wouldTriggerPeace detects brcko_special_status', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'brcko_special_status',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['1'] },
        cost: 10,
        acceptance_impact: 8,
        enforcement_burden: 6
      }
    ],
    totals: { cost_total: 10, acceptance_impact_total: 8, enforcement_burden_total: 6 },
    package_warnings: []
  };
  assert.strictEqual(wouldTriggerPeace(draft), true);
});

test('dev_ui phase16: wouldTriggerPeace returns false for military-only treaty', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'military',
        kind: 'freeze_region',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'region', region_id: 'R_001' },
        cost: 5,
        acceptance_impact: 3,
        enforcement_burden: 2
      }
    ],
    totals: { cost_total: 5, acceptance_impact_total: 3, enforcement_burden_total: 2 },
    package_warnings: []
  };
  assert.strictEqual(wouldTriggerPeace(draft), false);
});

test('dev_ui phase16: wouldTriggerPeace returns false for null draft', () => {
  assert.strictEqual(wouldTriggerPeace(null), false);
});

// Test Brčko resolution detection
test('dev_ui phase16: hasBrckoResolution detects brcko_special_status clause', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'brcko_special_status',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['1'] },
        cost: 10,
        acceptance_impact: 8,
        enforcement_burden: 6
      }
    ],
    totals: { cost_total: 10, acceptance_impact_total: 8, enforcement_burden_total: 6 },
    package_warnings: []
  };
  assert.strictEqual(hasBrckoResolution(draft), true);
});

test('dev_ui phase16: hasBrckoResolution returns false when no brcko clause', () => {
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'transfer_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['1'] },
        cost: 5,
        acceptance_impact: 3,
        enforcement_burden: 2,
        giver_side: 'RS',
        receiver_side: 'RBiH'
      }
    ],
    totals: { cost_total: 5, acceptance_impact_total: 3, enforcement_burden_total: 2 },
    package_warnings: []
  };
  assert.strictEqual(hasBrckoResolution(draft), false);
});

test('dev_ui phase16: hasBrckoResolution returns false for null draft', () => {
  assert.strictEqual(hasBrckoResolution(null), false);
});

// Test competence utility calculation
test('dev_ui phase16: computeCompetenceUtility matches Phase 15 tables exactly', () => {
  // Single competence allocation to RBiH
  const allocations = [{ competence: 'currency_authority', holder: 'RBiH' }];
  const utilityRBiH = computeCompetenceUtility(allocations, 'RBiH');
  const utilityRS = computeCompetenceUtility(allocations, 'RS');
  const utilityHRHB = computeCompetenceUtility(allocations, 'HRHB');
  
  // RBiH is the holder, so gets the valuation (10)
  assert.strictEqual(utilityRBiH, 10);
  // RS is not the holder, so gets 0
  assert.strictEqual(utilityRS, 0);
  // HRHB is not the holder, so gets 0
  assert.strictEqual(utilityHRHB, 0);
  
  // Verify against tables directly
  assert.strictEqual(COMPETENCE_VALUATIONS.RBiH.currency_authority, 10);
  assert.strictEqual(COMPETENCE_VALUATIONS.RS.currency_authority, -2);
  assert.strictEqual(COMPETENCE_VALUATIONS.HRHB.currency_authority, 2);
  
  // Test with RS as holder
  const allocationsRS = [{ competence: 'currency_authority', holder: 'RS' }];
  const utilityRSAsHolder = computeCompetenceUtility(allocationsRS, 'RS');
  assert.strictEqual(utilityRSAsHolder, -2); // RS gets -2 when it's the holder
});

test('dev_ui phase16: computeCompetenceUtility sums multiple allocations', () => {
  const allocations = [
    { competence: 'currency_authority', holder: 'RBiH' },
    { competence: 'police_internal_security', holder: 'RS' },
    { competence: 'education_policy', holder: 'HRHB' }
  ];
  
  const utilityRBiH = computeCompetenceUtility(allocations, 'RBiH');
  const utilityRS = computeCompetenceUtility(allocations, 'RS');
  const utilityHRHB = computeCompetenceUtility(allocations, 'HRHB');
  
  // RBiH only gets currency_authority (10)
  assert.strictEqual(utilityRBiH, 10);
  // RS only gets police_internal_security (8)
  assert.strictEqual(utilityRS, 8);
  // HRHB only gets education_policy (8)
  assert.strictEqual(utilityHRHB, 8);
});

test('dev_ui phase16: computeCompetenceUtility returns 0 for no allocations', () => {
  const allocations: Array<{ competence: string; holder: string }> = [];
  for (const faction of POLITICAL_SIDES) {
    assert.strictEqual(computeCompetenceUtility(allocations, faction), 0);
  }
});

test('dev_ui phase16: computeCompetenceUtility ignores allocations to other holders', () => {
  const allocations = [
    { competence: 'currency_authority', holder: 'RS' }, // Not RBiH
    { competence: 'police_internal_security', holder: 'HRHB' } // Not RBiH
  ];
  
  const utilityRBiH = computeCompetenceUtility(allocations, 'RBiH');
  assert.strictEqual(utilityRBiH, 0);
});

// Test deterministic ordering
test('dev_ui phase16: competence allocations sorted deterministically', () => {
  const allocations = [
    { competence: 'defence_policy' as CompetenceId, holder: 'RBiH' as const },
    { competence: 'customs' as CompetenceId, holder: 'RS' as const },
    { competence: 'armed_forces_command' as CompetenceId, holder: 'RBiH' as const },
    { competence: 'indirect_taxation' as CompetenceId, holder: 'RS' as const }
  ];
  
  // Sort by competence_id, then holder_id
  const sorted = [...allocations].sort((a, b) => {
    const compDiff = a.competence.localeCompare(b.competence);
    if (compDiff !== 0) return compDiff;
    return a.holder.localeCompare(b.holder);
  });
  
  // Expected order: armed_forces_command (RBiH), customs (RS), defence_policy (RBiH), indirect_taxation (RS)
  assert.strictEqual(sorted[0].competence, 'armed_forces_command');
  assert.strictEqual(sorted[0].holder, 'RBiH');
  assert.strictEqual(sorted[1].competence, 'customs');
  assert.strictEqual(sorted[1].holder, 'RS');
  assert.strictEqual(sorted[2].competence, 'defence_policy');
  assert.strictEqual(sorted[2].holder, 'RBiH');
  assert.strictEqual(sorted[3].competence, 'indirect_taxation');
  assert.strictEqual(sorted[3].holder, 'RS');
});
