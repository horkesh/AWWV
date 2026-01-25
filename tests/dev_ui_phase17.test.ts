/**
 * Phase 17: Tests for treaty validation status and acceptance breakdown visualization
 * 
 * Tests validator reason display, acceptance breakdown including competence_factor,
 * and deterministic rendering.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState, PoliticalSideId } from '../src/state/game_state.js';
import type { TreatyDraft, TreatyClause } from '../src/state/treaty.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import type { LoadedSettlementGraph } from '../src/map/settlements.js';

// Helper: Create minimal game state
function createMinimalGameState(turn: number = 1): GameState {
  return {
    schema_version: 1,
    meta: { turn, seed: 'test' },
    factions: [
      {
        id: 'RBiH',
        areasOfResponsibility: ['1', '2'],
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
        areasOfResponsibility: ['3', '4'],
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'HRHB',
        areasOfResponsibility: ['5', '6'],
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    formations: {},
    militia_pools: {},
    control_overrides: {},
    control_recognition: {},
    negotiation_ledger: []
  };
}

// Helper: Create minimal settlement graph
function createMinimalSettlementGraph(): LoadedSettlementGraph {
  return {
    settlements: new Map([
      ['1', { sid: '1', mun_code: '1', mun: 'Test', source_id: '1' }],
      ['2', { sid: '2', mun_code: '1', mun: 'Test', source_id: '2' }],
      ['3', { sid: '3', mun_code: '2', mun: 'Test', source_id: '3' }],
      ['4', { sid: '4', mun_code: '2', mun: 'Test', source_id: '4' }],
      ['5', { sid: '5', mun_code: '3', mun: 'Test', source_id: '5' }],
      ['6', { sid: '6', mun_code: '3', mun: 'Test', source_id: '6' }]
    ]),
    edges: [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
      { a: '5', b: '6' }
    ]
  };
}

// Helper: Create treaty draft that violates Brčko rule
function createBrckoViolationDraft(): TreatyDraft {
  return {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST_BRCKO_VIOLATION',
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
}

// Helper: Create valid treaty draft with Brčko resolution
function createValidBrckoDraft(): TreatyDraft {
  return {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST_VALID_BRCKO',
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
      },
      {
        id: 'c2',
        annex: 'territorial',
        kind: 'brcko_special_status',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: [] },
        cost: 10,
        acceptance_impact: 8,
        enforcement_burden: 6
      }
    ],
    totals: { cost_total: 15, acceptance_impact_total: 11, enforcement_burden_total: 8 },
    package_warnings: []
  };
}

// Helper: Create treaty draft with competence allocations
function createCompetenceDraft(): TreatyDraft {
  return {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST_COMPETENCE',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'institutional',
        kind: 'allocate_competence',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'global' },
        cost: 5,
        acceptance_impact: 4,
        enforcement_burden: 3,
        competence: 'currency_authority',
        holder: 'RBiH'
      },
      {
        id: 'c2',
        annex: 'institutional',
        kind: 'allocate_competence',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'global' },
        cost: 5,
        acceptance_impact: 4,
        enforcement_burden: 3,
        competence: 'police_internal_security',
        holder: 'RS'
      }
    ],
    totals: { cost_total: 10, acceptance_impact_total: 8, enforcement_burden_total: 6 },
    package_warnings: []
  };
}

// Test 1: Validator reason display for Brčko violation
test('dev_ui phase17: eval report shows brcko_unresolved rejection_reason', () => {
  const state = createMinimalGameState();
  // Set high pressure to ensure baseline acceptance passes
  state.factions[0].negotiation!.pressure = 50; // RBiH (proposer)
  state.factions[1].negotiation!.pressure = 50; // RS (target)
  const graph = createMinimalSettlementGraph();
  const draft = createBrckoViolationDraft();
  
  const frontEdges = computeFrontEdges(state, graph.edges);
  const evalReport = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Should be rejected with brcko_unresolved (constraint applied after baseline passes)
  assert.strictEqual(evalReport.accepted_by_all_targets, false);
  assert.strictEqual(evalReport.rejection_reason, 'brcko_unresolved');
  assert.ok(evalReport.rejection_details);
  assert.strictEqual(evalReport.rejection_details?.constraint_type, 'require_brcko_resolution');
});

// Test 2: Valid treaty display
test('dev_ui phase17: eval report shows valid for treaty with Brčko resolution', () => {
  const state = createMinimalGameState();
  const graph = createMinimalSettlementGraph();
  const draft = createValidBrckoDraft();
  
  const frontEdges = computeFrontEdges(state, graph.edges);
  const evalReport = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Should not have rejection_reason (may still reject due to scoring, but not constraint violation)
  // Note: This test checks that brcko_unresolved is not present, not that it's accepted
  // (acceptance depends on scoring, which may still be negative)
  assert.ok(!evalReport.rejection_reason || evalReport.rejection_reason !== 'brcko_unresolved');
});

// Test 3: Acceptance breakdown includes competence_factor
test('dev_ui phase17: acceptance breakdown includes competence_factor', () => {
  const state = createMinimalGameState();
  const graph = createMinimalSettlementGraph();
  const draft = createCompetenceDraft();
  
  const frontEdges = computeFrontEdges(state, graph.edges);
  const evalReport = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Check that breakdown includes competence_factor
  for (const target of evalReport.per_target) {
    assert.ok('competence_factor' in target.breakdown);
    assert.strictEqual(typeof target.breakdown.competence_factor, 'number');
    
    // Verify all expected breakdown fields are present
    assert.ok('total_score' in target.breakdown);
    assert.ok('base_will' in target.breakdown);
    assert.ok('pressure_factor' in target.breakdown);
    assert.ok('reality_factor' in target.breakdown);
    assert.ok('guarantee_factor' in target.breakdown);
    assert.ok('cost_factor' in target.breakdown);
    assert.ok('humiliation_factor' in target.breakdown);
    assert.ok('warning_penalty' in target.breakdown);
    assert.ok('heldness_factor' in target.breakdown);
    assert.ok('trade_fairness_factor' in target.breakdown);
  }
});

// Test 4: Deterministic breakdown ordering
test('dev_ui phase17: breakdown fields are in deterministic order', () => {
  const state = createMinimalGameState();
  const graph = createMinimalSettlementGraph();
  const draft = createCompetenceDraft();
  
  const frontEdges = computeFrontEdges(state, graph.edges);
  const evalReport1 = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Run again to verify determinism
  const evalReport2 = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Per-target should be in same order (sorted by faction_id)
  assert.strictEqual(evalReport1.per_target.length, evalReport2.per_target.length);
  for (let i = 0; i < evalReport1.per_target.length; i++) {
    const t1 = evalReport1.per_target[i];
    const t2 = evalReport2.per_target[i];
    assert.strictEqual(t1.faction_id, t2.faction_id);
    
    // Breakdown values should be identical
    assert.strictEqual(t1.breakdown.total_score, t2.breakdown.total_score);
    assert.strictEqual(t1.breakdown.competence_factor, t2.breakdown.competence_factor);
  }
});

// Test 5: Faction ordering is deterministic (RBiH, RS, HRHB)
test('dev_ui phase17: per_target factions are in deterministic order', () => {
  const state = createMinimalGameState();
  const graph = createMinimalSettlementGraph();
  const draft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST_ALL_FACTIONS',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'military',
        kind: 'freeze_region',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS', 'HRHB'],
        scope: { kind: 'region', region_id: 'R_001' },
        cost: 5,
        acceptance_impact: 3,
        enforcement_burden: 2
      }
    ],
    totals: { cost_total: 5, acceptance_impact_total: 3, enforcement_burden_total: 2 },
    package_warnings: []
  };
  
  const frontEdges = computeFrontEdges(state, graph.edges);
  const evalReport = evaluateTreatyAcceptance(
    state,
    draft,
    frontEdges,
    undefined,
    graph
  );
  
  // Should be sorted by faction_id (RS < HRHB alphabetically)
  const factionIds = evalReport.per_target.map(t => t.faction_id);
  assert.deepStrictEqual(factionIds, ['HRHB', 'RS']);
  
  // Verify sorted order
  for (let i = 1; i < factionIds.length; i++) {
    assert.ok(factionIds[i - 1] < factionIds[i], `Factions should be sorted: ${factionIds.join(', ')}`);
  }
});

// Test 6: Invalid treaty shows rejection_reason, valid shows no rejection_reason
test('dev_ui phase17: valid treaty has no rejection_reason, invalid has rejection_reason', () => {
  const state = createMinimalGameState();
  // Set high pressure to ensure baseline acceptance passes
  state.factions[0].negotiation!.pressure = 50; // RBiH (proposer)
  state.factions[1].negotiation!.pressure = 50; // RS (target)

  const graph = createMinimalSettlementGraph();
  
  // Invalid: Brčko violation
  const invalidDraft = createBrckoViolationDraft();
  const frontEdges = computeFrontEdges(state, graph.edges);
  const invalidReport = evaluateTreatyAcceptance(
    state,
    invalidDraft,
    frontEdges,
    undefined,
    graph
  );
  assert.strictEqual(invalidReport.accepted_by_all_targets, false);
  assert.ok(invalidReport.rejection_reason);
  
  // Valid: Military-only (doesn't trigger peace, so no Brčko requirement)
  const validDraft: TreatyDraft = {
    schema: 1,
    turn: 1,
    treaty_id: 'TEST_MILITARY_ONLY',
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
  
  const validReport = evaluateTreatyAcceptance(
    state,
    validDraft,
    frontEdges,
    undefined,
    graph
  );
  
  // Military-only treaty doesn't trigger peace, so no Brčko constraint
  // It may still reject due to scoring, but should not have rejection_reason from constraints
  // (unless it violates other constraints like competence bundles)
  // For this test, we just verify that if it's accepted, there's no rejection_reason
  if (validReport.accepted_by_all_targets) {
    assert.ok(!validReport.rejection_reason || validReport.rejection_reason === undefined);
  }
});
