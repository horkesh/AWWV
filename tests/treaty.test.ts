import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { TreatyClause, TreatyDraft } from '../src/state/treaty.js';
import {
  computeClauseCost,
  computeClauseAcceptanceImpact,
  getClauseEnforcementBurden,
  validateClauseScope
} from '../src/state/treaty_clause_library.js';
import type { TreatyScope } from '../src/state/treaty.js';
import { computePackageWarnings } from '../src/state/treaty_package_warnings.js';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import type { FrontEdge } from '../src/map/front_edges.js';

function createTestState(): GameState {
  return {
    schema_version: 1,
    meta: { turn: 5, seed: 'test' },
    factions: [
      {
        id: 'faction_a',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'faction_b',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['sid3', 'sid4'],
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

test('treaty clause library: cost scaling deterministic and capped', () => {
  // Test recognize_control_settlements scaling
  const cost1 = computeClauseCost('recognize_control_settlements', { kind: 'settlements', sids: ['sid1'] });
  assert.strictEqual(cost1, 1);

  const cost5 = computeClauseCost('recognize_control_settlements', { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3', 'sid4', 'sid5'] });
  assert.strictEqual(cost5, 5);

  const cost10 = computeClauseCost('recognize_control_settlements', { kind: 'settlements', sids: Array.from({ length: 10 }, (_, i) => `sid${i}`) });
  assert.strictEqual(cost10, 10);

  // Test cap at 10
  const cost20 = computeClauseCost('recognize_control_settlements', { kind: 'settlements', sids: Array.from({ length: 20 }, (_, i) => `sid${i}`) });
  assert.strictEqual(cost20, 10);

  // Test other clauses have fixed costs
  assert.strictEqual(computeClauseCost('ceasefire_global', { kind: 'global' }), 8);
  assert.strictEqual(computeClauseCost('freeze_region', { kind: 'region', region_id: 'R_001' }), 4);
  assert.strictEqual(computeClauseCost('monitoring_light', { kind: 'global' }), 2);
});

test('treaty clause library: acceptance impact scaling', () => {
  // Test recognize_control_settlements scaling (no cap)
  const impact1 = computeClauseAcceptanceImpact('recognize_control_settlements', { kind: 'settlements', sids: ['sid1'] });
  assert.strictEqual(impact1, 1);

  const impact5 = computeClauseAcceptanceImpact('recognize_control_settlements', { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3', 'sid4', 'sid5'] });
  assert.strictEqual(impact5, 5);

  // Test other clauses have fixed impacts
  assert.strictEqual(computeClauseAcceptanceImpact('ceasefire_global', { kind: 'global' }), 6);
  assert.strictEqual(computeClauseAcceptanceImpact('freeze_region', { kind: 'region', region_id: 'R_001' }), 3);
});

test('treaty clause library: enforcement burden', () => {
  assert.strictEqual(getClauseEnforcementBurden('ceasefire_global'), 4);
  assert.strictEqual(getClauseEnforcementBurden('freeze_region'), 2);
  assert.strictEqual(getClauseEnforcementBurden('monitoring_robust'), 5);
});

test('treaty clause library: scope validation', () => {
  assert.strictEqual(validateClauseScope('ceasefire_global', { kind: 'global' }), true);
  assert.strictEqual(validateClauseScope('ceasefire_global', { kind: 'region', region_id: 'R_001' }), false);

  assert.strictEqual(validateClauseScope('freeze_region', { kind: 'region', region_id: 'R_001' }), true);
  assert.strictEqual(validateClauseScope('freeze_region', { kind: 'global' }), false);

  assert.strictEqual(validateClauseScope('monitoring_light', { kind: 'global' }), true);
  assert.strictEqual(validateClauseScope('monitoring_light', { kind: 'region', region_id: 'R_001' }), true);
  assert.strictEqual(validateClauseScope('monitoring_light', { kind: 'edges', edge_ids: ['e1'] }), true);
});

test('treaty package warnings: generated correctly', () => {
  const draft1: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST1',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'territorial', 'recognize_control_settlements', 'faction_a', ['faction_b'], { kind: 'settlements', sids: ['sid1'] })
    ],
    totals: { cost_total: 1, acceptance_impact_total: 1, enforcement_burden_total: 1 },
    package_warnings: []
  };

  const warnings1 = computePackageWarnings(draft1);
  assert.ok(warnings1.includes('territorial_requires_military_annex'));

  const draft2: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST2',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' }),
      createClause('c2', 'territorial', 'recognize_control_settlements', 'faction_a', ['faction_b'], { kind: 'settlements', sids: ['sid1'] })
    ],
    totals: { cost_total: 9, acceptance_impact_total: 7, enforcement_burden_total: 5 },
    package_warnings: []
  };

  const warnings2 = computePackageWarnings(draft2);
  assert.strictEqual(warnings2.includes('territorial_requires_military_annex'), false);

  const draft3: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST3',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'institutional', 'autonomy_regional', 'faction_a', ['faction_b'], { kind: 'region', region_id: 'R_001' })
    ],
    totals: { cost_total: 8, acceptance_impact_total: 6, enforcement_burden_total: 6 },
    package_warnings: []
  };

  const warnings3 = computePackageWarnings(draft3);
  assert.ok(warnings3.includes('institutional_requires_military_annex'));

  const draft4: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST4',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
    ],
    totals: { cost_total: 20, acceptance_impact_total: 6, enforcement_burden_total: 4 },
    package_warnings: []
  };

  const warnings4 = computePackageWarnings(draft4);
  assert.ok(warnings4.includes('high_cost_without_monitoring'));
});

test('treaty draft: sorting stable', () => {
  const clauses: TreatyClause[] = [
    createClause('c3', 'military', 'freeze_region', 'faction_a', ['faction_b'], { kind: 'region', region_id: 'R_002' }),
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' }),
    createClause('c2', 'military', 'freeze_region', 'faction_a', ['faction_b'], { kind: 'region', region_id: 'R_001' }),
    createClause('c4', 'territorial', 'recognize_control_settlements', 'faction_a', ['faction_b'], { kind: 'settlements', sids: ['sid1'] })
  ];

  const draft = buildTreatyDraft(5, 'faction_a', clauses);

  // Should be sorted: military (ceasefire_global, freeze_region R_001, freeze_region R_002), then territorial
  assert.strictEqual(draft.clauses[0].id, 'c1');
  assert.strictEqual(draft.clauses[1].id, 'c2');
  assert.strictEqual(draft.clauses[2].id, 'c3');
  assert.strictEqual(draft.clauses[3].id, 'c4');
});

test('treaty draft: totals computed correctly', () => {
  const clauses: TreatyClause[] = [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' }),
    createClause('c2', 'military', 'freeze_region', 'faction_a', ['faction_b'], { kind: 'region', region_id: 'R_001' })
  ];

  const draft = buildTreatyDraft(5, 'faction_a', clauses);

  assert.strictEqual(draft.totals.cost_total, 8 + 4);
  assert.strictEqual(draft.totals.acceptance_impact_total, 6 + 3);
  assert.strictEqual(draft.totals.enforcement_burden_total, 4 + 2);
});

test('treaty acceptance: deterministic and components match expectations', () => {
  const state = createTestState();
  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
    ],
    totals: { cost_total: 8, acceptance_impact_total: 6, enforcement_burden_total: 4 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];

  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.per_target.length, 1);
  const target = report.per_target[0];
  assert.strictEqual(target.faction_id, 'faction_b');

  // faction_b has pressure 15, so pressure_factor = floor(15/5) = 3
  // faction_b pressure (15) > faction_a pressure (5), so reality_factor = 1
  // No monitoring, so guarantee_factor = 0
  // cost_factor = -6
  // cost_total = 8 < 10, so humiliation_factor = 0
  // No warnings, so warning_penalty = 0
  // Total: 0 + 3 + 1 + 0 - 6 - 0 - 0 = -2

  assert.strictEqual(target.breakdown.pressure_factor, 3);
  assert.strictEqual(target.breakdown.reality_factor, 1);
  assert.strictEqual(target.breakdown.guarantee_factor, 0);
  assert.strictEqual(target.breakdown.cost_factor, -6);
  assert.strictEqual(target.breakdown.humiliation_factor, 0);
  assert.strictEqual(target.breakdown.warning_penalty, 0);
  assert.strictEqual(target.breakdown.total_score, -2);
  assert.strictEqual(target.accept, false);
});

test('treaty acceptance: monitoring affects guarantee factor', () => {
  const state = createTestState();
  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'military', 'monitoring_robust', 'faction_a', ['faction_b'], { kind: 'global' })
    ],
    totals: { cost_total: 5, acceptance_impact_total: 2, enforcement_burden_total: 5 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  const target = report.per_target[0];
  assert.strictEqual(target.breakdown.guarantee_factor, 2);
});

test('treaty acceptance: eval results stable across repeated runs', () => {
  const state = createTestState();
  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
    ],
    totals: { cost_total: 8, acceptance_impact_total: 6, enforcement_burden_total: 4 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];

  const report1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);
  const report2 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  // Should be identical
  assert.strictEqual(JSON.stringify(report1), JSON.stringify(report2));
  assert.strictEqual(report1.treaty_id, report2.treaty_id);
  assert.strictEqual(report1.accepted_by_all_targets, report2.accepted_by_all_targets);
  assert.strictEqual(report1.per_target.length, report2.per_target.length);
  for (let i = 0; i < report1.per_target.length; i += 1) {
    assert.strictEqual(report1.per_target[i].faction_id, report2.per_target[i].faction_id);
    assert.strictEqual(report1.per_target[i].accept, report2.per_target[i].accept);
    assert.strictEqual(report1.per_target[i].breakdown.total_score, report2.per_target[i].breakdown.total_score);
  }
});

test('transfer_settlements: cost scaling deterministic', () => {
  // Test cost: min(10, number_of_settlements) * 2
  const cost1 = computeClauseCost('transfer_settlements', { kind: 'settlements', sids: ['sid1'] });
  assert.strictEqual(cost1, 2); // min(10, 1) * 2 = 2

  const cost5 = computeClauseCost('transfer_settlements', { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3', 'sid4', 'sid5'] });
  assert.strictEqual(cost5, 10); // min(10, 5) * 2 = 10

  const cost10 = computeClauseCost('transfer_settlements', { kind: 'settlements', sids: Array.from({ length: 10 }, (_, i) => `sid${i}`) });
  assert.strictEqual(cost10, 20); // min(10, 10) * 2 = 20

  // Test cap at 10 settlements for cost calculation
  const cost20 = computeClauseCost('transfer_settlements', { kind: 'settlements', sids: Array.from({ length: 20 }, (_, i) => `sid${i}`) });
  assert.strictEqual(cost20, 20); // min(10, 20) * 2 = 20
});

test('transfer_settlements: acceptance impact scaling', () => {
  // Test acceptance impact: min(10, number_of_settlements) * 2
  const impact1 = computeClauseAcceptanceImpact('transfer_settlements', { kind: 'settlements', sids: ['sid1'] });
  assert.strictEqual(impact1, 2); // min(10, 1) * 2 = 2

  const impact5 = computeClauseAcceptanceImpact('transfer_settlements', { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3', 'sid4', 'sid5'] });
  assert.strictEqual(impact5, 10); // min(10, 5) * 2 = 10

  const impact20 = computeClauseAcceptanceImpact('transfer_settlements', { kind: 'settlements', sids: Array.from({ length: 20 }, (_, i) => `sid${i}`) });
  assert.strictEqual(impact20, 20); // min(10, 20) * 2 = 20
});

test('transfer_settlements: enforcement burden scaling', () => {
  // Test enforcement burden: 2 + floor(number_of_settlements / 3)
  const scope1: TreatyScope = { kind: 'settlements', sids: ['sid1'] };
  const burden1 = getClauseEnforcementBurden('transfer_settlements', scope1);
  assert.strictEqual(burden1, 2); // 2 + floor(1/3) = 2 + 0 = 2

  const scope3: TreatyScope = { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3'] };
  const burden3 = getClauseEnforcementBurden('transfer_settlements', scope3);
  assert.strictEqual(burden3, 3); // 2 + floor(3/3) = 2 + 1 = 3

  const scope5: TreatyScope = { kind: 'settlements', sids: ['sid1', 'sid2', 'sid3', 'sid4', 'sid5'] };
  const burden5 = getClauseEnforcementBurden('transfer_settlements', scope5);
  assert.strictEqual(burden5, 3); // 2 + floor(5/3) = 2 + 1 = 3

  const scope10: TreatyScope = { kind: 'settlements', sids: Array.from({ length: 10 }, (_, i) => `sid${i}`) };
  const burden10 = getClauseEnforcementBurden('transfer_settlements', scope10);
  assert.strictEqual(burden10, 5); // 2 + floor(10/3) = 2 + 3 = 5
});

test('transfer_settlements: clause creation with giver/receiver', () => {
  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1', 'sid2'] },
    undefined, // tags
    'faction_b', // giver
    'faction_a' // receiver
  );

  assert.strictEqual(clause.kind, 'transfer_settlements');
  assert.strictEqual(clause.giver_side, 'faction_b');
  assert.strictEqual(clause.receiver_side, 'faction_a');
  assert.strictEqual(clause.cost, 4); // min(10, 2) * 2 = 4
  assert.strictEqual(clause.acceptance_impact, 4); // min(10, 2) * 2 = 4
});

test('transfer_settlements: acceptance includes heldness factor when giver controls settlements', () => {
  const state = createTestState();
  // Make faction_b control sid1 and sid2 (remove from faction_a first)
  const factionA = state.factions.find((f) => f.id === 'faction_a')!;
  const factionB = state.factions.find((f) => f.id === 'faction_b')!;
  factionA.areasOfResponsibility = []; // Remove sid1 and sid2 from faction_a
  factionB.areasOfResponsibility = ['sid3', 'sid4', 'sid1', 'sid2']; // faction_b controls sid1 and sid2

  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause(
        'c1',
        'territorial',
        'transfer_settlements',
        'faction_a',
        ['faction_b'],
        { kind: 'settlements', sids: ['sid1', 'sid2'] },
        undefined,
        'faction_b', // giver
        'faction_a' // receiver
      )
    ],
    totals: { cost_total: 4, acceptance_impact_total: 4, enforcement_burden_total: 2 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.per_target.length, 1);
  const target = report.per_target[0];
  assert.strictEqual(target.faction_id, 'faction_b');

  // faction_b has pressure 15, so pressure_factor = floor(15/5) = 3
  // faction_b pressure (15) > faction_a pressure (5), so reality_factor = 1
  // No monitoring, so guarantee_factor = 0
  // cost_factor = -4
  // cost_total = 4 < 10, so humiliation_factor = 0
  // No warnings, so warning_penalty = 0
  // heldness_factor = -2 (faction_b controls 2 settlements being transferred, capped at -6)
  // Total: 0 + 3 + 1 + 0 - 4 - 0 - 0 - 2 = -2

  assert.strictEqual(target.breakdown.pressure_factor, 3);
  assert.strictEqual(target.breakdown.reality_factor, 1);
  assert.strictEqual(target.breakdown.guarantee_factor, 0);
  assert.strictEqual(target.breakdown.cost_factor, -4);
  assert.strictEqual(target.breakdown.humiliation_factor, 0);
  assert.strictEqual(target.breakdown.warning_penalty, 0);
  assert.strictEqual(target.breakdown.heldness_factor, -2);
  assert.strictEqual(target.breakdown.total_score, -2);
  assert.strictEqual(target.accept, false);
});

test('transfer_settlements: heldness factor capped at -6', () => {
  const state = createTestState();
  // Make faction_b control many settlements
  const factionB = state.factions.find((f) => f.id === 'faction_b')!;
  // Create 10 settlements, all controlled by faction_b
  const manySids = Array.from({ length: 10 }, (_, i) => `sid${i + 10}`);
  factionB.areasOfResponsibility = ['sid3', 'sid4', ...manySids];

  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause(
        'c1',
        'territorial',
        'transfer_settlements',
        'faction_a',
        ['faction_b'],
        { kind: 'settlements', sids: manySids },
        undefined,
        'faction_b', // giver
        'faction_a' // receiver
      )
    ],
    totals: { cost_total: 20, acceptance_impact_total: 20, enforcement_burden_total: 5 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  const target = report.per_target[0];
  // heldness_factor should be capped at -6 even though 10 settlements are controlled
  assert.strictEqual(target.breakdown.heldness_factor, -6);
});

test('transfer_settlements: determinism regression', () => {
  const state = createTestState();
  const factionB = state.factions.find((f) => f.id === 'faction_b')!;
  factionB.areasOfResponsibility = ['sid3', 'sid4', 'sid1', 'sid2'];

  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TREATY_TEST',
    proposer_faction_id: 'faction_a',
    clauses: [
      createClause(
        'c1',
        'territorial',
        'transfer_settlements',
        'faction_a',
        ['faction_b'],
        { kind: 'settlements', sids: ['sid1', 'sid2'] },
        undefined,
        'faction_b',
        'faction_a'
      )
    ],
    totals: { cost_total: 4, acceptance_impact_total: 4, enforcement_burden_total: 2 },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];
  const report1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);
  const report2 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  // Should be identical
  assert.strictEqual(JSON.stringify(report1), JSON.stringify(report2));
  assert.strictEqual(report1.per_target[0].breakdown.heldness_factor, report2.per_target[0].breakdown.heldness_factor);
});
