import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { validateMilitiaPools } from '../src/validate/militia_pools.js';
import { serializeState, deserializeState } from '../src/state/serialize.js';

test('validateMilitiaPools emits deterministic errors', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'ARBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'VRS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      '20168': {
        mun_id: '20168',
        faction: 'RBiH',
        available: 500,
        committed: 100,
        exhausted: 10,
        updated_turn: 5
      },
      '20044': {
        mun_id: '20044',
        faction: 'NOPE',
        available: 300,
        committed: 50,
        exhausted: 5,
        updated_turn: 5
      },
      '21001': {
        mun_id: '21001',
        faction: null,
        available: -10,
        committed: 20,
        exhausted: 0,
        updated_turn: 5
      },
      '22001': {
        mun_id: '22001',
        faction: 'RBiH',
        available: 100,
        committed: -5,
        exhausted: 0,
        updated_turn: 5
      },
      '23001': {
        mun_id: '23001',
        faction: 'RBiH',
        available: 100,
        committed: 0,
        exhausted: 0,
        updated_turn: 10
      },
      '24001': {
        mun_id: '24001',
        faction: 'RBiH',
        available: 100,
        committed: 0,
        exhausted: 0,
        updated_turn: 5,
        tags: ['', 'duplicate', 'duplicate', 'valid']
      },
      '25001': {
        mun_id: 'different',
        faction: 'RBiH',
        available: 100,
        committed: 0,
        exhausted: 0,
        updated_turn: 5
      },
      'UNKNOWN': {
        mun_id: 'UNKNOWN',
        faction: 'RBiH',
        available: 100,
        committed: 0,
        exhausted: 0,
        updated_turn: 5
      }
    }
  };

  const validMunicipalityIds = new Set(['20168', '20044', '21001', '22001', '23001', '24001', '25001']);
  const issues = validateMilitiaPools(state, validMunicipalityIds);

  // Deterministic order from validateMilitiaPools: sorted by path
  const issueStrings = issues.map((i) => `${i.severity}:${i.code}@${i.path ?? ''}`);
  assert.ok(issueStrings.includes('error:militia_pools.faction.not_political_side@militia_pools.20044.faction'));
  assert.ok(issueStrings.includes('error:militia_pools.available.invalid@militia_pools.21001.available'));
  assert.ok(issueStrings.includes('error:militia_pools.committed.invalid@militia_pools.22001.committed'));
  assert.ok(issueStrings.includes('error:militia_pools.updated_turn.invalid@militia_pools.23001.updated_turn'));
  assert.ok(issueStrings.includes('error:militia_pools.tags.empty@militia_pools.24001.tags[0]'));
  assert.ok(issueStrings.includes('error:militia_pools.tags.duplicate@militia_pools.24001.tags[2]'));
  assert.ok(issueStrings.includes('error:militia_pools.mun_id.mismatch@militia_pools.25001.mun_id'));
  assert.ok(issueStrings.includes('error:militia_pools.mun_id.invalid@militia_pools.UNKNOWN.mun_id'));
});

test('validateMilitiaPools accepts valid militia pools', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      '20168': {
        mun_id: '20168',
        faction: 'RBiH',
        available: 500,
        committed: 100,
        exhausted: 10,
        updated_turn: 5
      },
      '20044': {
        mun_id: '20044',
        faction: null,
        available: 0,
        committed: 0,
        exhausted: 0,
        updated_turn: 3,
        tags: ['tag1', 'tag2']
      }
    }
  };

  const validMunicipalityIds = new Set(['20168', '20044']);
  const issues = validateMilitiaPools(state, validMunicipalityIds);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.strictEqual(errors.length, 0, `Expected no errors but got: ${JSON.stringify(errors)}`);
});

test('militia_pools defaults to {} on deserialize', () => {
  const stateWithoutMilitia: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const payload = serializeState(stateWithoutMilitia);
  const hydrated = deserializeState(payload);

  assert.ok(hydrated.militia_pools);
  assert.strictEqual(Object.keys(hydrated.militia_pools).length, 0);
});

test('validateMilitiaPools handles empty militia_pools', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const validMunicipalityIds = new Set<string>();
  const issues = validateMilitiaPools(state, validMunicipalityIds);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.strictEqual(errors.length, 0);
});
