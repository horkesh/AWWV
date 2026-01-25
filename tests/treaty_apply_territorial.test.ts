import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { TreatyDraft } from '../src/state/treaty.js';
import type { TreatyAcceptanceReport } from '../src/state/treaty_acceptance.js';
import { applyTreatyTerritorialAnnex } from '../src/state/treaty_apply.js';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import type { LoadedSettlementGraph } from '../src/map/settlements.js';
import { getEffectiveSettlementSide } from '../src/state/control_effective.js';

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
        negotiation: { pressure: 5, last_change_turn: 3, capital: 10, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'faction_b',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['sid3', 'sid4'],
        supply_sources: [],
        negotiation: { pressure: 15, last_change_turn: 4, capital: 5, spent_total: 0, last_capital_change_turn: null }
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
      ['sid1', { sid: 'sid1', source_id: '1', mun_code: 'M1', mun: 'Municipality1' }],
      ['sid2', { sid: 'sid2', source_id: '2', mun_code: 'M1', mun: 'Municipality1' }],
      ['sid3', { sid: 'sid3', source_id: '3', mun_code: 'M2', mun: 'Municipality2' }],
      ['sid4', { sid: 'sid4', source_id: '4', mun_code: 'M2', mun: 'Municipality2' }]
    ]),
    edges: []
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

test('territorial apply: transfer_settlements applies and creates control_overrides', () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'faction_a',
    'faction_b'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.applied_transfers, 1);
  assert.strictEqual(report.spent_capital, 2); // min(10, 1) * 2 = 2
  assert.strictEqual(report.transfers.length, 1);
  assert.strictEqual(report.transfers[0].sid, 'sid1');
  assert.strictEqual(report.transfers[0].from, 'faction_a');
  assert.strictEqual(report.transfers[0].to, 'faction_b');

  // Check state changes
  assert.ok(result.state.control_overrides);
  assert.ok(result.state.control_overrides!['sid1']);
  assert.strictEqual(result.state.control_overrides!['sid1'].side, 'faction_b');
  assert.strictEqual(result.state.control_overrides!['sid1'].kind, 'treaty_transfer');
  assert.strictEqual(result.state.control_overrides!['sid1'].treaty_id, draft.treaty_id);
  assert.strictEqual(result.state.control_overrides!['sid1'].since_turn, 5);

  // Check recognition was also written
  assert.ok(result.state.control_recognition);
  assert.ok(result.state.control_recognition!['sid1']);
  assert.strictEqual(result.state.control_recognition!['sid1'].side, 'faction_b');

  // Check effective control changed
  assert.strictEqual(getEffectiveSettlementSide(result.state, 'sid1'), 'faction_b');

  // Check capital was spent
  const proposer = result.state.factions.find((f) => f.id === 'faction_a');
  assert.ok(proposer);
  assert.ok(proposer.negotiation);
  assert.strictEqual(proposer.negotiation.capital, 8); // 10 - 2
  assert.strictEqual(proposer.negotiation.spent_total, 2);

  // Check ledger entry
  assert.ok(result.state.negotiation_ledger);
  const ledgerEntry = result.state.negotiation_ledger.find((e) => e.reason === 'treaty_territory');
  assert.ok(ledgerEntry);
  assert.strictEqual(ledgerEntry.amount, 2);
  assert.strictEqual(ledgerEntry.kind, 'spend');
});

test('territorial apply: fails if insufficient capital', () => {
  const state = createTestState(5);
  state.factions[0].negotiation!.capital = 1; // Less than cost (cost is 2 for 1 settlement)
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'faction_a',
    'faction_b'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.applied_transfers, 0);
  assert.strictEqual(report.spent_capital, 0);
  assert.ok(report.failures);
  assert.ok(report.failures!.includes('insufficient_capital'));

  // No state changes
  assert.strictEqual(getEffectiveSettlementSide(result.state, 'sid1'), 'faction_a');
  assert.strictEqual(result.state.factions[0].negotiation!.capital, 1); // Should remain unchanged
});

test('territorial apply: infeasible transfer fails cleanly', () => {
  const state = createTestState(5);
  // sid1 is controlled by faction_a, but we'll try to transfer from faction_b
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'faction_b', // Wrong giver
    'faction_a'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.applied_transfers, 0);
  assert.ok(report.failures);
  assert.ok(report.failures!.some((f) => f.startsWith('infeasible_transfer')));

  // No state changes
  assert.strictEqual(getEffectiveSettlementSide(result.state, 'sid1'), 'faction_a');
  assert.ok(!result.state.control_overrides || !result.state.control_overrides['sid1']);
});

test('territorial apply: recognize_control_settlements applies when effective control matches', () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'recognize_control_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] }
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.applied_recognitions, 1);
  assert.strictEqual(report.spent_capital, 1); // 1 settlement * 1 = 1
  assert.strictEqual(report.recognitions.length, 1);
  assert.strictEqual(report.recognitions[0].sid, 'sid1');
  assert.strictEqual(report.recognitions[0].side, 'faction_a');

  // Check recognition was written
  assert.ok(result.state.control_recognition);
  assert.ok(result.state.control_recognition!['sid1']);
  assert.strictEqual(result.state.control_recognition!['sid1'].side, 'faction_a');
  assert.strictEqual(result.state.control_recognition!['sid1'].treaty_id, draft.treaty_id);

  // Recognition does not change effective control (no override)
  assert.strictEqual(getEffectiveSettlementSide(result.state, 'sid1'), 'faction_a');
});

test('territorial apply: recognition fails if effective control does not match', () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();

  // Try to recognize sid3 (controlled by faction_b) as faction_a
  const clause = createClause(
    'c1',
    'territorial',
    'recognize_control_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid3'] }
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.applied_recognitions, 0);
  assert.strictEqual(report.spent_capital, 0);
  assert.ok(report.failures);
  assert.ok(report.failures!.some((f) => f.includes('cannot_recognize_without_effective_control')));
});

test('territorial apply: deterministic report ordering', () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid2', 'sid1'] }, // Unsorted
    undefined,
    'faction_a',
    'faction_b'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  // Should be sorted by sid
  assert.ok(result.report);
  const report = result.report;
  assert.strictEqual(report.transfers.length, 2);
  assert.strictEqual(report.transfers[0].sid, 'sid1');
  assert.strictEqual(report.transfers[1].sid, 'sid2');
});

test('territorial apply: ledger entry appended deterministically', () => {
  const state = createTestState(5);
  state.negotiation_ledger = [
    {
      id: 'NLED_5_faction_a_spend_1',
      turn: 5,
      faction_id: 'faction_a',
      kind: 'spend',
      amount: 1,
      reason: 'pre_treaty_reserve'
    }
  ];
  const graph = createTestSettlementGraph();

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'faction_a',
    'faction_b'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  // Should have 2 ledger entries now
  assert.strictEqual(result.state.negotiation_ledger!.length, 2);
  const territoryEntry = result.state.negotiation_ledger!.find((e) => e.reason === 'treaty_territory');
  assert.ok(territoryEntry);
  assert.strictEqual(territoryEntry.id, 'NLED_5_faction_a_spend_treaty_territory_2'); // seq should be 2
});

test('territorial apply: does not touch breach/control drift system', () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();

  // Ensure AoR is unchanged
  const originalAoR = [...state.factions[0].areasOfResponsibility];

  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'faction_a',
    ['faction_b'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'faction_a',
    'faction_b'
  );

  const draft = buildTreatyDraft(5, 'faction_a', [clause]);

  const evalReport = createAcceptedEvalReport(draft);

  const result = applyTreatyTerritorialAnnex(state, draft, evalReport, { settlementGraph: graph });

  assert.ok(result.report);
  // AoR should be unchanged (control_overrides overlays it)
  assert.deepStrictEqual(result.state.factions[0].areasOfResponsibility, originalAoR);

  // Effective control should reflect override
  assert.strictEqual(getEffectiveSettlementSide(result.state, 'sid1'), 'faction_b');
});
