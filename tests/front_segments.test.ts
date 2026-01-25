import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import { syncFrontSegments } from '../src/state/front_segments.js';
import { EdgeRecord } from '../src/map/settlements.js';

test('syncFrontSegments is deterministic and persists inactive segments', () => {
  const edges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s1'], supply_sources: [] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s2'], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  // Turn 1: create + activate
  const derived1 = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived1);
  assert.ok(state.front_segments['s1__s2'], 'segment should be created');
  assert.deepStrictEqual(state.front_segments['s1__s2'], {
    edge_id: 's1__s2',
    active: true,
    created_turn: 1,
    since_turn: 1,
    last_active_turn: 1,
    active_streak: 1,
    max_active_streak: 1,
    friction: 1,
    max_friction: 1
  });

  // Turn 2: same control, since_turn unchanged, last_active_turn updated
  state.meta.turn = 2;
  const derived2 = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived2);
  assert.strictEqual(state.front_segments['s1__s2'].since_turn, 1);
  assert.strictEqual(state.front_segments['s1__s2'].last_active_turn, 2);
  assert.strictEqual(state.front_segments['s1__s2'].active, true);
  assert.strictEqual(state.front_segments['s1__s2'].active_streak, 2);
  assert.strictEqual(state.front_segments['s1__s2'].max_active_streak, 2);
  assert.strictEqual(state.front_segments['s1__s2'].friction, 2);
  assert.strictEqual(state.front_segments['s1__s2'].max_friction, 2);

  // Turn 3: change control so edge is not part of derived fronts (neutral side -> dropped)
  state.meta.turn = 3;
  state.factions[1].areasOfResponsibility = []; // s2 becomes neutral
  const derived3 = computeFrontEdges(state, edges);
  assert.strictEqual(derived3.length, 0, 'edge should not be a front edge when one side is neutral');
  syncFrontSegments(state, derived3);
  assert.strictEqual(state.front_segments['s1__s2'].active, false, 'segment should be retained but inactive');
  assert.strictEqual(state.front_segments['s1__s2'].last_active_turn, 2, 'last_active_turn should not change when inactive');
  assert.strictEqual(state.front_segments['s1__s2'].active_streak, 0, 'inactive segments should have active_streak=0');
  assert.strictEqual(state.front_segments['s1__s2'].max_active_streak, 2, 'max_active_streak should be retained when inactive');
  assert.strictEqual(state.front_segments['s1__s2'].friction, 1, 'inactive segments should decay friction by 1');
  assert.strictEqual(state.front_segments['s1__s2'].max_friction, 2, 'max_friction should be retained when inactive');

  // Turn 4: reactivate => active_streak resets, max retained
  state.meta.turn = 4;
  state.factions[1].areasOfResponsibility = ['s2']; // s2 becomes controlled again
  const derived4 = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived4);
  assert.strictEqual(state.front_segments['s1__s2'].active, true, 'segment should reactivate');
  assert.strictEqual(state.front_segments['s1__s2'].active_streak, 1, 'reactivation should reset active_streak');
  assert.strictEqual(state.front_segments['s1__s2'].max_active_streak, 2, 'max_active_streak should be preserved');
  assert.strictEqual(state.front_segments['s1__s2'].friction, 2, 'reactivation should increment friction again');
  assert.strictEqual(state.front_segments['s1__s2'].max_friction, 2, 'max_friction should be preserved');
});

