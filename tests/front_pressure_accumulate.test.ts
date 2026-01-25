import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import { syncFrontSegments } from '../src/state/front_segments.js';
import { normalizeFrontPosture } from '../src/state/front_posture.js';
import { accumulateFrontPressure } from '../src/state/front_pressure.js';
import { EdgeRecord } from '../src/map/settlements.js';
import { buildAdjacencyMap } from '../src/map/adjacency_map.js';

test('accumulateFrontPressure deterministically accumulates from posture intent', () => {
  const edges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s1'], supply_sources: ['s1'] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s2'], supply_sources: ['s2'] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {
      // side_a will be A (controls s1), side_b will be B (controls s2)
      A: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'push', weight: 3 } } }, // intent 6
      B: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'probe', weight: 2 } } } // intent 2
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  // Ensure the segment exists and is active.
  const derived = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived);
  normalizeFrontPosture(state);
  const adjacencyMap = buildAdjacencyMap(edges);

  // Turn 1 accumulation: delta = clamp(6-2)=4
  accumulateFrontPressure(state, derived, adjacencyMap);
  assert.deepStrictEqual(state.front_pressure['s1__s2'], {
    edge_id: 's1__s2',
    value: 4,
    max_abs: 4,
    last_updated_turn: 1
  });

  // Turn 2 accumulation (same inputs): value 8, max_abs 8
  state.meta.turn = 2;
  accumulateFrontPressure(state, derived, adjacencyMap);
  assert.strictEqual(state.front_pressure['s1__s2'].value, 8);
  assert.strictEqual(state.front_pressure['s1__s2'].max_abs, 8);
  assert.strictEqual(state.front_pressure['s1__s2'].last_updated_turn, 2);

  // Missing posture yields delta 0 (no change)
  state.meta.turn = 3;
  state.front_posture = {};
  accumulateFrontPressure(state, derived, adjacencyMap);
  assert.strictEqual(state.front_pressure['s1__s2'].value, 8);
  assert.strictEqual(state.front_pressure['s1__s2'].max_abs, 8);
  assert.strictEqual(state.front_pressure['s1__s2'].last_updated_turn, 3);
});

