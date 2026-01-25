import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { expandRegionPostureToEdges } from '../src/state/front_posture_regions.js';
import type { FrontRegionsFile } from '../src/map/front_regions.js';

function seg(edge_id: string, active: boolean): GameState['front_segments'][string] {
  return {
    edge_id,
    active,
    created_turn: 1,
    since_turn: 1,
    last_active_turn: active ? 1 : 0,
    active_streak: active ? 1 : 0,
    max_active_streak: active ? 1 : 0,
    friction: 0,
    max_friction: 0
  };
}

test('expandRegionPostureToEdges expands into active edges and preserves per-edge overrides', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {
      e1: seg('e1', true),
      e2: seg('e2', true),
      e3: seg('e3', false) // should be skipped (inactive)
    },
    front_posture: {
      // Explicit per-edge override for e2 must win.
      A: { assignments: { e2: { edge_id: 'e2', posture: 'hold', weight: 1 } } }
    },
    front_posture_regions: {
      A: { assignments: { 'A--B::e1': { posture: 'push', weight: 3 } } }
    },
    front_pressure: {},
    militia_pools: {}
  };

  const frontRegions: FrontRegionsFile = {
    schema: 1,
    turn: 1,
    regions: [
      {
        region_id: 'A--B::e1',
        side_pair: 'A--B',
        edge_ids: ['e1', 'e2', 'e3'],
        settlements: [],
        active_edge_count: 3
      }
    ]
  };

  const res = expandRegionPostureToEdges(state, frontRegions);
  assert.strictEqual(res.expanded_edges_count, 1, 'only e1 should be expanded (e2 overridden, e3 inactive)');

  assert.deepStrictEqual(state.front_posture.A.assignments.e1, { edge_id: 'e1', posture: 'push', weight: 3 });
  assert.deepStrictEqual(state.front_posture.A.assignments.e2, { edge_id: 'e2', posture: 'hold', weight: 1 });
  assert.ok(!('e3' in state.front_posture.A.assignments), 'inactive edge should not receive expansion');
});

