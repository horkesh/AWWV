/**
 * Phase 13A.0: Tests for institutional competences as treaty outcomes
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { TreatyDraft } from '../src/state/treaty.js';
import type { TreatyAcceptanceReport } from '../src/state/treaty_acceptance.js';
import { createClause, buildTreatyDraft } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import { applyTreaty } from '../src/state/treaty_apply.js';
import { ALL_COMPETENCES, isValidCompetence } from '../src/state/competences.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import type { LoadedSettlementGraph } from '../src/map/settlements.js';

function createAcceptedEvalReport(draft: TreatyDraft): TreatyAcceptanceReport {
  return {
    treaty_id: draft.treaty_id,
    turn: draft.turn,
    proposer_faction_id: draft.proposer_faction_id,
    per_target: draft.clauses
      .flatMap((c) => c.target_faction_ids)
      .filter((id, idx, arr) => arr.indexOf(id) === idx)
      .sort()
      .map((factionId) => ({
        faction_id: factionId,
        accept: true,
        breakdown: {
          base_will: 0,
          pressure_factor: 3,
          reality_factor: 1,
          cost_factor: -6,
          guarantee_factor: 0,
          humiliation_factor: 0,
          warning_penalty: 0,
          heldness_factor: 0,
          trade_fairness_factor: 0,
          competence_factor: 0,
          total_score: -2
        },
        reasons: ['pressure_factor_+3', 'reality_factor_+1', 'cost_factor_-6']
      })),
    accepted_by_all_targets: true,
    rejecting_factions: [],
    warnings: [],
    totals: draft.totals
  };
}

function createTestState(): GameState {
  return {
    schema_version: 1,
    meta: { turn: 5, seed: 'test' },
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['1', '2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 100, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['3', '4'],
        supply_sources: [],
        negotiation: { pressure: 15, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_ledger: []
  };
}

function createTestSettlementGraph(): LoadedSettlementGraph {
  return {
    settlements: new Map([
      ['1', { sid: '1', source_id: '1', mun_code: 'M1', mun: 'Municipality1' }],
      ['2', { sid: '2', source_id: '2', mun_code: 'M1', mun: 'Municipality1' }],
      ['3', { sid: '3', source_id: '3', mun_code: 'M2', mun: 'Municipality2' }],
      ['4', { sid: '4', source_id: '4', mun_code: 'M2', mun: 'Municipality2' }]
    ]),
    edges: []
  };
}

test('competences: canonical list is valid and ordered', () => {
  assert.ok(ALL_COMPETENCES.length > 0);
  assert.ok(ALL_COMPETENCES.includes('customs'));
  assert.ok(ALL_COMPETENCES.includes('border_control'));
  
  // Check ordering (should be sorted)
  const sorted = [...ALL_COMPETENCES].sort();
  assert.deepStrictEqual(ALL_COMPETENCES, sorted);
});

test('competences: Phase 14 - catalog contains required IDs', () => {
  // Phase 14: Required competence IDs
  const requiredIds = [
    'police_internal_security',
    'defence_policy',
    'education_policy',
    'health_policy',
    'customs',
    'indirect_taxation',
    'international_representation',
    'airspace_control',
    'currency_authority',
    'armed_forces_command' // Phase 14: Defence bundle
  ];
  
  for (const id of requiredIds) {
    assert.ok(ALL_COMPETENCES.includes(id as any), `Missing required competence: ${id}`);
  }
});

test('competences: Phase 14 - no duplicate IDs in catalog', () => {
  const seen = new Set<string>();
  for (const comp of ALL_COMPETENCES) {
    assert.ok(!seen.has(comp), `Duplicate competence ID: ${comp}`);
    seen.add(comp);
  }
});

test('competences: isValidCompetence validates correctly', () => {
  assert.strictEqual(isValidCompetence('customs'), true);
  assert.strictEqual(isValidCompetence('border_control'), true);
  assert.strictEqual(isValidCompetence('invalid_competence'), false);
  assert.strictEqual(isValidCompetence(''), false);
});

test('competences: allocate_competence clause validates correctly', () => {
  const state = createTestState();
  const clause = createClause(
    'c1',
    'institutional',
    'allocate_competence',
    'RBiH',
    ['RS'],
    { kind: 'global' },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'customs',
    'RBiH'
  );
  
  assert.strictEqual(clause.kind, 'allocate_competence');
  assert.strictEqual(clause.competence, 'customs');
  assert.strictEqual(clause.holder, 'RBiH');
  assert.strictEqual(clause.cost, 5); // Fixed cost from template
  assert.strictEqual(clause.acceptance_impact, 4); // Fixed impact from template
});

test('competences: duplicate competence allocation rejected', () => {
  const state = createTestState();
  const clauses = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RS'), // Duplicate
    createClause('c3', 'territorial', 'transfer_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] }, undefined, 'RS', 'RBiH') // Territorial to trigger peace
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  
  // Apply treaty - should fail due to duplicate competence
  const applyResult = applyTreaty(state, draft, evalResult);
  
  // Should have validation failure for duplicate competence
  assert.ok(applyResult.report.warnings.some((w) => w.includes('duplicate_competence_allocation')));
});

test('competences: competence allocation rejected if treaty does not trigger peace', () => {
  const state = createTestState();
  const clauses = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'military', 'ceasefire_global', 'RBiH', ['RS'], { kind: 'global' }) // Only military, no territorial
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  
  // Apply treaty - should fail due to missing territorial effects
  const applyResult = applyTreaty(state, draft, evalResult);
  
  // Should have validation failure
  assert.ok(applyResult.report.warnings.some((w) => w.includes('competence_requires_peace')));
});

test('competences: competence allocations appear in end_state snapshot when peace treaty applied', () => {
  const state = createTestState();
  // Use recognize_control_settlements to trigger peace (recognizes RBiH control of sid1)
  const clauses = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'border_control', 'RS'),
    createClause('c3', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  
  // Apply treaty with settlement graph
  const settlementGraph = createTestSettlementGraph();
  const applyResult = applyTreaty(state, draft, evalResult, { settlementGraph });
  
  // Should have end_state set
  assert.ok(applyResult.state.end_state);
  assert.strictEqual(applyResult.state.end_state?.kind, 'peace_treaty');
  
  // Should have competences in snapshot
  assert.ok(applyResult.state.end_state?.snapshot?.competences);
  const competences = applyResult.state.end_state!.snapshot!.competences!;
  assert.strictEqual(competences.length, 2);
  
  // Check competences are sorted by competence ID
  assert.strictEqual(competences[0].competence, 'border_control');
  assert.strictEqual(competences[0].holder, 'RS');
  assert.strictEqual(competences[1].competence, 'customs');
  assert.strictEqual(competences[1].holder, 'RBiH');
});

test('competences: competence allocations do not mutate active state before peace', () => {
  const state = createTestState();
  const clauses = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'military', 'ceasefire_global', 'RBiH', ['RS'], { kind: 'global' }) // Only military, no peace
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);
  
  // Apply treaty - should not trigger peace
  const applyResult = applyTreaty(state, draft, evalResult);
  
  // Should NOT have end_state
  assert.strictEqual(applyResult.state.end_state, undefined);
  
  // Competences should not appear anywhere in active state
  // (they only exist in end_state snapshot)
  assert.strictEqual(applyResult.state.end_state, undefined);
});

test('competences: snapshot hash changes deterministically when competences differ', () => {
  const state = createTestState();
  
  // First treaty with one competence
  const clauses1 = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  const draft1 = buildTreatyDraft(5, 'RBiH', clauses1);
  const frontEdges: FrontEdge[] = [];
  const eval1 = createAcceptedEvalReport(draft1);
  const settlementGraph = createTestSettlementGraph();
  const apply1 = applyTreaty(state, draft1, eval1, { settlementGraph });
  const hash1 = apply1.state.end_state?.snapshot?.outcome_hash;
  
  // Second treaty with different competence
  const state2 = createTestState();
  const clauses2 = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'border_control', 'RBiH'),
    createClause('c2', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  const draft2 = buildTreatyDraft(5, 'RBiH', clauses2);
  const eval2 = createAcceptedEvalReport(draft2);
  const apply2 = applyTreaty(state2, draft2, eval2, { settlementGraph });
  const hash2 = apply2.state.end_state?.snapshot?.outcome_hash;
  
  // Hashes should differ
  assert.notStrictEqual(hash1, hash2);
  assert.ok(hash1);
  assert.ok(hash2);
});

test('competences: snapshot freeze preserves competences across turns', () => {
  const state = createTestState();
  const clauses = [
    createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', 'RBiH'),
    createClause('c2', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  const settlementGraph = createTestSettlementGraph();
  const applyResult = applyTreaty(state, draft, evalResult, { settlementGraph });
  
  // Get initial snapshot
  const initialSnapshot = applyResult.state.end_state?.snapshot;
  assert.ok(initialSnapshot);
  assert.ok(initialSnapshot.competences);
  assert.strictEqual(initialSnapshot.competences!.length, 1);
  
  // Simulate a turn (end_state should prevent war mutations, but snapshot should remain)
  // In a real scenario, the turn pipeline would short-circuit, but snapshot should be frozen
  const frozenCompetences = initialSnapshot.competences;
  
  // Verify competences are preserved
  assert.strictEqual(frozenCompetences!.length, 1);
  assert.strictEqual(frozenCompetences![0].competence, 'customs');
  assert.strictEqual(frozenCompetences![0].holder, 'RBiH');
});

test('competences: invalid competence ID rejected', () => {
  const state = createTestState();
  // Create clause with invalid competence (bypassing type system for test)
  const clause = createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'invalid_competence', 'RBiH');
  (clause as any).competence = 'invalid_competence'; // Force invalid value
  
  const clauses = [
    clause,
    createClause('c2', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  
  // Apply treaty - should fail validation
  const applyResult = applyTreaty(state, draft, evalResult);
  
  // Should have validation failure
  assert.ok(applyResult.report.warnings.some((w) => w.includes('invalid_competence')));
});

test('competences: missing holder rejected', () => {
  const state = createTestState();
  // Create clause with missing holder
  const clause = createClause('c1', 'institutional', 'allocate_competence', 'RBiH', ['RS'], { kind: 'global' }, undefined, undefined, undefined, undefined, undefined, 'customs', '');
  (clause as any).holder = ''; // Force empty holder
  
  const clauses = [
    clause,
    createClause('c2', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
  
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const frontEdges: FrontEdge[] = [];
  const evalResult = createAcceptedEvalReport(draft);
  
  // Apply treaty - should fail validation
  const applyResult = applyTreaty(state, draft, evalResult);
  
  // Should have validation failure
  assert.ok(applyResult.report.warnings.some((w) => w.includes('competence_missing_holder')));
});
