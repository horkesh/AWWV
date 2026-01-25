import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { validateFrontSegments } from '../src/validate/front_segments.js';
import { EdgeRecord } from '../src/map/settlements.js';

test('validateFrontSegments returns deterministic issues for malformed records', () => {
  const settlementEdges: EdgeRecord[] = [{ a: 'a', b: 'b' }]; // only a__b is adjacent
  const settlementIds = ['a', 'b', 'c', 'd'];

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 2, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {
      // valid
      'a__b': {
        edge_id: 'a__b',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 2,
        active_streak: 2,
        max_active_streak: 2,
        friction: 2,
        max_friction: 2
      },
      // malformed streaks: max < active (error)
      'a__c': {
        edge_id: 'a__c',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 2,
        active_streak: 3,
        max_active_streak: 2,
        friction: 1,
        max_friction: 1
      },
      // non-canonical ordering
      'b__a': {
        edge_id: 'b__a',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 2,
        active_streak: 1,
        max_active_streak: 1,
        friction: 2,
        max_friction: 2
      },
      // malformed friction: max < current (error)
      'b__c': {
        edge_id: 'b__c',
        active: true,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 2,
        active_streak: 1,
        max_active_streak: 1,
        friction: 3,
        max_friction: 2
      },
      // unknown sid
      'a__z': {
        edge_id: 'a__z',
        active: false,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 1,
        active_streak: 0,
        max_active_streak: 0,
        friction: 0,
        max_friction: 0
      },
      // non-adjacent but well-formed (stale history warning)
      'c__d': {
        edge_id: 'c__d',
        active: false,
        created_turn: 1,
        since_turn: 1,
        last_active_turn: 1,
        active_streak: 3,
        max_active_streak: 3,
        friction: 2,
        max_friction: 2
      }
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const issues = validateFrontSegments(state, settlementEdges, { settlementIds });

  // Exact deterministic ordering from validator:
  // keys sorted: a__b, a__c, a__z, b__a, b__c, c__d; issues emitted in fixed check order per key.
  assert.deepStrictEqual(
    issues.map((i) => `${i.code} @ ${i.path ?? ''}`),
    [
      'front_segments.size.suspicious @ ',
      'front_segments.edge.not_adjacent @ front_segments.a__c',
      'front_segments.streak.max_lt_active @ front_segments.a__c.max_active_streak',
      'front_segments.sid.unknown @ front_segments.a__z',
      'front_segments.edge.not_adjacent @ front_segments.a__z',
      'front_segments.edge_id.non_canonical @ front_segments.b__a',
      'front_segments.edge.not_adjacent @ front_segments.b__a',
      'front_segments.edge.not_adjacent @ front_segments.b__c',
      'front_segments.friction.max_lt_current @ front_segments.b__c.max_friction',
      'front_segments.edge.not_adjacent @ front_segments.c__d',
      'front_segments.streak.inactive_nonzero @ front_segments.c__d.active_streak'
    ]
  );
});

