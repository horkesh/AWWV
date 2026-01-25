import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { buildFormationsReport } from '../src/cli/sim_formations.js';

test('buildFormationsReport is deterministic and has no timestamps', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 3, seed: 'seed' },
    factions: [
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      z1: {
        id: 'z1',
        faction: 'B',
        name: 'Formation Z',
        created_turn: 3,
        status: 'active',
        assignment: { kind: 'region', region_id: 'A--B::e1' }
      },
      a1: {
        id: 'a1',
        faction: 'A',
        name: 'Formation A',
        created_turn: 3,
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
  assert.strictEqual(report.schema, 1);
  assert.strictEqual(report.turn, 3);
  assert.deepStrictEqual(
    report.formations.map((f) => `${f.faction}:${f.id}`),
    ['A:a1', 'B:z1'],
    'should sort by id asc'
  );

  const json = JSON.stringify(report);
  assert.ok(!json.includes('generated_at'));
  assert.ok(!json.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/), 'should not include ISO timestamps');
});
