import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, GameState } from '../src/state/game_state.js';
import { buildAdjacencyMap } from '../src/map/adjacency_map.js';
import { computeSupplyReachability } from '../src/state/supply_reachability.js';

test('computeSupplyReachability with single source reaches all connected controlled', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1', 's2', 's3'],
        supply_sources: ['s1']
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  // Line graph: s1—s2—s3
  const adjacencyMap = buildAdjacencyMap([
    { a: 's1', b: 's2' },
    { a: 's2', b: 's3' }
  ]);

  const report = computeSupplyReachability(state, adjacencyMap);
  assert.strictEqual(report.schema, 1);
  assert.strictEqual(report.turn, 5);
  assert.strictEqual(report.factions.length, 1);

  const faction = report.factions[0];
  assert.strictEqual(faction.faction_id, 'A');
  assert.deepStrictEqual(faction.sources, ['s1']);
  assert.deepStrictEqual(faction.controlled, ['s1', 's2', 's3']);
  assert.deepStrictEqual(faction.reachable_controlled, ['s1', 's2', 's3']);
  assert.deepStrictEqual(faction.isolated_controlled, []);
});

test('computeSupplyReachability with empty sources yields all isolated', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1', 's2', 's3'],
        supply_sources: []
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const adjacencyMap = buildAdjacencyMap([
    { a: 's1', b: 's2' },
    { a: 's2', b: 's3' }
  ]);

  const report = computeSupplyReachability(state, adjacencyMap);
  const faction = report.factions[0];
  assert.deepStrictEqual(faction.sources, []);
  assert.deepStrictEqual(faction.controlled, ['s1', 's2', 's3']);
  assert.deepStrictEqual(faction.reachable_controlled, []);
  assert.deepStrictEqual(faction.isolated_controlled, ['s1', 's2', 's3']);
});

test('computeSupplyReachability with control split isolates disconnected', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1', 's3'], // s2 not controlled
        supply_sources: ['s1']
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  // Line graph: s1—s2—s3 (s2 not controlled)
  const adjacencyMap = buildAdjacencyMap([
    { a: 's1', b: 's2' },
    { a: 's2', b: 's3' }
  ]);

  const report = computeSupplyReachability(state, adjacencyMap);
  const faction = report.factions[0];
  assert.deepStrictEqual(faction.sources, ['s1']);
  assert.deepStrictEqual(faction.controlled, ['s1', 's3']);
  assert.deepStrictEqual(faction.reachable_controlled, ['s1']); // s3 isolated because s2 not controlled
  assert.deepStrictEqual(faction.isolated_controlled, ['s3']);
});

test('computeSupplyReachability ignores sources not controlled by faction', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1', 's2'] // s2 not controlled by A
      },
      {
        id: 'B',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: []
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const adjacencyMap = buildAdjacencyMap([
    { a: 's1', b: 's2' }
  ]);

  const report = computeSupplyReachability(state, adjacencyMap);
  
  // Faction A: s2 is listed in sources but not used as seed (not controlled)
  const factionA = report.factions[0];
  assert.strictEqual(factionA.faction_id, 'A');
  assert.deepStrictEqual(factionA.sources, ['s1', 's2']); // Still lists it
  assert.deepStrictEqual(factionA.controlled, ['s1']);
  assert.deepStrictEqual(factionA.reachable_controlled, ['s1']);
  assert.deepStrictEqual(factionA.isolated_controlled, []);
});

test('computeSupplyReachability deterministically orders factions and results', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'Z',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1']
      },
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: ['s2']
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const adjacencyMap = buildAdjacencyMap([
    { a: 's1', b: 's2' }
  ]);

  const report = computeSupplyReachability(state, adjacencyMap);
  
  // Factions should be sorted by faction_id
  assert.strictEqual(report.factions.length, 2);
  assert.strictEqual(report.factions[0].faction_id, 'A');
  assert.strictEqual(report.factions[1].faction_id, 'Z');
  
  // All arrays should be sorted
  assert.deepStrictEqual(report.factions[0].controlled, ['s2']);
  assert.deepStrictEqual(report.factions[0].sources, ['s2']);
});
