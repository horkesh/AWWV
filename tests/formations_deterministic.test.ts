import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { deserializeState, serializeState } from '../src/state/serialize.js';
import { buildFormationsReport } from '../src/cli/sim_formations.js';

// Replicate the deterministic ID generation logic for testing
function testGenerateId(state: GameState, faction: string): string {
  const formations = state.formations || {};
  const factionFormations = Object.values(formations)
    .filter((f) => f && typeof f === 'object' && (f as any).faction === faction)
    .map((f) => (f as any).id)
    .filter((id): id is string => typeof id === 'string');

  const pattern = new RegExp(`^F_${faction.replace(/[^A-Za-z0-9]/g, '_')}_(\\d+)$`);
  let maxNum = 0;
  for (const id of factionFormations) {
    const match = id.match(pattern);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum + 1;
  const padded = String(nextNum).padStart(4, '0');
  return `F_${faction}_${padded}`;
}

test('deterministic formation ID generation', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  // First formation should be F_A_0001
  const id1 = testGenerateId(state, 'A');
  assert.strictEqual(id1, 'F_A_0001');

  // Add a formation
  state.formations['F_A_0001'] = {
    id: 'F_A_0001',
    faction: 'A',
    name: 'First',
    created_turn: 1,
    status: 'active',
    assignment: null
  };

  // Next should be F_A_0002
  const id2 = testGenerateId(state, 'A');
  assert.strictEqual(id2, 'F_A_0002');

  // Add another with custom ID
  state.formations['custom'] = {
    id: 'custom',
    faction: 'A',
    name: 'Custom',
    created_turn: 1,
    status: 'active',
    assignment: null
  };

  // Should still be F_A_0002 (custom ID doesn't affect pattern)
  const id3 = testGenerateId(state, 'A');
  assert.strictEqual(id3, 'F_A_0002');

  // Add F_A_0005
  state.formations['F_A_0005'] = {
    id: 'F_A_0005',
    faction: 'A',
    name: 'Fifth',
    created_turn: 1,
    status: 'active',
    assignment: null
  };

  // Next should be F_A_0006 (max is 5)
  const id4 = testGenerateId(state, 'A');
  assert.strictEqual(id4, 'F_A_0006');
});

test('save migration defaults formations to empty object', () => {
  const rawState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ]
  };

  const serialized = JSON.stringify(rawState);
  const deserialized = deserializeState(serialized);

  assert.ok(deserialized.formations);
  assert.strictEqual(typeof deserialized.formations, 'object');
  assert.strictEqual(Object.keys(deserialized.formations).length, 0);
});

test('deterministic list ordering', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'RS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      z3: {
        id: 'z3',
        faction: 'RS',
        name: 'Z3',
        created_turn: 1,
        status: 'active',
        assignment: null
      },
      a1: {
        id: 'a1',
        faction: 'RBiH',
        name: 'A1',
        created_turn: 1,
        status: 'active',
        assignment: null
      },
      z1: {
        id: 'z1',
        faction: 'RS',
        name: 'Z1',
        created_turn: 1,
        status: 'active',
        assignment: null
      },
      a2: {
        id: 'a2',
        faction: 'RBiH',
        name: 'A2',
        created_turn: 1,
        status: 'active',
        assignment: null
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const report = buildFormationsReport(state);
  const ids = report.formations.map((f) => f.id);
  assert.deepStrictEqual(ids, ['a1', 'a2', 'z1', 'z3'], 'should be sorted by id asc');
});
