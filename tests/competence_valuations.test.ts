/**
 * Phase 15: Tests for competence valuation tables
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { ALL_COMPETENCES } from '../src/state/competences.js';
import { POLITICAL_SIDES } from '../src/state/identity.js';
import {
  COMPETENCE_VALUATIONS,
  getCompetenceValuation,
  computeCompetenceUtility
} from '../src/state/competence_valuations.js';
import type { CompetenceId } from '../src/state/competences.js';
import type { PoliticalSideId } from '../src/state/identity.js';
import { createClause, buildTreatyDraft } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import type { GameState } from '../src/state/game_state.js';
import type { FrontEdge } from '../src/map/front_edges.js';

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
      },
      {
        id: 'HRHB',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 15 },
        areasOfResponsibility: ['5', '6'],
        supply_sources: [],
        negotiation: { pressure: 10, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
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

test('competence_valuations: completeness - every competence has valuation for every faction', () => {
  for (const factionId of POLITICAL_SIDES) {
    const factionVals = COMPETENCE_VALUATIONS[factionId];
    assert.ok(factionVals, `Missing valuation table for faction: ${factionId}`);

    for (const competenceId of ALL_COMPETENCES) {
      const value = factionVals[competenceId];
      assert.notStrictEqual(value, undefined, `Missing valuation for competence ${competenceId} and faction ${factionId}`);
      assert.ok(Number.isInteger(value), `Non-integer valuation for competence ${competenceId} and faction ${factionId}: ${value}`);
      assert.ok(!Number.isNaN(value), `NaN valuation for competence ${competenceId} and faction ${factionId}`);
    }
  }
});

test('competence_valuations: determinism - iteration order is stable', () => {
  // First iteration
  const firstIteration: Array<{ faction: PoliticalSideId; competence: CompetenceId; value: number }> = [];
  for (const factionId of POLITICAL_SIDES) {
    for (const competenceId of ALL_COMPETENCES) {
      firstIteration.push({
        faction: factionId,
        competence: competenceId,
        value: COMPETENCE_VALUATIONS[factionId][competenceId]
      });
    }
  }

  // Second iteration (should be identical)
  const secondIteration: Array<{ faction: PoliticalSideId; competence: CompetenceId; value: number }> = [];
  for (const factionId of POLITICAL_SIDES) {
    for (const competenceId of ALL_COMPETENCES) {
      secondIteration.push({
        faction: factionId,
        competence: competenceId,
        value: COMPETENCE_VALUATIONS[factionId][competenceId]
      });
    }
  }

  assert.deepStrictEqual(firstIteration, secondIteration);
});

test('competence_valuations: getCompetenceValuation returns correct values', () => {
  // Test known values from table
  assert.strictEqual(getCompetenceValuation('currency_authority', 'RBiH'), 10);
  assert.strictEqual(getCompetenceValuation('currency_authority', 'RS'), -2);
  assert.strictEqual(getCompetenceValuation('currency_authority', 'HRHB'), 2);

  assert.strictEqual(getCompetenceValuation('education_policy', 'RBiH'), 6);
  assert.strictEqual(getCompetenceValuation('education_policy', 'RS'), 7);
  assert.strictEqual(getCompetenceValuation('education_policy', 'HRHB'), 8);
});

test('competence_valuations: getCompetenceValuation throws on invalid inputs', () => {
  assert.throws(() => {
    getCompetenceValuation('invalid_competence' as CompetenceId, 'RBiH');
  }, /Missing valuation/);

  assert.throws(() => {
    getCompetenceValuation('customs', 'INVALID_FACTION' as PoliticalSideId);
  }, /Invalid faction_id/);
});

test('competence_valuations: computeCompetenceUtility sums valuations correctly', () => {
  const allocations = [
    { competence: 'currency_authority', holder: 'RBiH' },
    { competence: 'education_policy', holder: 'RBiH' },
    { competence: 'police_internal_security', holder: 'RS' }
  ];

  // RBiH should get utility from currency_authority (10) + education_policy (6) = 16
  const rbhUtility = computeCompetenceUtility(allocations, 'RBiH');
  assert.strictEqual(rbhUtility, 16);

  // RS should get utility from police_internal_security (8)
  const rsUtility = computeCompetenceUtility(allocations, 'RS');
  assert.strictEqual(rsUtility, 8);

  // HRHB should get 0 (no allocations to HRHB)
  const hrhbUtility = computeCompetenceUtility(allocations, 'HRHB');
  assert.strictEqual(hrhbUtility, 0);
});

test('competence_valuations: computeCompetenceUtility ignores invalid competences', () => {
  const allocations = [
    { competence: 'currency_authority', holder: 'RBiH' },
    { competence: 'invalid_competence', holder: 'RBiH' }, // Should be ignored
    { competence: 'education_policy', holder: 'RBiH' }
  ];

  // Should only count valid competences: currency_authority (10) + education_policy (6) = 16
  const utility = computeCompetenceUtility(allocations, 'RBiH');
  assert.strictEqual(utility, 16);
});

test('competence_valuations: acceptance integration - competence allocations affect acceptance score', () => {
  const state = createTestState();
  const frontEdges: FrontEdge[] = [];

  // Treaty with competence allocation to RBiH (currency_authority = +10 for RBiH)
  const clauses1 = [
    createClause(
      'c1',
      'institutional',
      'allocate_competence',
      'RBiH',
      ['RBiH'],
      { kind: 'global' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'currency_authority',
      'RBiH'
    )
  ];
  const draft1 = buildTreatyDraft(5, 'RBiH', clauses1);
  const eval1 = evaluateTreatyAcceptance(state, draft1, frontEdges, undefined);

  // Treaty with competence allocation to RS (currency_authority = -2 for RS, but RS is target)
  const clauses2 = [
    createClause(
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
      'currency_authority',
      'RS'
    )
  ];
  const draft2 = buildTreatyDraft(5, 'RBiH', clauses2);
  const eval2 = evaluateTreatyAcceptance(state, draft2, frontEdges, undefined);

  // RBiH as target in draft1 should have higher acceptance score (competence_factor = +10)
  const rbh1 = eval1.per_target.find((t) => t.faction_id === 'RBiH');
  const rbh2 = eval2.per_target.find((t) => t.faction_id === 'RBiH');

  // If RBiH is a target in draft1, it should have competence_factor > 0
  // If RBiH is not a target in draft1, RS should have competence_factor = -2 in draft2
  if (rbh1) {
    assert.ok(rbh1.breakdown.competence_factor > 0, 'RBiH should have positive competence_factor when allocated currency_authority');
  }

  const rs2 = eval2.per_target.find((t) => t.faction_id === 'RS');
  if (rs2) {
    assert.strictEqual(rs2.breakdown.competence_factor, -2, 'RS should have negative competence_factor when allocated currency_authority');
  }
});

test('competence_valuations: acceptance integration - identical competence allocations produce identical scores', () => {
  const state = createTestState();
  const frontEdges: FrontEdge[] = [];

  const clauses = [
    createClause(
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
      'education_policy',
      'RS'
    )
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);

  // First evaluation
  const eval1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  // Second evaluation (should be identical)
  const eval2 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  // Compare acceptance scores
  assert.strictEqual(eval1.per_target.length, eval2.per_target.length);
  for (let i = 0; i < eval1.per_target.length; i++) {
    const t1 = eval1.per_target[i];
    const t2 = eval2.per_target[i];
    assert.strictEqual(t1.faction_id, t2.faction_id);
    assert.strictEqual(t1.breakdown.competence_factor, t2.breakdown.competence_factor);
    assert.strictEqual(t1.breakdown.total_score, t2.breakdown.total_score);
  }
});

test('competence_valuations: acceptance integration - different competence allocations produce different scores', () => {
  const state = createTestState();
  const frontEdges: FrontEdge[] = [];

  // Treaty 1: currency_authority to RBiH (+10 for RBiH)
  const clauses1 = [
    createClause(
      'c1',
      'institutional',
      'allocate_competence',
      'RBiH',
      ['RBiH'],
      { kind: 'global' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'currency_authority',
      'RBiH'
    )
  ];
  const draft1 = buildTreatyDraft(5, 'RBiH', clauses1);
  const eval1 = evaluateTreatyAcceptance(state, draft1, frontEdges, undefined);

  // Treaty 2: education_policy to RBiH (+6 for RBiH)
  const clauses2 = [
    createClause(
      'c1',
      'institutional',
      'allocate_competence',
      'RBiH',
      ['RBiH'],
      { kind: 'global' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'education_policy',
      'RBiH'
    )
  ];
  const draft2 = buildTreatyDraft(5, 'RBiH', clauses2);
  const eval2 = evaluateTreatyAcceptance(state, draft2, frontEdges, undefined);

  // RBiH should have different competence_factor values
  const rbh1 = eval1.per_target.find((t) => t.faction_id === 'RBiH');
  const rbh2 = eval2.per_target.find((t) => t.faction_id === 'RBiH');

  if (rbh1 && rbh2) {
    assert.notStrictEqual(rbh1.breakdown.competence_factor, rbh2.breakdown.competence_factor);
    assert.strictEqual(rbh1.breakdown.competence_factor, 10); // currency_authority
    assert.strictEqual(rbh2.breakdown.competence_factor, 6); // education_policy
  }
});

test('competence_valuations: acceptance integration - no change when competence allocations are identical', () => {
  const state = createTestState();
  const frontEdges: FrontEdge[] = [];

  const clauses = [
    createClause(
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
      'police_internal_security',
      'RS'
    )
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);

  // First evaluation
  const eval1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  // Create identical draft (same competence allocation)
  const draft2 = buildTreatyDraft(5, 'RBiH', clauses);
  const eval2 = evaluateTreatyAcceptance(state, draft2, frontEdges, undefined);

  // Acceptance scores should be identical
  assert.strictEqual(eval1.per_target.length, eval2.per_target.length);
  for (let i = 0; i < eval1.per_target.length; i++) {
    const t1 = eval1.per_target[i];
    const t2 = eval2.per_target[i];
    assert.strictEqual(t1.faction_id, t2.faction_id);
    assert.strictEqual(t1.breakdown.competence_factor, t2.breakdown.competence_factor);
    assert.strictEqual(t1.breakdown.total_score, t2.breakdown.total_score);
  }
});
