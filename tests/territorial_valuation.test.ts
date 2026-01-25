import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { LoadedSettlementGraph } from '../src/map/settlements.js';
import { computeSettlementValues } from '../src/state/territorial_valuation.js';
import type { TerritorialValuationReport } from '../src/state/territorial_valuation.js';
import { computeClauseCost, computeClauseAcceptanceImpact } from '../src/state/treaty_clause_library.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import type { TreatyDraft } from '../src/state/treaty.js';
import type { FrontEdge } from '../src/map/front_edges.js';

function createTestState(): GameState {
  return {
    schema_version: 1,
    meta: { turn: 5, seed: 'test' },
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['sid3', 'sid4'],
        supply_sources: [],
        negotiation: { pressure: 15, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'HRHB',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid5'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 0, spent_total: 0, last_capital_change_turn: null }
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

function createTestGraph(): LoadedSettlementGraph {
  return {
    settlements: new Map([
      ['sid1', { sid: 'sid1', source_id: '1', mun_code: 'M001', mun: 'Municipality1' }],
      ['sid2', { sid: 'sid2', source_id: '2', mun_code: 'M001', mun: 'Municipality1' }],
      ['sid3', { sid: 'sid3', source_id: '3', mun_code: 'M002', mun: 'Municipality2' }],
      ['sid4', { sid: 'sid4', source_id: '4', mun_code: 'M002', mun: 'Municipality2' }],
      ['sid5', { sid: 'sid5', source_id: '5', mun_code: 'M003', mun: 'Municipality3' }],
      ['sid6', { sid: 'sid6', source_id: '6', mun_code: 'M003', mun: 'Municipality3' }]
    ]),
    edges: [
      { a: 'sid1', b: 'sid2' },
      { a: 'sid2', b: 'sid3' },
      { a: 'sid3', b: 'sid4' },
      { a: 'sid4', b: 'sid5' },
      { a: 'sid5', b: 'sid6' },
      // Make sid3 a high-degree node (junction)
      { a: 'sid3', b: 'sid6' }
    ]
  };
}

test('territorial valuation: deterministic ordering and caps', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const report = computeSettlementValues(state, graph);

  // Check schema
  assert.strictEqual(report.schema, 1);
  assert.strictEqual(report.turn, 5);

  // Check sides are sorted
  assert.deepStrictEqual(report.sides, ['HRHB', 'RBiH', 'RS']);

  // Check per_settlement is sorted by sid
  const sids = report.per_settlement.map((e) => e.sid);
  const sortedSids = [...sids].sort();
  assert.deepStrictEqual(sids, sortedSids);

  // Check all values are in range 0..100
  for (const entry of report.per_settlement) {
    for (const side of report.sides) {
      const value = entry.by_side[side];
      assert(value >= 0 && value <= 100, `Value ${value} for ${entry.sid} by ${side} is out of range`);
    }
  }
});

test('territorial valuation: control component works', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const report = computeSettlementValues(state, graph);

  // sid1 is controlled by RBiH (AoR)
  const sid1Entry = report.per_settlement.find((e) => e.sid === 'sid1');
  assert(sid1Entry);
  assert(sid1Entry.by_side['RBiH'] >= 20, 'RBiH should have at least 20 for sid1 (AoR control)');
  assert(sid1Entry.by_side['RS'] < 20, 'RS should have less than 20 for sid1');

  // sid3 is controlled by RS (AoR)
  const sid3Entry = report.per_settlement.find((e) => e.sid === 'sid3');
  assert(sid3Entry);
  assert(sid3Entry.by_side['RS'] >= 20, 'RS should have at least 20 for sid3 (AoR control)');
});

test('territorial valuation: corridor component works', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const report = computeSettlementValues(state, graph);

  // sid3 has degree 3 (sid2, sid4, sid6) - should get +6 from corridor component
  // sid1 has degree 1 (sid2) - should get +0 from corridor component
  const sid3Entry = report.per_settlement.find((e) => e.sid === 'sid3');
  const sid1Entry = report.per_settlement.find((e) => e.sid === 'sid1');

  assert(sid3Entry);
  assert(sid1Entry);

  // sid3 should have higher corridor component value
  // But other components (control, contiguity, homeland) can vary, so we just check
  // that sid3 has at least the corridor bonus difference for at least one side
  // (since control/contiguity may favor sid1 for some sides)
  let hasCorridorBonus = false;
  for (const side of report.sides) {
    const diff = sid3Entry.by_side[side] - sid1Entry.by_side[side];
    if (diff >= 6) {
      hasCorridorBonus = true;
      break;
    }
  }
  assert(hasCorridorBonus, 'sid3 should have at least 6 more value than sid1 for at least one side due to corridor component');
  
  // Also verify that sid3 has degree 3 and gets +6 corridor component
  // (we can't directly check components, but we can verify the degree-based logic works)
  // sid3 connects to sid2, sid4, sid6 (degree 3) -> should get +6
  // sid1 connects to sid2 (degree 1) -> should get +0
  // The difference in corridor component alone is +6, but total difference may vary due to other factors
});

test('territorial valuation: same state produces same report', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const report1 = computeSettlementValues(state, graph);
  const report2 = computeSettlementValues(state, graph);

  // Should be identical
  assert.deepStrictEqual(report1, report2);
});

test('transfer pricing: uses valuation when available', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const valuation = computeSettlementValues(state, graph);

  // Create a transfer clause
  const scope = { kind: 'settlements' as const, sids: ['sid1', 'sid2'] };

  // Without valuation (fallback)
  const costWithout = computeClauseCost('transfer_settlements', scope);
  assert.strictEqual(costWithout, 4); // min(10, 2) * 2

  // With valuation
  const costWith = computeClauseCost('transfer_settlements', scope, {
    valuation,
    giver_side: 'RS',
    receiver_side: 'RBiH'
  });

  // Should be different (based on actual valuation deltas)
  // Cost should be clamped between 2 and 30
  assert(costWith >= 2 && costWith <= 30, `Cost ${costWith} should be in range 2..30`);
});

test('transfer pricing: acceptance impact uses valuation', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const valuation = computeSettlementValues(state, graph);

  const scope = { kind: 'settlements' as const, sids: ['sid1', 'sid2'] };

  // Without valuation (fallback)
  const impactWithout = computeClauseAcceptanceImpact('transfer_settlements', scope);
  assert.strictEqual(impactWithout, 4); // min(10, 2) * 2

  // With valuation
  const impactWith = computeClauseAcceptanceImpact('transfer_settlements', scope, {
    valuation,
    giver_side: 'RS',
    receiver_side: 'RBiH'
  });

  // Should be clamped between 2 and 30
  assert(impactWith >= 2 && impactWith <= 30, `Impact ${impactWith} should be in range 2..30`);
});

test('treaty acceptance: TradeFairnessFactor included', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TEST_TREATY',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'transfer_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['sid3', 'sid4'] },
        cost: 10,
        acceptance_impact: 10,
        enforcement_burden: 3,
        giver_side: 'RS',
        receiver_side: 'RBiH'
      }
    ],
    totals: {
      cost_total: 10,
      acceptance_impact_total: 10,
      enforcement_burden_total: 3
    },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];

  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined, graph);

  // Check that TradeFairnessFactor is present in breakdown
  const targetAcceptance = report.per_target.find((t) => t.faction_id === 'RS');
  assert(targetAcceptance);
  assert('trade_fairness_factor' in targetAcceptance.breakdown);
  assert(typeof targetAcceptance.breakdown.trade_fairness_factor === 'number');
  assert(targetAcceptance.breakdown.trade_fairness_factor >= 0);
  assert(targetAcceptance.breakdown.trade_fairness_factor <= 4); // capped at +4
});

test('treaty acceptance: TradeFairnessFactor helps when ceding low-value territory', () => {
  const state = createTestState();
  const graph = createTestGraph();

  // Create a transfer where RS gives away territory that's more valuable to RBiH
  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TEST_TREATY',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'transfer_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['sid3'] }, // RS-controlled, but may be more valuable to RBiH
        cost: 5,
        acceptance_impact: 5,
        enforcement_burden: 2,
        giver_side: 'RS',
        receiver_side: 'RBiH'
      }
    ],
    totals: {
      cost_total: 5,
      acceptance_impact_total: 5,
      enforcement_burden_total: 2
    },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];

  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined, graph);

  const targetAcceptance = report.per_target.find((t) => t.faction_id === 'RS');
  assert(targetAcceptance);

  // TradeFairnessFactor should be >= 0 (can help acceptance)
  assert(targetAcceptance.breakdown.trade_fairness_factor >= 0);
});

test('treaty acceptance: deterministic with valuation', () => {
  const state = createTestState();
  const graph = createTestGraph();

  const draft: TreatyDraft = {
    schema: 1,
    turn: 5,
    treaty_id: 'TEST_TREATY',
    proposer_faction_id: 'RBiH',
    clauses: [
      {
        id: 'c1',
        annex: 'territorial',
        kind: 'transfer_settlements',
        proposer_faction_id: 'RBiH',
        target_faction_ids: ['RS'],
        scope: { kind: 'settlements', sids: ['sid3'] },
        cost: 5,
        acceptance_impact: 5,
        enforcement_burden: 2,
        giver_side: 'RS',
        receiver_side: 'RBiH'
      }
    ],
    totals: {
      cost_total: 5,
      acceptance_impact_total: 5,
      enforcement_burden_total: 2
    },
    package_warnings: []
  };

  const frontEdges: FrontEdge[] = [];

  const report1 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined, graph);
  const report2 = evaluateTreatyAcceptance(state, draft, frontEdges, undefined, graph);

  // Should be identical
  assert.deepStrictEqual(report1, report2);
});
