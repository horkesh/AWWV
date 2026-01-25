import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import { computeFrontRegions } from '../src/map/front_regions.js';

function seg(edge_id: string, active: boolean): GameState['front_segments'][string] {
  return {
    edge_id,
    active,
    created_turn: 1,
    since_turn: 1,
    last_active_turn: active ? 1 : 0,
    active_streak: active ? 1 : 0,
    max_active_streak: active ? 1 : 0,
    friction: active ? 1 : 0,
    max_friction: active ? 1 : 0
  };
}

test('computeFrontRegions derives deterministic connected components by side_pair', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 7, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {
      e1: seg('e1', true),
      e2: seg('e2', true),
      e5: seg('e5', true),
      e3: seg('e3', true),
      e4: seg('e4', false) // should be ignored (inactive)
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derived: FrontEdge[] = [
    // side_pair A--B, component 1 (shared s2)
    { edge_id: 'e1', a: 's1', b: 's2', side_a: 'A', side_b: 'B' },
    { edge_id: 'e2', a: 's2', b: 's3', side_a: 'A', side_b: 'B' },
    // side_pair A--B, component 2 (disconnected)
    { edge_id: 'e5', a: 's8', b: 's9', side_a: 'A', side_b: 'B' },
    // different side_pair C--D
    { edge_id: 'e3', a: 's9', b: 's10', side_a: 'C', side_b: 'D' },
    // inactive
    { edge_id: 'e4', a: 's100', b: 's101', side_a: 'A', side_b: 'B' }
  ];

  const file = computeFrontRegions(state, derived);
  assert.strictEqual(file.schema, 1);
  assert.strictEqual(file.turn, 7);

  // Expect 3 regions total:
  // - A--B component with e1,e2 (active_edge_count=2) first within A--B
  // - A--B component with e5 (active_edge_count=1)
  // - C--D component with e3
  assert.strictEqual(file.regions.length, 3);

  assert.deepStrictEqual(file.regions[0], {
    side_pair: 'A--B',
    region_id: 'A--B::e1',
    edge_ids: ['e1', 'e2'],
    settlements: ['s1', 's2', 's3'],
    active_edge_count: 2
  });

  assert.deepStrictEqual(file.regions[1], {
    side_pair: 'A--B',
    region_id: 'A--B::e5',
    edge_ids: ['e5'],
    settlements: ['s8', 's9'],
    active_edge_count: 1
  });

  assert.deepStrictEqual(file.regions[2], {
    side_pair: 'C--D',
    region_id: 'C--D::e3',
    edge_ids: ['e3'],
    settlements: ['s10', 's9'],
    active_edge_count: 1
  });
});

