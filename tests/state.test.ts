import assert from 'node:assert';
import { test } from 'node:test';

import { serializeState, deserializeState } from '../src/state/serialize.js';
import { GameState, CURRENT_SCHEMA_VERSION } from '../src/state/game_state.js';

const baseState: GameState = {
  schema_version: CURRENT_SCHEMA_VERSION,
  meta: { turn: 0, seed: 'initial-seed' },
  factions: [
    {
      id: 'RBiH',
      profile: {
        authority: 10,
        legitimacy: 10,
        control: 10,
        logistics: 10,
        exhaustion: 0
      },
      areasOfResponsibility: [],
      supply_sources: [],
      command_capacity: 0,
      negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
    }
  ],
  formations: {},
  front_segments: {},
  front_posture: {},
  front_posture_regions: {},
  front_pressure: {},
  militia_pools: {},
  negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
  ceasefire: {},
  negotiation_ledger: [],
  supply_rights: { corridors: [] }
};

test('state serialization round trips cleanly', () => {
  const original = structuredClone(baseState);
  const payload = serializeState(original);
  const hydrated = deserializeState(payload);

  assert.deepStrictEqual(hydrated, original);
});
