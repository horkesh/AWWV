import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { computeFrontBreaches } from '../src/state/front_breaches.js';
import { FrontEdge } from '../src/map/front_edges.js';

test('computeFrontBreaches emits favored_side correctly and sorts deterministically', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 7, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {
      'a__b': {
        edge_id: 'a__b',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 7,
        active_streak: 1,
        max_active_streak: 1,
        friction: 1,
        max_friction: 1
      },
      'c__d': {
        edge_id: 'c__d',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 7,
        active_streak: 1,
        max_active_streak: 1,
        friction: 1,
        max_friction: 1
      }
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {
      'a__b': { edge_id: 'a__b', value: 20, max_abs: 20, last_updated_turn: 7 },
      'c__d': { edge_id: 'c__d', value: -20, max_abs: 20, last_updated_turn: 7 }
    },
    militia_pools: {}
  };

  const derived: FrontEdge[] = [
    { edge_id: 'c__d', a: 'c', b: 'd', side_a: 'A', side_b: 'B' },
    { edge_id: 'a__b', a: 'a', b: 'b', side_a: 'A', side_b: 'B' }
  ];

  const breaches = computeFrontBreaches(state, derived);

  assert.deepStrictEqual(
    breaches.map((b) => ({ edge_id: b.edge_id, favored_side: b.favored_side, pressure_value: b.pressure_value })),
    [
      // abs tied (20), so edge_id asc
      { edge_id: 'a__b', favored_side: 'side_a', pressure_value: 20 },
      { edge_id: 'c__d', favored_side: 'side_b', pressure_value: -20 }
    ]
  );
});

