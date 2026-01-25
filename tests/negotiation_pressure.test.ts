import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/game_state.js';
import { updateNegotiationPressure } from '../src/state/negotiation_pressure.js';
import type { ExhaustionStats } from '../src/state/exhaustion.js';
import type { FormationFatigueStepReport } from '../src/state/formation_fatigue.js';
import type { MilitiaFatigueStepReport } from '../src/state/militia_fatigue.js';
import type { FrontEdge } from '../src/map/front_edges.js';

function createTestState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'test-seed' },
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
        negotiation: { pressure: 10, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };
}

test('negotiation pressure: increases by exhaustion delta', () => {
  const state = createTestState();
  const derivedFrontEdges: FrontEdge[] = [];

  const exhaustionReport: ExhaustionStats = {
    per_faction: [
      { faction_id: 'faction_a', exhaustion_before: 10, exhaustion_after: 13, delta: 3, work_supplied: 20, work_unsupplied: 5 },
      { faction_id: 'faction_b', exhaustion_before: 20, exhaustion_after: 20, delta: 0, work_supplied: 0, work_unsupplied: 0 }
    ]
  };

  const report = updateNegotiationPressure(state, derivedFrontEdges, exhaustionReport, undefined, undefined, undefined);

  strictEqual(report.per_faction.length, 2);
  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  strictEqual(factionA.pressure_before, 5);
  strictEqual(factionA.pressure_after, 8); // 5 + 3 (exhaustion delta)
  strictEqual(factionA.components.exhaustion_delta, 3);
  strictEqual(factionA.components.instability_breaches, 0);
  strictEqual(factionA.components.supply_formations, 0);
  strictEqual(factionA.components.supply_militia, 0);
  strictEqual(factionA.components.sustainability_collapse, 0);
  strictEqual(state.factions[0].negotiation?.pressure, 8);
  strictEqual(state.factions[0].negotiation?.last_change_turn, 5);

  const factionB = report.per_faction.find((f) => f.faction_id === 'faction_b');
  ok(factionB);
  strictEqual(factionB.pressure_before, 10);
  strictEqual(factionB.pressure_after, 10); // 10 + 0 (no exhaustion delta)
  strictEqual(factionB.components.exhaustion_delta, 0);
});

test('negotiation pressure: breach count contributes with cap', () => {
  const state = createTestState();
  // Set up front pressure to create breaches
  state.front_pressure = {
    edge1: { edge_id: 'edge1', value: 25, max_abs: 25, last_updated_turn: 5 },
    edge2: { edge_id: 'edge2', value: -22, max_abs: 22, last_updated_turn: 5 },
    edge3: { edge_id: 'edge3', value: 21, max_abs: 21, last_updated_turn: 5 },
    edge4: { edge_id: 'edge4', value: 23, max_abs: 23, last_updated_turn: 5 },
    edge5: { edge_id: 'edge5', value: 24, max_abs: 24, last_updated_turn: 5 }
  };
  state.front_segments = {
    edge1: { edge_id: 'edge1', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 },
    edge2: { edge_id: 'edge2', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 },
    edge3: { edge_id: 'edge3', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 },
    edge4: { edge_id: 'edge4', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 },
    edge5: { edge_id: 'edge5', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 }
  };

  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge2', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge3', a: 'sid1', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge4', a: 'sid2', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge5', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' }
  ];

  const report = updateNegotiationPressure(state, derivedFrontEdges, undefined, undefined, undefined, undefined);

  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  // faction_a is on side_a of 5 breaches, but cap is 3
  strictEqual(factionA.components.instability_breaches, 3);

  const factionB = report.per_faction.find((f) => f.faction_id === 'faction_b');
  ok(factionB);
  // faction_b is on side_b of 5 breaches, but cap is 3
  strictEqual(factionB.components.instability_breaches, 3);
});

test('negotiation pressure: unsupplied formations contribute with floor', () => {
  const state = createTestState();
  const derivedFrontEdges: FrontEdge[] = [];

  const formationFatigueReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [
      { faction_id: 'faction_a', formations_active: 12, formations_supplied: 7, formations_unsupplied: 5, total_fatigue: 10, total_commit_points: 5000 },
      { faction_id: 'faction_b', formations_active: 8, formations_supplied: 3, formations_unsupplied: 5, total_fatigue: 8, total_commit_points: 3000 }
    ]
  };

  const report = updateNegotiationPressure(state, derivedFrontEdges, undefined, formationFatigueReport, undefined, undefined);

  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  strictEqual(factionA.components.supply_formations, 1); // floor(5/5) = 1

  const factionB = report.per_faction.find((f) => f.faction_id === 'faction_b');
  ok(factionB);
  strictEqual(factionB.components.supply_formations, 1); // floor(5/5) = 1
});

test('negotiation pressure: unsupplied militia pools contribute with floor', () => {
  const state = createTestState();
  const derivedFrontEdges: FrontEdge[] = [];

  const militiaFatigueReport: MilitiaFatigueStepReport = {
    by_municipality: [],
    by_faction: [
      { faction_id: 'faction_a', pools_total: 15, pools_supplied: 5, pools_unsupplied: 10, total_fatigue: 20 },
      { faction_id: 'faction_b', pools_total: 8, pools_supplied: 3, pools_unsupplied: 5, total_fatigue: 8 }
    ]
  };

  const report = updateNegotiationPressure(state, derivedFrontEdges, undefined, undefined, militiaFatigueReport, undefined);

  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  strictEqual(factionA.components.supply_militia, 1); // floor(10/10) = 1

  const factionB = report.per_faction.find((f) => f.faction_id === 'faction_b');
  ok(factionB);
  strictEqual(factionB.components.supply_militia, 0); // floor(5/10) = 0
});

test('negotiation pressure: monotonic non-decreasing', () => {
  const state = createTestState();
  state.factions[0].negotiation = { pressure: 10, last_change_turn: 3, capital: 0, spent_total: 0, last_capital_change_turn: null };
  const derivedFrontEdges: FrontEdge[] = [];

  // Even with no inputs, pressure should not decrease
  const report = updateNegotiationPressure(state, derivedFrontEdges, undefined, undefined, undefined, undefined);

  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  strictEqual(factionA.pressure_after, 10); // unchanged, not decreased
  strictEqual(state.factions[0].negotiation?.pressure, 10);
});

test('negotiation pressure: all components combined', () => {
  const state = createTestState();
  state.factions[0].negotiation = { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null };
  const derivedFrontEdges: FrontEdge[] = [];

  const exhaustionReport: ExhaustionStats = {
    per_faction: [{ faction_id: 'faction_a', exhaustion_before: 10, exhaustion_after: 12, delta: 2, work_supplied: 15, work_unsupplied: 5 }]
  };

  const formationFatigueReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [{ faction_id: 'faction_a', formations_active: 10, formations_supplied: 5, formations_unsupplied: 5, total_fatigue: 5, total_commit_points: 5000 }]
  };

  const militiaFatigueReport: MilitiaFatigueStepReport = {
    by_municipality: [],
    by_faction: [{ faction_id: 'faction_a', pools_total: 10, pools_supplied: 0, pools_unsupplied: 10, total_fatigue: 10 }]
  };

  // Set up 2 breaches for faction_a
  state.front_pressure = {
    edge1: { edge_id: 'edge1', value: 25, max_abs: 25, last_updated_turn: 5 },
    edge2: { edge_id: 'edge2', value: 22, max_abs: 22, last_updated_turn: 5 }
  };
  state.front_segments = {
    edge1: { edge_id: 'edge1', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 },
    edge2: { edge_id: 'edge2', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 0, max_friction: 0 }
  };
  const derivedFrontEdgesWithBreaches: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge2', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' }
  ];

  const report = updateNegotiationPressure(
    state,
    derivedFrontEdgesWithBreaches,
    exhaustionReport,
    formationFatigueReport,
    militiaFatigueReport,
    undefined
  );

  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  ok(factionA);
  strictEqual(factionA.components.exhaustion_delta, 2);
  strictEqual(factionA.components.instability_breaches, 2); // 2 breaches, under cap
  strictEqual(factionA.components.supply_formations, 1); // floor(5/5) = 1
  strictEqual(factionA.components.supply_militia, 1); // floor(10/10) = 1
  strictEqual(factionA.components.sustainability_collapse, 0);
  strictEqual(factionA.total_increment, 6); // 2 + 2 + 1 + 1 + 0
  strictEqual(factionA.pressure_after, 6); // 0 + 6
  strictEqual(state.factions[0].negotiation?.last_change_turn, 5);
});

test('negotiation pressure: determinism across identical runs', () => {
  const state1 = createTestState();
  const state2 = createTestState();
  const derivedFrontEdges: FrontEdge[] = [];

  const exhaustionReport: ExhaustionStats = {
    per_faction: [{ faction_id: 'faction_a', exhaustion_before: 10, exhaustion_after: 13, delta: 3, work_supplied: 20, work_unsupplied: 5 }]
  };

  const report1 = updateNegotiationPressure(state1, derivedFrontEdges, exhaustionReport, undefined, undefined, undefined);
  const report2 = updateNegotiationPressure(state2, derivedFrontEdges, exhaustionReport, undefined, undefined, undefined);

  strictEqual(report1.per_faction.length, report2.per_faction.length);
  for (let i = 0; i < report1.per_faction.length; i += 1) {
    const f1 = report1.per_faction[i];
    const f2 = report2.per_faction[i];
    strictEqual(f1.faction_id, f2.faction_id);
    strictEqual(f1.pressure_before, f2.pressure_before);
    strictEqual(f1.pressure_after, f2.pressure_after);
    strictEqual(f1.delta, f2.delta);
    strictEqual(f1.components.exhaustion_delta, f2.components.exhaustion_delta);
    strictEqual(f1.components.instability_breaches, f2.components.instability_breaches);
    strictEqual(f1.components.supply_formations, f2.components.supply_formations);
    strictEqual(f1.components.supply_militia, f2.components.supply_militia);
    strictEqual(f1.components.sustainability_collapse, f2.components.sustainability_collapse);
  }
});
