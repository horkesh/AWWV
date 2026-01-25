import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { normalizeFrontPosture } from '../src/state/front_posture.js';

test('normalizeFrontPosture deterministically cleans and clamps assignments', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {
      'a__b': {
        edge_id: 'a__b',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 1,
        active_streak: 1,
        max_active_streak: 1,
        friction: 1,
        max_friction: 1
      },
      'c__d': {
        edge_id: 'c__d',
        active: false,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 1,
        active_streak: 0,
        max_active_streak: 0,
        friction: 0,
        max_friction: 0
      }
    },
    front_posture: {
      A: {
        assignments: {
          // active edge with weight 3, posture push
          'a__b': { edge_id: 'a__b', posture: 'push', weight: 3 },
          // inactive edge with weight 2, posture probe (kept but weight forced to 0)
          'c__d': { edge_id: 'c__d', posture: 'probe', weight: 2 },
          // stale edge not in front_segments (removed)
          'e__f': { edge_id: 'e__f', posture: 'hold', weight: 1 }
        }
      },
      B: {
        assignments: {
          // invalid posture string (coerced to hold) + negative weight (clamped to 0)
          'a__b': { edge_id: 'a__b', posture: '???' as any, weight: -5 }
        }
      }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  normalizeFrontPosture(state);

  assert.deepStrictEqual(state.front_posture, {
    A: {
      assignments: {
        a__b: { edge_id: 'a__b', posture: 'push', weight: 3 },
        c__d: { edge_id: 'c__d', posture: 'probe', weight: 0 }
      }
    },
    B: {
      assignments: {
        a__b: { edge_id: 'a__b', posture: 'hold', weight: 0 }
      }
    }
  });
});

