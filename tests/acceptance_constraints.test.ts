/**
 * Phase 13B.0: Tests for deterministic acceptance structural constraints
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import { createClause, buildTreatyDraft } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
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

/** State where RS has high pressure so treaties with competences baseline-accept */
function createHighPressureState(): GameState {
  return {
    ...createTestState(),
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
        negotiation: { pressure: 50, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ]
  };
}

/** Phase 13B.1: Even higher pressure so treaties with brcko + competences still baseline-accept */
function createVeryHighPressureState(): GameState {
  return {
    ...createTestState(),
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
        negotiation: { pressure: 100, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ]
  };
}

const frontEdges: FrontEdge[] = [];

function militaryAndTerritorialClauses() {
  return [
    createClause('m1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' }),
    createClause('t1', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
}

/** Phase 13B.1: Brčko clause so peace-triggering treaties satisfy completeness constraint */
function brckoClause() {
  return createClause('b1', 'territorial', 'brcko_special_status', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] });
}

function allocateClause(id: string, competence: string, holder: string) {
  return createClause(
    id,
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
    competence,
    holder
  );
}

test('acceptance constraints: only customs without indirect_taxation is rejected', () => {
  const state = createHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    allocateClause('c1', 'customs', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_bundle_incomplete');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_bundle');
  assert.ok(report.rejection_details!.competences);
  assert.deepStrictEqual(report.rejection_details!.competences, ['customs', 'indirect_taxation'].sort());
});

test('acceptance constraints: customs + indirect_taxation accepted when baseline passes', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'customs', 'RBiH'),
    allocateClause('c2', 'indirect_taxation', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
  assert.strictEqual(report.rejection_details, undefined);
});

test('acceptance constraints: currency_authority to forbidden faction RS is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'currency_authority', 'RS')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_forbidden_to_faction');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'forbid_competence');
  assert.strictEqual(report.rejection_details!.competence, 'currency_authority');
  assert.strictEqual(report.rejection_details!.faction, 'RS');
});

test('acceptance constraints: airspace_control to forbidden faction RS is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'airspace_control', 'RS')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_forbidden_to_faction');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'forbid_competence');
  assert.strictEqual(report.rejection_details!.competence, 'airspace_control');
  assert.strictEqual(report.rejection_details!.faction, 'RS');
});

test('acceptance constraints: international_representation to forbidden holder RS is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'international_representation', 'RS')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_forbidden_holder');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'forbid_holder');
  assert.strictEqual(report.rejection_details!.competence, 'international_representation');
  assert.strictEqual(report.rejection_details!.holder, 'RS');
});

test('acceptance constraints: treaty with no competences unaffected by constraints', () => {
  const state = createTestState();
  const clauses = [
    createClause('c1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' })
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
  assert.strictEqual(report.rejection_details, undefined);
});

test('acceptance constraints: rejection reasons are deterministic and stable', () => {
  const state = createHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    allocateClause('c1', 'customs', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);

  const report1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);
  const report2 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report1.accepted_by_all_targets, false);
  assert.strictEqual(report2.accepted_by_all_targets, false);
  assert.strictEqual(report1.rejection_reason, report2.rejection_reason);
  assert.deepStrictEqual(report1.rejection_details, report2.rejection_details);
});

test('acceptance constraints: Phase 14 - defence_policy without armed_forces_command is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'defence_policy', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_bundle_incomplete');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_bundle');
  assert.ok(report.rejection_details!.competences);
  assert.deepStrictEqual(report.rejection_details!.competences, ['armed_forces_command', 'defence_policy'].sort());
});

test('acceptance constraints: Phase 14 - defence bundle split across holders is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'defence_policy', 'RBiH'),
    allocateClause('c2', 'armed_forces_command', 'RS') // Different holder
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_bundle_incomplete');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_bundle');
});

test('acceptance constraints: Phase 14 - defence bundle to same holder is accepted', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'defence_policy', 'RBiH'),
    allocateClause('c2', 'armed_forces_command', 'RBiH') // Same holder
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
});

test('acceptance constraints: Phase 14 - customs bundle split across holders is rejected', () => {
  const state = createVeryHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    brckoClause(),
    allocateClause('c1', 'customs', 'RBiH'),
    allocateClause('c2', 'indirect_taxation', 'RS') // Different holder
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_bundle_incomplete');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_bundle');
});
