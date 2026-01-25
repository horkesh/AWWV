import assert from 'node:assert';
import { test } from 'node:test';

import { GameState, CURRENT_SCHEMA_VERSION } from '../src/state/game_state.js';
import { runTurn } from '../src/sim/turn_pipeline.js';

const baseState: GameState = {
  schema_version: CURRENT_SCHEMA_VERSION,
  meta: { turn: 0, seed: 'initial-seed' },
  factions: [],
  formations: {},
  front_segments: {},
  front_posture: {},
  front_posture_regions: {},
  front_pressure: {},
  militia_pools: {}
};

test('runTurn is deterministic for same state and seed', async () => {
  const seed = 'deterministic-seed';

  const first = await runTurn(baseState, { seed });
  const second = await runTurn(baseState, { seed });

  assert.deepStrictEqual(first.nextState, second.nextState);
  assert.deepStrictEqual(first.report, second.report);
  assert.strictEqual(baseState.meta.turn, 0, 'input state must remain unchanged');
});
