import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { TreatyDraft } from '../src/state/treaty.js';
import type { TreatyAcceptanceReport } from '../src/state/treaty_acceptance.js';
import { applyTreatyMilitaryAnnex } from '../src/state/treaty_apply.js';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import type { FrontRegionsFile } from '../src/map/front_regions.js';

function createTestState(turn: number = 5): GameState {
  return {
    schema_version: 1,
    meta: { turn, seed: 'test' },
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
    front_segments: {
      'sid1__sid3': { edge_id: 'sid1__sid3', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 1, max_friction: 1 },
      'sid2__sid4': { edge_id: 'sid2__sid4', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 1, max_friction: 1 }
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_ledger: []
  };
}

function createTestFrontEdges(): FrontEdge[] {
  return [
    { edge_id: 'sid1__sid3', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'sid2__sid4', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' }
  ];
}

function createTestFrontRegions(): FrontRegionsFile {
  return {
    schema: 1,
    turn: 5,
    regions: [
      {
        region_id: 'faction_a--faction_b::sid1__sid3',
        side_pair: 'faction_a--faction_b',
        edge_ids: ['sid1__sid3'],
        settlements: ['sid1', 'sid3'],
        active_edge_count: 1
      },
      {
        region_id: 'faction_a--faction_b::sid2__sid4',
        side_pair: 'faction_a--faction_b',
        edge_ids: ['sid2__sid4'],
        settlements: ['sid2', 'sid4'],
        active_edge_count: 1
      }
    ]
  };
}

function createAcceptedEvalReport(draft: TreatyDraft): TreatyAcceptanceReport {
  return {
    treaty_id: draft.treaty_id,
    turn: draft.turn,
    proposer_faction_id: draft.proposer_faction_id,
    per_target: [
      {
        faction_id: 'faction_b',
        accept: true,
        breakdown: {
          base_will: 0,
          pressure_factor: 3,
          reality_factor: 1,
          guarantee_factor: 0,
          cost_factor: -6,
          humiliation_factor: 0,
          warning_penalty: 0,
          heldness_factor: 0,
          trade_fairness_factor: 0,
          competence_factor: 0,
          total_score: -2
        },
        reasons: ['pressure_factor_+3', 'reality_factor_+1', 'cost_factor_-6']
      }
    ],
    accepted_by_all_targets: true,
    rejecting_factions: [],
    warnings: [],
    totals: draft.totals
  };
}

test('treaty apply: fails if not accepted_by_all_targets', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport: TreatyAcceptanceReport = {
    ...createAcceptedEvalReport(draft),
    accepted_by_all_targets: false,
    rejecting_factions: ['faction_b']
  };

  const { report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: createTestFrontEdges()
  });

  assert.strictEqual(report.applied, false);
  assert.strictEqual(report.reason, 'not_accepted_by_all_targets');
  assert.strictEqual(report.military.freeze_edges_total, 0);
});

test('treaty apply: fails if turn mismatch', () => {
  const state = createTestState(5);
  const draft = buildTreatyDraft(6, 'faction_a', [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);

  const { report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: createTestFrontEdges()
  });

  assert.strictEqual(report.applied, false);
  assert.strictEqual(report.reason, 'turn_mismatch');
});

test('treaty apply: fails if no military clauses', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'territorial', 'recognize_control_settlements', 'faction_a', ['faction_b'], {
      kind: 'settlements',
      sids: ['sid1']
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);

  const { report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: createTestFrontEdges()
  });

  assert.strictEqual(report.applied, false);
  assert.strictEqual(report.reason, 'no_military_clauses');
});

test('treaty apply: global ceasefire freezes all active edges deterministically', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.freeze_edges_added, 2);
  assert.strictEqual(report.military.freeze_edges_total, 2);
  assert.strictEqual(report.military.monitoring_level, 'none');
  assert.strictEqual(report.military.duration_turns, 'indefinite');

  // Check ceasefire entries
  assert.ok(updatedState.ceasefire);
  assert.ok(updatedState.ceasefire!['sid1__sid3']);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].since_turn, 5);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, null); // indefinite
  assert.ok(updatedState.ceasefire!['sid2__sid4']);
  assert.strictEqual(updatedState.ceasefire!['sid2__sid4'].since_turn, 5);
  assert.strictEqual(updatedState.ceasefire!['sid2__sid4'].until_turn, null);

  // Check negotiation status
  assert.strictEqual(updatedState.negotiation_status?.ceasefire_active, true);
  assert.strictEqual(updatedState.negotiation_status?.last_offer_turn, 5);

  // Check sorted freeze_edges
  assert.deepStrictEqual(report.freeze_edges, ['sid1__sid3', 'sid2__sid4']);
});

test('treaty apply: freeze_region freezes only region active edges', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_region', 'faction_a', ['faction_b'], {
      kind: 'region',
      region_id: 'faction_a--faction_b::sid1__sid3'
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();
  const frontRegions = createTestFrontRegions();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges,
    frontRegions
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.freeze_edges_added, 1);
  assert.strictEqual(report.military.freeze_edges_total, 1);
  assert.strictEqual(report.military.duration_turns, 6); // base 6 turns

  assert.ok(updatedState.ceasefire);
  assert.ok(updatedState.ceasefire!['sid1__sid3']);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].since_turn, 5);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, 11); // 5 + 6
  assert.ok(!updatedState.ceasefire!['sid2__sid4']); // not in region
});

test('treaty apply: freeze_edges freezes specified edges', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_edges', 'faction_a', ['faction_b'], {
      kind: 'edges',
      edge_ids: ['sid1__sid3']
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.freeze_edges_added, 1);
  assert.strictEqual(report.military.freeze_edges_total, 1);
  assert.strictEqual(report.military.duration_turns, 4); // base 4 turns

  assert.ok(updatedState.ceasefire);
  assert.ok(updatedState.ceasefire!['sid1__sid3']);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].since_turn, 5);
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, 9); // 5 + 4
});

test('treaty apply: monitoring modifies duration deterministically', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_edges', 'faction_a', ['faction_b'], {
      kind: 'edges',
      edge_ids: ['sid1__sid3']
    }),
    createClause('c2', 'military', 'monitoring_light', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.monitoring_level, 'light');
  assert.strictEqual(report.military.duration_turns, 6); // 4 base + 2 light

  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, 11); // 5 + 6
});

test('treaty apply: monitoring_robust adds +4 turns', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_region', 'faction_a', ['faction_b'], {
      kind: 'region',
      region_id: 'faction_a--faction_b::sid1__sid3'
    }),
    createClause('c2', 'military', 'monitoring_robust', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();
  const frontRegions = createTestFrontRegions();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges,
    frontRegions
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.monitoring_level, 'robust');
  assert.strictEqual(report.military.duration_turns, 10); // 6 base + 4 robust

  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, 15); // 5 + 10
});

test('treaty apply: monitoring does not affect indefinite freezes', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' }),
    createClause('c2', 'military', 'monitoring_robust', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  assert.strictEqual(report.military.monitoring_level, 'robust');
  assert.strictEqual(report.military.duration_turns, 'indefinite'); // monitoring doesn't change indefinite

  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, null);
  assert.strictEqual(updatedState.ceasefire!['sid2__sid4'].until_turn, null);
});

test('treaty apply: merge behavior extends until_turn deterministically', () => {
  const state = createTestState();
  // Pre-existing freeze entry
  state.ceasefire = {
    'sid1__sid3': {
      since_turn: 3,
      until_turn: 8 // expires at turn 8
    }
  };
  state.negotiation_status = {
    ceasefire_active: true,
    ceasefire_since_turn: 3,
    last_offer_turn: 3
  };

  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_edges', 'faction_a', ['faction_b'], {
      kind: 'edges',
      edge_ids: ['sid1__sid3']
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  // Should keep earliest since_turn, extend until_turn
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].since_turn, 3); // kept earliest
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, 9); // extended to 5 + 4 = 9 (max of 8 and 9)
});

test('treaty apply: merge with indefinite keeps indefinite', () => {
  const state = createTestState();
  // Pre-existing indefinite freeze
  state.ceasefire = {
    'sid1__sid3': {
      since_turn: 3,
      until_turn: null // indefinite
    }
  };

  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_edges', 'faction_a', ['faction_b'], {
      kind: 'edges',
      edge_ids: ['sid1__sid3']
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState, report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  // Indefinite should win
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].since_turn, 3); // kept earliest
  assert.strictEqual(updatedState.ceasefire!['sid1__sid3'].until_turn, null); // indefinite wins
});

test('treaty apply: determinism regression - same inputs => identical report and state', () => {
  const state1 = createTestState();
  const state2 = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'ceasefire_global', 'faction_a', ['faction_b'], { kind: 'global' }),
    createClause('c2', 'military', 'monitoring_light', 'faction_a', ['faction_b'], { kind: 'global' })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { state: updatedState1, report: report1 } = applyTreatyMilitaryAnnex(state1, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  const { state: updatedState2, report: report2 } = applyTreatyMilitaryAnnex(state2, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  // Reports should be identical
  assert.strictEqual(JSON.stringify(report1), JSON.stringify(report2));

  // State ceasefire entries should be identical
  assert.deepStrictEqual(updatedState1.ceasefire, updatedState2.ceasefire);
  assert.strictEqual(updatedState1.negotiation_status?.ceasefire_active, updatedState2.negotiation_status?.ceasefire_active);
  assert.strictEqual(updatedState1.negotiation_status?.last_offer_turn, updatedState2.negotiation_status?.last_offer_turn);
});

test('treaty apply: warning for inactive edge in freeze_edges', () => {
  const state = createTestState();
  const draft = buildTreatyDraft(5, 'faction_a', [
    createClause('c1', 'military', 'freeze_edges', 'faction_a', ['faction_b'], {
      kind: 'edges',
      edge_ids: ['sid1__sid3', 'nonexistent_edge']
    })
  ]);
  const evalReport = createAcceptedEvalReport(draft);
  const frontEdges = createTestFrontEdges();

  const { report } = applyTreatyMilitaryAnnex(state, draft, evalReport, {
    derivedFrontEdges: frontEdges
  });

  assert.strictEqual(report.applied, true);
  assert.ok(report.warnings.includes('edge_not_active:nonexistent_edge'));
  assert.strictEqual(report.military.freeze_edges_added, 1); // only active edge frozen
});
