/**
 * Phase 12D.0: Tests for end_state functionality
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { TreatyDraft } from '../src/state/treaty.js';
import type { TreatyAcceptanceReport } from '../src/state/treaty_acceptance.js';
import { applyTreaty } from '../src/state/treaty_apply.js';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import type { LoadedSettlementGraph } from '../src/map/settlements.js';
import { validateState } from '../src/validate/validate.js';
import { deserializeState, serializeState } from '../src/state/serialize.js';
import { runTurn } from '../src/sim/turn_pipeline.js';

function createTestState(turn: number = 5): GameState {
  return {
    schema_version: 1,
    meta: { turn, seed: 'test' },
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 10, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
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
        faction_id: 'RS',
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
      }
    ],
    accepted_by_all_targets: true,
    rejecting_factions: [],
    warnings: [],
    totals: draft.totals
  };
}

test('end_state: migration default is undefined', () => {
  const state = createTestState();
  assert.strictEqual(state.end_state, undefined);
  
  // Serialize and deserialize to test migration
  const serialized = serializeState(state);
  const deserialized = deserializeState(serialized);
  assert.strictEqual(deserialized.end_state, undefined);
});

test('end_state: validator catches bad fields deterministically', () => {
  const state = createTestState();
  
  // Test invalid kind
  (state as any).end_state = { kind: 'invalid', treaty_id: 't1', since_turn: 5 };
  let issues = validateState(state);
  assert.ok(issues.some((i) => i.code === 'end_state.kind.invalid'));
  
  // Test missing treaty_id
  (state as any).end_state = { kind: 'peace_treaty', treaty_id: '', since_turn: 5 };
  issues = validateState(state);
  assert.ok(issues.some((i) => i.code === 'end_state.treaty_id.invalid'));
  
  // Test invalid since_turn
  (state as any).end_state = { kind: 'peace_treaty', treaty_id: 't1', since_turn: -1 };
  issues = validateState(state);
  assert.ok(issues.some((i) => i.code === 'end_state.since_turn.invalid'));
  
  // Test since_turn > current turn
  (state as any).end_state = { kind: 'peace_treaty', treaty_id: 't1', since_turn: 10 };
  issues = validateState(state);
  assert.ok(issues.some((i) => i.code === 'end_state.since_turn.future'));
  
  // Test empty note
  (state as any).end_state = { kind: 'peace_treaty', treaty_id: 't1', since_turn: 5, note: '   ' };
  issues = validateState(state);
  assert.ok(issues.some((i) => i.code === 'end_state.note.empty'));
});

test('end_state: applying treaty with territorial effect sets end_state', async () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();
  
  // Set up control so RBiH controls sid1
  if (!state.control_overrides) state.control_overrides = {};
  state.control_overrides['sid1'] = {
    side: 'RBiH',
    kind: 'treaty_transfer',
    treaty_id: 'prev_treaty',
    since_turn: 1
  };
  
  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'RBiH',
    'RS'
  );
  
  const draft = buildTreatyDraft(5, 'RBiH', [clause]);
  const evalReport = createAcceptedEvalReport(draft);
  
  const result = applyTreaty(state, draft, evalReport, { settlementGraph: graph });
  
  assert.ok(result.state.end_state !== undefined);
  assert.strictEqual(result.state.end_state?.kind, 'peace_treaty');
  assert.strictEqual(result.state.end_state?.treaty_id, draft.treaty_id);
  assert.strictEqual(result.state.end_state?.since_turn, 5);
  assert.ok(result.report.end_state?.set === true);
});

test('end_state: applying treaty with corridor effect does NOT set end_state (deprecated)', async () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();
  
  const clause = createClause(
    'c1',
    'territorial',
    'corridor_right_of_way',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    undefined,
    undefined,
    'RBiH'
  );
  
  const draft = buildTreatyDraft(5, 'RBiH', [clause]);
  // Phase 12D.1: Deprecated clauses are rejected in acceptance, but if forced accepted, they don't trigger end_state
  const evalReport: TreatyAcceptanceReport = {
    ...createAcceptedEvalReport(draft),
    accepted_by_all_targets: true // Force acceptance to test apply behavior
  };
  
  const result = applyTreaty(state, draft, evalReport, { settlementGraph: graph });
  
  // Phase 12D.1: Deprecated corridor clauses do NOT set end_state
  assert.strictEqual(result.state.end_state, undefined);
  assert.ok(result.report.end_state?.set === false);
  assert.ok(result.report.corridor?.failures?.includes('deprecated_clause_noop'));
});

test('end_state: military-only treaty does not set end_state', async () => {
  const state = createTestState(5);
  
  const clause = createClause(
    'c1',
    'military',
    'ceasefire_global',
    'RBiH',
    ['RS'],
    { kind: 'global' },
    undefined
  );
  
  const draft = buildTreatyDraft(5, 'RBiH', [clause]);
  const evalReport = createAcceptedEvalReport(draft);
  
  const result = applyTreaty(state, draft, evalReport);
  
  assert.strictEqual(result.state.end_state, undefined);
  assert.ok(result.report.end_state?.set === false);
  assert.strictEqual(result.report.end_state?.reason, 'no_territorial_effects');
});

test('end_state: if end_state already exists, treaty apply does not overwrite', async () => {
  const state = createTestState(5);
  const graph = createTestSettlementGraph();
  
  // Set existing end_state
  state.end_state = {
    kind: 'peace_treaty',
    treaty_id: 'existing_treaty',
    since_turn: 3
  };
  
  // Set up control so RBiH controls sid1
  if (!state.control_overrides) state.control_overrides = {};
  state.control_overrides['sid1'] = {
    side: 'RBiH',
    kind: 'treaty_transfer',
    treaty_id: 'prev_treaty',
    since_turn: 1
  };
  
  const clause = createClause(
    'c1',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: ['sid1'] },
    undefined,
    'RBiH',
    'RS'
  );
  
  const draft = buildTreatyDraft(5, 'RBiH', [clause]);
  const evalReport = createAcceptedEvalReport(draft);
  
  const result = applyTreaty(state, draft, evalReport, { settlementGraph: graph });
  
  // end_state should not be overwritten
  assert.ok(result.state.end_state !== undefined);
  assert.strictEqual(result.state.end_state?.treaty_id, 'existing_treaty');
  assert.strictEqual(result.state.end_state?.since_turn, 3);
  assert.ok(result.report.end_state?.set === false);
  assert.strictEqual(result.report.end_state?.reason, 'already_in_end_state');
});

test('end_state: pipeline short-circuits when end_state exists', async () => {
  const state = createTestState(5);
  
  // Set end_state
  state.end_state = {
    kind: 'peace_treaty',
    treaty_id: 'test_treaty',
    since_turn: 5
  };
  
  // Store initial state snapshot
  const initialFrontSegments = JSON.stringify(state.front_segments);
  const initialFrontPressure = JSON.stringify(state.front_pressure);
  const initialTurn = state.meta.turn;
  
  // Run a turn
  const { nextState, report } = await runTurn(state, {
    seed: 'test_seed',
    settlementEdges: [] as any
  });
  
  // Check that end_state_active is set
  assert.strictEqual(report.end_state_active, true);
  
  // Check that turn was incremented
  assert.strictEqual(nextState.meta.turn, initialTurn + 1);
  
  // Check that war mutation phases were skipped (key fields unchanged)
  assert.strictEqual(JSON.stringify(nextState.front_segments), initialFrontSegments);
  assert.strictEqual(JSON.stringify(nextState.front_pressure), initialFrontPressure);
  
  // Check that only end_state_active phase ran
  assert.strictEqual(report.phases.length, 1);
  assert.strictEqual(report.phases[0].name, 'end_state_active');
});

test('end_state: pipeline runs normally when end_state does not exist', async () => {
  const state = createTestState(5);
  const initialTurn = state.meta.turn;
  
  // Run a turn
  const { nextState, report } = await runTurn(state, {
    seed: 'test_seed',
    settlementEdges: [] as any
  });
  
  // Check that end_state_active is not set
  assert.strictEqual(report.end_state_active, undefined);
  
  // Check that turn was incremented
  assert.strictEqual(nextState.meta.turn, initialTurn + 1);
  
  // Check that phases ran (should have more than just initialize)
  assert.ok(report.phases.length > 1);
});
