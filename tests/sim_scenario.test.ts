import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { runScenarioDeterministic, type ScenarioSummaryFile } from '../src/cli/sim_scenario.js';
import type { EdgeRecord } from '../src/map/settlements.js';

function buildTinyState(): { state: GameState; edges: EdgeRecord[] } {
  const edges: EdgeRecord[] = [
    { a: 's1', b: 's2' }, // canonical edge_id s1__s2
    { a: 's1', b: 's3' } // canonical edge_id s1__s3
  ];

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'scenario-seed' },
    factions: [
      // Provide local supply so this test remains focused on determinism, not supply penalties.
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s1'], supply_sources: ['s1'] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s2', 's3'], supply_sources: ['s2'] }
    ],
    formations: {
      // Phase 9: Add 3 formations to provide sufficient commitment (3000 milli-points) for weight=3
      // This gives friction_factor = 3000/3000 = 1.0, so effective_weight = 3, matching pre-Phase 9 behavior
      F_A_0001: {
        id: 'F_A_0001',
        faction: 'A',
        name: 'Test Formation 1',
        created_turn: 0,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' }
      },
      F_A_0002: {
        id: 'F_A_0002',
        faction: 'A',
        name: 'Test Formation 2',
        created_turn: 0,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' }
      },
      F_A_0003: {
        id: 'F_A_0003',
        faction: 'A',
        name: 'Test Formation 3',
        created_turn: 0,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' }
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {
      // Seed a deterministic tie case for top_pressures ordering after turn 1:
      // s1__s2 will accumulate to abs 6; s1__s3 stays abs 6 (delta 0).
      s1__s3: { edge_id: 's1__s3', value: 6, max_abs: 6, last_updated_turn: 0 }
    },
    militia_pools: {}
  };

  return { state, edges };
}

test('sim:scenario emits deterministic per-turn summary (no apply)', async () => {
  const { state, edges } = buildTinyState();

  const script = {
    schema: 1 as const,
    turns: {
      '1': [{ faction: 'A', edge_id: 's1__s2', posture: 'push' as const, weight: 3 }],
      '2': [{ faction: 'A', edge_id: 's1__s2', posture: 'push' as const, weight: 3 }]
    }
  };

  const { summary } = await runScenarioDeterministic(state, {
    turns: 2,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges: edges
  });

    assert.strictEqual(summary.schema, 2);
  assert.strictEqual(summary.turns.length, 2);

  // Pressure increases deterministically across turns (delta = clamp(6-0)=6 each turn).
  assert.ok(summary.turns[1].highest_abs_pressure_current > summary.turns[0].highest_abs_pressure_current);
  assert.strictEqual(summary.turns[0].highest_abs_pressure_current, 6);
  assert.strictEqual(summary.turns[1].highest_abs_pressure_current, 12);

  // No timestamps in output artifact.
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('generated_at'));
  assert.ok(!json.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), 'should not include ISO timestamps');

  // top_pressures ordering deterministic: abs desc, tie edge_id asc
  const t1 = summary.turns[0];
  assert.deepStrictEqual(
    t1.top_pressures.map((p) => p.edge_id),
    ['s1__s2', 's1__s3'],
    'tie-break should be edge_id ascending when abs ties'
  );
});

