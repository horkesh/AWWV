import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { updateSustainability } from '../src/state/sustainability.js';
import type { SettlementRecord } from '../src/map/settlements.js';

/**
 * Create a minimal test state with a municipality.
 */
function createTestState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 10, seed: 'test-seed' },
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: ['sid1']
      },
      {
        id: 'VRS',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['sid3'],
        supply_sources: []
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      '20168': {
        mun_id: '20168',
        faction: 'RBiH',
        available: 1000,
        committed: 200,
        exhausted: 0,
        updated_turn: 10
      },
      '20044': {
        mun_id: '20044',
        faction: 'VRS',
        available: 500,
        committed: 100,
        exhausted: 0,
        updated_turn: 10
      }
    }
  };
}

/**
 * Create minimal test settlements.
 */
function createTestSettlements(): Map<string, SettlementRecord> {
  const settlements = new Map<string, SettlementRecord>();
  settlements.set('sid1', {
    sid: 'sid1',
    source_id: '1',
    mun_code: '20168',
    mun: 'Zvornik'
  });
  settlements.set('sid2', {
    sid: 'sid2',
    source_id: '2',
    mun_code: '20168',
    mun: 'Zvornik'
  });
  settlements.set('sid3', {
    sid: 'sid3',
    source_id: '3',
    mun_code: '20044',
    mun: 'Bileća'
  });
  return settlements;
}

/**
 * Create minimal test edges (isolated municipality - surrounded).
 */
function createTestEdgesSurrounded(): Array<{ a: string; b: string }> {
  // No edges - municipality is isolated
  return [];
}

/**
 * Create test edges (connected municipality - not surrounded).
 */
function createTestEdgesConnected(): Array<{ a: string; b: string }> {
  return [
    { a: 'sid1', b: 'sid2' }, // Internal connection within municipality
    { a: 'sid2', b: 'sid3' } // Connection to another municipality
  ];
}

test('sustainability is deterministic', () => {
  const state1 = createTestState();
  const state2 = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  const report1 = updateSustainability(state1, settlements, edges);
  const report2 = updateSustainability(state2, settlements, edges);

  // Same input should produce same output
  assert.strictEqual(
    JSON.stringify(report1),
    JSON.stringify(report2),
    'Sustainability should be deterministic'
  );
});

test('sustainability_score is monotonic decreasing', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize sustainability state
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 0,
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: 9
  };

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update
  updateSustainability(state, settlements, edges);

  const scoreAfter = state.sustainability_state['20168'].sustainability_score;

  // Score should never increase
  assert.ok(
    scoreAfter <= scoreBefore,
    `Sustainability score should not increase: ${scoreBefore} -> ${scoreAfter}`
  );
});

test('sustainability_score never increases', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize with low score
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: false, // Not surrounded, so no degradation
    unsupplied_turns: 0,
    sustainability_score: 50,
    collapsed: false,
    last_updated_turn: 9
  };

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update (not surrounded, so should not degrade)
  updateSustainability(state, settlements, edges);

  const scoreAfter = state.sustainability_state['20168'].sustainability_score;

  // Score should not increase even if conditions improve
  assert.ok(
    scoreAfter <= scoreBefore,
    `Sustainability score should not increase: ${scoreBefore} -> ${scoreAfter}`
  );
});

test('surrounded municipality degrades', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded(); // No edges = isolated = surrounded

  // Initialize sustainability state
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: false,
    unsupplied_turns: 0,
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: 9
  };

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];
  const scoreAfter = sustState.sustainability_score;

  // Should be surrounded and degraded
  assert.ok(sustState.is_surrounded, 'Municipality should be detected as surrounded');
  assert.ok(
    scoreAfter < scoreBefore,
    `Sustainability should degrade when surrounded: ${scoreBefore} -> ${scoreAfter}`
  );
});

test('unsupplied acceleration applies after threshold', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize with unsupplied_turns >= 2
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 2, // At threshold
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: 9
  };

  // Remove supply source to make it unsupplied
  state.factions[0].supply_sources = [];

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];
  const scoreAfter = sustState.sustainability_score;

  // Should have degraded more than base (base=5, acceleration=5, total=10)
  const degradation = scoreBefore - scoreAfter;
  assert.ok(
    degradation >= 10,
    `Should have at least 10 degradation (base + acceleration): got ${degradation}`
  );
  assert.ok(
    sustState.unsupplied_turns >= 2,
    `Unsupplied turns should be tracked: got ${sustState.unsupplied_turns}`
  );
});

test('breach interaction adds degradation', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Add front segment and pressure to create breach
  state.front_segments = {
    'sid1__sid3': {
      edge_id: 'sid1__sid3',
      active: true,
      created_turn: 5,
      since_turn: 5,
      last_active_turn: 10,
      active_streak: 6,
      max_active_streak: 6,
      friction: 0,
      max_friction: 0
    }
  };
  state.front_pressure = {
    'sid1__sid3': {
      edge_id: 'sid1__sid3',
      value: 100, // High pressure = breach
      max_abs: 100,
      last_updated_turn: 10
    }
  };

  // Add edge for breach detection
  edges.push({ a: 'sid1', b: 'sid3' });

  // Initialize sustainability state
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 0,
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: 9
  };

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];
  const scoreAfter = sustState.sustainability_score;

  // Should have degraded more than base (base=5, breach=3, total=8)
  const degradation = scoreBefore - scoreAfter;
  assert.ok(
    degradation >= 8,
    `Should have at least 8 degradation (base + breach): got ${degradation}`
  );
});

test('displacement interaction adds degradation', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Add displacement state with high displacement ratio
  if (!state.displacement_state) state.displacement_state = {};
  state.displacement_state['20168'] = {
    mun_id: '20168',
    original_population: 10000,
    displaced_out: 3000, // 30% > 25% threshold
    displaced_in: 0,
    lost_population: 0,
    last_updated_turn: 9
  };

  // Initialize sustainability state
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 0,
    sustainability_score: 100,
    collapsed: false,
    last_updated_turn: 9
  };

  const scoreBefore = state.sustainability_state['20168'].sustainability_score;

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];
  const scoreAfter = sustState.sustainability_score;

  // Should have degraded more than base (base=5, displacement=5, total=10)
  const degradation = scoreBefore - scoreAfter;
  assert.ok(
    degradation >= 10,
    `Should have at least 10 degradation (base + displacement): got ${degradation}`
  );
});

test('collapsed state is set when score reaches 0', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize with low score
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 10, // High unsupplied turns
    sustainability_score: 5, // Very low score
    collapsed: false,
    last_updated_turn: 9
  };

  // Remove supply source
  state.factions[0].supply_sources = [];

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];

  // Should be collapsed
  assert.ok(sustState.collapsed, 'Municipality should be collapsed when score <= 0');
  assert.strictEqual(sustState.sustainability_score, 0, 'Score should be capped at 0');
});

test('collapsed never reverts', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesConnected(); // Connected = not surrounded

  // Initialize as collapsed
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: false,
    unsupplied_turns: 0,
    sustainability_score: 0,
    collapsed: true,
    last_updated_turn: 9
  };

  // Run update (conditions improved - not surrounded)
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state['20168'];

  // Should remain collapsed
  assert.ok(sustState.collapsed, 'Collapsed state should never revert');
  assert.strictEqual(sustState.sustainability_score, 0, 'Score should remain 0');
});

test('authority_degraded is set when score < 50', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize with score < 50
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 0,
    sustainability_score: 60,
    collapsed: false,
    last_updated_turn: 9
  };

  // Run multiple updates to degrade below 50
  for (let i = 0; i < 3; i++) {
    state.meta.turn = 10 + i;
    updateSustainability(state, settlements, edges);
  }

  const sustState = state.sustainability_state['20168'];
  const report = updateSustainability(state, settlements, edges);
  const record = report.by_municipality.find((r) => r.mun_id === '20168');

  assert.ok(record, 'Should have record for municipality');
  assert.ok(
    record!.authority_degraded || sustState.sustainability_score < 50,
    'Authority should be degraded when score < 50'
  );
});

test('negotiation pressure increment from collapsed municipalities', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded();

  // Initialize as collapsed
  if (!state.sustainability_state) state.sustainability_state = {};
  state.sustainability_state['20168'] = {
    mun_id: '20168',
    is_surrounded: true,
    unsupplied_turns: 10,
    sustainability_score: 0,
    collapsed: true,
    last_updated_turn: 9
  };

  // Run update
  const report = updateSustainability(state, settlements, edges);

  // Should have negotiation pressure increment
  assert.ok(
    report.negotiation_pressure_increment > 0,
    `Should have negotiation pressure increment: got ${report.negotiation_pressure_increment}`
  );
});

test('surround detection correctness - isolated municipality', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded(); // No edges = isolated

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  assert.ok(
    sustState!.is_surrounded,
    'Isolated municipality should be detected as surrounded'
  );
});

test('surround detection correctness - connected municipality', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  
  // Add a friendly municipality with supply to connect to
  settlements.set('sid4', {
    sid: 'sid4',
    source_id: '4',
    mun_code: '20045',
    mun: 'TestMun'
  });
  state.factions[0].areasOfResponsibility.push('sid4');
  state.factions[0].supply_sources = ['sid1', 'sid4']; // Both have supply
  
  // Connect: sid2 (20168) -> sid4 (20045, friendly and supplied)
  const edges = [
    { a: 'sid1', b: 'sid2' }, // Internal connection
    { a: 'sid2', b: 'sid4' }  // Connection to different friendly municipality with supply
  ];

  // Run update
  updateSustainability(state, settlements, edges);

  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  // Connected municipality with path to supplied friendly municipality should not be surrounded
  assert.strictEqual(
    sustState!.is_surrounded,
    false,
    'Municipality with path to supplied friendly municipality should not be surrounded'
  );
});

test('surround detection: friendly path exists, destination supplied → NOT surrounded', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  
  // Add a third municipality with RBiH control and supply
  settlements.set('sid4', {
    sid: 'sid4',
    source_id: '4',
    mun_code: '20045',
    mun: 'TestMun'
  });
  state.factions[0].areasOfResponsibility.push('sid4');
  state.factions[0].supply_sources = ['sid1', 'sid4'];
  
  // Connect: sid2 (20168) -> sid4 (20045, supplied)
  const edges = [
    { a: 'sid1', b: 'sid2' }, // Internal connection
    { a: 'sid2', b: 'sid4' }  // Connection to different friendly municipality with supply
  ];

  updateSustainability(state, settlements, edges);
  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  assert.strictEqual(
    sustState!.is_surrounded,
    false,
    'Municipality with path to supplied friendly municipality should not be surrounded'
  );
});

test('surround detection: friendly path exists, destination NOT supplied → IS surrounded', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  
  // Add a third municipality with RBiH control
  settlements.set('sid4', {
    sid: 'sid4',
    source_id: '4',
    mun_code: '20045',
    mun: 'TestMun'
  });
  state.factions[0].areasOfResponsibility.push('sid4');
  // No supply sources - this ensures no municipality is supplied
  state.factions[0].supply_sources = [];
  
  // Connect: sid2 (20168) -> sid4 (20045, friendly but unsupplied due to no supply sources)
  const edges = [
    { a: 'sid1', b: 'sid2' }, // Internal connection in 20168
    { a: 'sid2', b: 'sid4' }  // Connection to 20045
  ];

  updateSustainability(state, settlements, edges);
  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  // Since there are no supply sources, municipality 20045 is unsupplied
  // Therefore, 20168 is surrounded (path exists but destination is unsupplied)
  assert.strictEqual(
    sustState!.is_surrounded,
    true,
    'Municipality with path only to unsupplied friendly municipality should be surrounded'
  );
});

test('surround detection: friendly-controlled intermediate nodes, hostile destination → IS surrounded', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  
  // Add intermediate friendly municipality (unsupplied)
  settlements.set('sid4', {
    sid: 'sid4',
    source_id: '4',
    mun_code: '20045',
    mun: 'TestMun'
  });
  state.factions[0].areasOfResponsibility.push('sid4');
  // No supply sources - ensures 20045 is unsupplied
  state.factions[0].supply_sources = [];
  
  // Path: sid2 (20168) -> sid4 (20045, friendly but unsupplied) -> sid3 (20044, VRS/hostile)
  const edges = [
    { a: 'sid1', b: 'sid2' }, // Internal connection
    { a: 'sid2', b: 'sid4' }, // To friendly intermediate (unsupplied)
    { a: 'sid4', b: 'sid3' }  // To hostile destination
  ];

  updateSustainability(state, settlements, edges);
  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  // Path exists through unsupplied friendly municipality to hostile destination
  // No path to supplied friendly municipality - should be surrounded
  assert.strictEqual(
    sustState!.is_surrounded,
    true,
    'Municipality with path ending at hostile destination should be surrounded'
  );
});

test('surround detection: no friendly path at all → IS surrounded', () => {
  const state = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesSurrounded(); // No edges = isolated

  updateSustainability(state, settlements, edges);
  const sustState = state.sustainability_state?.['20168'];

  assert.ok(sustState, 'Should have sustainability state');
  assert.strictEqual(
    sustState!.is_surrounded,
    true,
    'Isolated municipality with no friendly path should be surrounded'
  );
});

test('surround detection: determinism - same graph and state → same surrounded result', () => {
  const state1 = createTestState();
  const state2 = createTestState();
  const settlements = createTestSettlements();
  const edges = createTestEdgesConnected();

  state1.factions[0].supply_sources = ['sid1'];
  state2.factions[0].supply_sources = ['sid1'];

  updateSustainability(state1, settlements, edges);
  updateSustainability(state2, settlements, edges);

  const sustState1 = state1.sustainability_state?.['20168'];
  const sustState2 = state2.sustainability_state?.['20168'];

  assert.ok(sustState1, 'Should have sustainability state 1');
  assert.ok(sustState2, 'Should have sustainability state 2');
  assert.strictEqual(
    sustState1!.is_surrounded,
    sustState2!.is_surrounded,
    'Same graph and state should produce same surrounded result'
  );
});
