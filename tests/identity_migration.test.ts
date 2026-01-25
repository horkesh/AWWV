import assert from 'node:assert';
import { test } from 'node:test';

import { deserializeState, serializeState } from '../src/state/serialize.js';
import { canonicalizePoliticalSideId, defaultArmyLabelForSide, POLITICAL_SIDES, ARMY_LABELS } from '../src/state/identity.js';
import { validateState } from '../src/validate/validate.js';

test('canonicalizePoliticalSideId maps army labels to political sides', () => {
  assert.strictEqual(canonicalizePoliticalSideId('ARBiH'), 'RBiH');
  assert.strictEqual(canonicalizePoliticalSideId('VRS'), 'RS');
  assert.strictEqual(canonicalizePoliticalSideId('HVO'), 'HRHB');
  assert.strictEqual(canonicalizePoliticalSideId('RBiH'), 'RBiH');
  assert.strictEqual(canonicalizePoliticalSideId('RS'), 'RS');
  assert.strictEqual(canonicalizePoliticalSideId('HRHB'), 'HRHB');
});

test('defaultArmyLabelForSide returns correct army labels', () => {
  assert.strictEqual(defaultArmyLabelForSide('RBiH'), 'ARBiH');
  assert.strictEqual(defaultArmyLabelForSide('RS'), 'VRS');
  assert.strictEqual(defaultArmyLabelForSide('HRHB'), 'HVO');
});

test('migration canonicalizes faction IDs in factions array', () => {
  const rawState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'ARBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'VRS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'HVO', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const serialized = JSON.stringify(rawState);
  const migrated = deserializeState(serialized);

  assert.strictEqual(migrated.factions[0].id, 'RBiH');
  assert.strictEqual(migrated.factions[1].id, 'RS');
  assert.strictEqual(migrated.factions[2].id, 'HRHB');
});

test('migration canonicalizes formation faction IDs and preserves army labels as force_label', () => {
  const rawState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      'F1': {
        id: 'F1',
        faction: 'ARBiH',
        name: 'Test Formation',
        created_turn: 0,
        status: 'active',
        assignment: null
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const serialized = JSON.stringify(rawState);
  const migrated = deserializeState(serialized);

  assert.strictEqual(migrated.formations['F1'].faction, 'RBiH');
  assert.strictEqual(migrated.formations['F1'].force_label, 'ARBiH');
});

test('migration sets default force_label when faction is already political and force_label missing', () => {
  const rawState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'RS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      'F1': {
        id: 'F1',
        faction: 'RS',
        name: 'Test Formation',
        created_turn: 0,
        status: 'active',
        assignment: null
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const serialized = JSON.stringify(rawState);
  const migrated = deserializeState(serialized);

  assert.strictEqual(migrated.formations['F1'].faction, 'RS');
  assert.strictEqual(migrated.formations['F1'].force_label, 'VRS');
});

test('migration canonicalizes militia pool faction IDs', () => {
  const rawState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'ARBiH',
        available: 100,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const serialized = JSON.stringify(rawState);
  const migrated = deserializeState(serialized);

  assert.strictEqual(migrated.militia_pools['MUN1'].faction, 'RBiH');
});

test('migration canonicalizes negotiation ledger faction_id', () => {
  const rawState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: [
      { id: 'NLED_0_ARBiH_gain_0', turn: 0, faction_id: 'ARBiH', kind: 'gain', amount: 10, reason: 'test' }
    ]
  };

  const serialized = JSON.stringify(rawState);
  const migrated = deserializeState(serialized);

  assert.strictEqual(migrated.negotiation_ledger![0].faction_id, 'RBiH');
});

test('validation rejects ARBiH/VRS/HVO as faction IDs (before migration)', () => {
  // This test checks that validation rejects army labels as faction IDs
  // Note: In practice, migration happens before validation, so this tests the validator directly
  const invalidState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'ARBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const issues = validateState(invalidState as any);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.code === 'faction.id.not_political_side'));
});

test('validation accepts only POLITICAL_SIDES as faction IDs', () => {
  const validState = {
    schema_version: 1,
    meta: { turn: 0, seed: 'test' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'RS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'HRHB', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_status: { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null },
    ceasefire: {},
    negotiation_ledger: []
  };

  const issues = validateState(validState as any);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.strictEqual(errors.length, 0);
});
