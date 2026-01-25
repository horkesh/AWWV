import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { buildAdjacencyMap, computeControlFlipProposals, applyControlFlipProposals } from '../src/state/control_flip_proposals.js';
import { FrontEdge } from '../src/map/front_edges.js';
import { FrontBreach } from '../src/state/front_breaches.js';

test('computeControlFlipProposals proposes flipping only the losing-side endpoint', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['x'], supply_sources: [] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['y'], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derived: FrontEdge[] = [{ edge_id: 'x__y', a: 'x', b: 'y', side_a: 'A', side_b: 'B' }];

  const breaches: FrontBreach[] = [
    {
      edge_id: 'x__y',
      turn: 5,
      side_a: 'A',
      side_b: 'B',
      pressure_value: 20,
      threshold: 20,
      favored_side: 'side_a',
      reason: 'pressure_exceeded'
    }
  ];

  const adjacencyMap = buildAdjacencyMap([{ a: 'x', b: 'y' }]);
  const file = computeControlFlipProposals(state, derived, breaches, adjacencyMap);
  assert.strictEqual(file.schema, 1);
  assert.strictEqual(file.turn, 5);
  assert.strictEqual(file.threshold, 20);
  assert.strictEqual(file.proposals.length, 1);
  assert.deepStrictEqual(file.proposals[0].targets, [{ sid: 'y', from: 'B', to: 'A', reason: 'breach_1hop' }]);
});

test('computeControlFlipProposals selects a single 1-hop capture deterministically by score then sid', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      // favored controls b
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['b'], supply_sources: [] },
      // losing controls a and n1
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['a', 'n1'], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derived: FrontEdge[] = [{ edge_id: 'a__b', a: 'a', b: 'b', side_a: 'A', side_b: 'B' }];
  const breaches: FrontBreach[] = [
    {
      edge_id: 'a__b',
      turn: 5,
      side_a: 'A',
      side_b: 'B',
      pressure_value: 20,
      threshold: 20,
      favored_side: 'side_a',
      reason: 'pressure_exceeded'
    }
  ];

  const adjacencyMap = buildAdjacencyMap([
    { a: 'a', b: 'n1' },
    { a: 'a', b: 'b' },
    { a: 'n1', b: 'b' }
  ]);

  const file = computeControlFlipProposals(state, derived, breaches, adjacencyMap);
  assert.strictEqual(file.proposals.length, 1);
  assert.strictEqual(file.proposals[0].targets.length, 1, 'at most one target per breach');
  // score(a)=1 (neighbor b), score(n1)=1 (neighbor b) => tie => smallest sid => a
  assert.deepStrictEqual(file.proposals[0].targets[0], { sid: 'a', from: 'B', to: 'A', reason: 'breach_1hop' });
});

test('applyControlFlipProposals removes sid from all AoRs before adding to favored', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['y'], supply_sources: [] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['y'], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const file = {
    schema: 1 as const,
    turn: 5,
    threshold: 20,
    proposals: [
      {
        edge_id: 'x__y',
        pressure_value: 20,
        side_a: 'A',
        side_b: 'B',
        favored_side: 'A',
        losing_side: 'B',
        targets: [{ sid: 'y', from: 'B', to: 'A', reason: 'breach_1hop' as const }]
      }
    ]
  };

  const { applied } = applyControlFlipProposals(state, file);
  assert.strictEqual(applied, 1);
  assert.deepStrictEqual(state.factions.find((f) => f.id === 'A')!.areasOfResponsibility, ['y']);
  assert.deepStrictEqual(state.factions.find((f) => f.id === 'B')!.areasOfResponsibility, []);
});

