import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import { buildAdjacencyMap } from '../src/map/adjacency_map.js';
import { syncFrontSegments } from '../src/state/front_segments.js';
import { normalizeFrontPosture } from '../src/state/front_posture.js';
import { accumulateFrontPressure } from '../src/state/front_pressure.js';
import type { EdgeRecord } from '../src/map/settlements.js';

test('accumulateFrontPressure applies 50% penalty when one side locally unsupplied', () => {
  // Graph: a -- b -- c
  // Front edge is b__c (A controls b, B controls c)
  const edges: EdgeRecord[] = [
    { a: 'a', b: 'b' },
    { a: 'b', b: 'c' }
  ];
  const adjacencyMap = buildAdjacencyMap(edges);

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      // A controls a,b and has source at a so b is reachable (a->b)
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['a', 'b'],
        supply_sources: ['a']
      },
      // B controls c but has no sources => unsupplied locally at c
      {
        id: 'B',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['c'],
        supply_sources: []
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {
      A: { assignments: { 'b__c': { edge_id: 'b__c', posture: 'push', weight: 3 } } }, // intent 6
      B: { assignments: { 'b__c': { edge_id: 'b__c', posture: 'push', weight: 3 } } } // intent 6 -> eff 3
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derived = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived);
  normalizeFrontPosture(state);

  // Without supply effect delta would be 0.
  // With B unsupplied: intent_b_eff = floor(6/2)=3 => delta = 6-3=3
  const stats = accumulateFrontPressure(state, derived, adjacencyMap);
  assert.strictEqual(stats.edges_considered, 1);
  assert.strictEqual(stats.edges_with_any_unsupplied_side, 1);
  assert.deepStrictEqual(stats.pressure_deltas, { b__c: 3 });
  assert.deepStrictEqual(stats.local_supply, { b__c: { side_a_supplied: true, side_b_supplied: false } });
  assert.strictEqual(state.front_pressure['b__c'].value, 3);
});

test('accumulateFrontPressure yields no change when both sides locally supplied', () => {
  // Graph: a -- b -- c -- d
  // Front edge is b__c (A controls a,b; B controls c,d)
  const edges: EdgeRecord[] = [
    { a: 'a', b: 'b' },
    { a: 'b', b: 'c' },
    { a: 'c', b: 'd' }
  ];
  const adjacencyMap = buildAdjacencyMap(edges);

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['a', 'b'],
        supply_sources: ['a']
      },
      {
        id: 'B',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['c', 'd'],
        supply_sources: ['d']
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {
      A: { assignments: { 'b__c': { edge_id: 'b__c', posture: 'push', weight: 3 } } }, // intent 6
      B: { assignments: { 'b__c': { edge_id: 'b__c', posture: 'push', weight: 3 } } } // intent 6
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derived = computeFrontEdges(state, edges);
  syncFrontSegments(state, derived);
  normalizeFrontPosture(state);

  const stats = accumulateFrontPressure(state, derived, adjacencyMap);
  assert.strictEqual(stats.edges_considered, 1);
  assert.strictEqual(stats.edges_with_any_unsupplied_side, 0);
  assert.deepStrictEqual(stats.pressure_deltas, { b__c: 0 });
  assert.deepStrictEqual(stats.local_supply, { b__c: { side_a_supplied: true, side_b_supplied: true } });
  assert.strictEqual(state.front_pressure['b__c'].value, 0);
});

