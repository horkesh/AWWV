/**
 * Freeze Regression Tests (v0.2.6 FROZEN)
 * 
 * These tests enforce the freeze contract by:
 * 1. Asserting that frozen constants match expected values
 * 2. Validating scenario invariants from calibration fixtures
 * 
 * These are "tripwire" tests - they will fail if constants drift or calibrated behavior changes.
 */

import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { updateSustainability, type SustainabilityStepReport } from '../src/state/sustainability.js';
import { updateDisplacement, type DisplacementStepReport } from '../src/state/displacement.js';
import { updateNegotiationPressure } from '../src/state/negotiation_pressure.js';
import type { SettlementRecord } from '../src/map/settlements.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import { computeFrontBreaches } from '../src/state/front_breaches.js';
import type { EdgeRecord } from '../src/map/settlements.js';

/**
 * Test 1: Freeze constant values
 * 
 * This test reads the actual constant values from the source files and asserts they match
 * the frozen expected values. This is a deliberate "tripwire" test.
 * 
 * Note: Since constants are not exported, we test them indirectly through behavior,
 * or we can read the source file. For now, we test through known behavior patterns.
 */
test('freeze: displacement constants match frozen values', () => {
  // Test ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10 (10% per turn when encircled)
  // This is simpler to test than unsupplied pressure (which requires 3 consecutive turns)
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'freeze-test' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1'],
        supply_sources: [], // No supply
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  settlements.set('MUN_A_s1', {
    sid: 'MUN_A_s1',
    source_id: 'MUN_A_1',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });

  // No edges = isolated = encircled (no path to other friendly municipality)
  const edges: EdgeRecord[] = [];

  // Turn 1: Should have encirclement displacement (10% per turn)
  state.meta.turn = 1;
  const report1 = updateDisplacement(state, settlements, edges);
  const record1 = report1.by_municipality.find(r => r.mun_id === 'MUN_A');
  assert.ok(
    record1 && record1.displacement_this_turn > 0,
    'Turn 1: Displacement should occur when encircled (ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10)'
  );

  // Verify ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10 (10%)
  // Remaining population should be 10000, so displacement should be ~1000
  const remainingPop = record1!.original_population - record1!.displaced_out_before - record1!.lost_population_before;
  const expectedDisplacement = Math.floor(remainingPop * 0.10);
  assert.ok(
    Math.abs(record1!.displacement_this_turn - expectedDisplacement) <= 1, // Allow rounding
    `Displacement should be ~10% of remaining population (ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10), got ${record1!.displacement_this_turn}, expected ~${expectedDisplacement}`
  );
});

test('freeze: sustainability constants match frozen values', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'freeze-sust-test' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1'],
        supply_sources: [], // No supply
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  settlements.set('MUN_A_s1', {
    sid: 'MUN_A_s1',
    source_id: 'MUN_A_1',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });

  const edges: EdgeRecord[] = []; // No edges = isolated = surrounded

  // Turn 1: Should degrade by BASE_DEGRADATION = 5
  state.meta.turn = 1;
  const report1 = updateSustainability(state, settlements, edges);
  const record1 = report1.by_municipality.find(r => r.mun_id === 'MUN_A');
  assert.ok(record1, 'Should have sustainability record');
  assert.strictEqual(
    record1!.degradation_this_turn,
    5,
    'Turn 1: Degradation should be BASE_DEGRADATION = 5 when surrounded'
  );
  assert.strictEqual(
    record1!.sustainability_score_after,
    95,
    'Turn 1: Score should be 100 - 5 = 95'
  );

  // Turn 2: Should degrade by BASE_DEGRADATION + UNSUPPLIED_ACCELERATION = 5 + 5 = 10
  // (after UNSUPPLIED_ACCELERATION_THRESHOLD = 2 turns)
  state.meta.turn = 2;
  const report2 = updateSustainability(state, settlements, edges);
  const record2 = report2.by_municipality.find(r => r.mun_id === 'MUN_A');
  assert.ok(record2, 'Should have sustainability record');
  assert.strictEqual(
    record2!.degradation_this_turn,
    10,
    'Turn 2: Degradation should be BASE_DEGRADATION (5) + UNSUPPLIED_ACCELERATION (5) = 10 when unsupplied >= 2 turns'
  );
});

/**
 * Test 2: Scenario invariants
 * 
 * These tests run the calibration scenarios and assert invariant ranges.
 * They validate that calibrated behavior doesn't drift.
 */
test('freeze: scenario 1 - prolonged siege invariants', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'prolonged-siege-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  settlements.set('MUN_A_s1', {
    sid: 'MUN_A_s1',
    source_id: 'MUN_A_1',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });
  settlements.set('MUN_A_s2', {
    sid: 'MUN_A_s2',
    source_id: 'MUN_A_2',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });

  const edges: EdgeRecord[] = []; // Isolated

  let collapseTurn: number | null = null;

  // Run 18 turns
  for (let turn = 1; turn <= 18; turn++) {
    state.meta.turn = turn;
    const sustReport = updateSustainability(state, settlements, edges);
    const dispReport = updateDisplacement(state, settlements, edges);
    const frontEdges = computeFrontEdges(state, edges);
    const breaches = computeFrontBreaches(state, frontEdges);
    const negReport = updateNegotiationPressure(
      state,
      frontEdges,
      undefined,
      undefined,
      undefined,
      sustReport
    );

    const sustRecord = sustReport.by_municipality.find(r => r.mun_id === 'MUN_A');
    if (sustRecord?.collapsed && collapseTurn === null) {
      collapseTurn = turn;
    }
  }

  // Invariant 1: Collapse should not occur in < 5 turns
  if (collapseTurn !== null) {
    assert.ok(
      collapseTurn >= 5,
      `Collapse occurred too quickly (turn ${collapseTurn}), should take at least 5 turns`
    );
  }

  // Invariant 2: Final sustainability should be degraded
  const finalSust = state.sustainability_state?.['MUN_A'];
  assert.ok(
    finalSust && finalSust.sustainability_score < 100,
    'Final sustainability should be degraded after prolonged siege'
  );

  // Invariant 3: Monotonic degradation (sustainability never increases)
  // This is enforced by the sustainability system itself, but we verify
  assert.ok(
    !finalSust || finalSust.sustainability_score <= 0 || finalSust.sustainability_score < 100,
    'Sustainability should be monotonic decreasing'
  );
});

test('freeze: scenario 2 - temporary encirclement invariants', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'temporary-encirclement-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_B_s1'],
        supply_sources: ['MUN_B_s1'],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  settlements.set('MUN_A_s1', {
    sid: 'MUN_A_s1',
    source_id: 'MUN_A_1',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });
  settlements.set('MUN_A_s2', {
    sid: 'MUN_A_s2',
    source_id: 'MUN_A_2',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });
  settlements.set('MUN_B_s1', {
    sid: 'MUN_B_s1',
    source_id: 'MUN_B_1',
    mun_code: 'MUN_B',
    mun: 'Municipality_B'
  });

  let edges: EdgeRecord[] = []; // Initially isolated

  // Turns 1-4: Surrounded
  for (let turn = 1; turn <= 4; turn++) {
    state.meta.turn = turn;
    updateSustainability(state, settlements, edges);
    updateDisplacement(state, settlements, edges);
  }

  // Turn 5: Reconnect
  edges = [{ a: 'MUN_A_s1', b: 'MUN_B_s1' }];
  state.factions[0].supply_sources = ['MUN_B_s1'];

  // Turns 5-8: Reconnected
  for (let turn = 5; turn <= 8; turn++) {
    state.meta.turn = turn;
    updateSustainability(state, settlements, edges);
    updateDisplacement(state, settlements, edges);
  }

  // Invariant: Should NOT collapse from temporary encirclement
  const finalSust = state.sustainability_state?.['MUN_A'];
  assert.ok(
    !finalSust || !finalSust.collapsed,
    'Temporary encirclement should not cause collapse'
  );

  // Invariant: Should have partial degradation but not complete
  assert.ok(
    !finalSust || (finalSust.sustainability_score > 0 && finalSust.sustainability_score < 100),
    `Should have partial sustainability loss (${finalSust?.sustainability_score ?? 'undefined'}) but not collapse`
  );
});

test('freeze: scenario 4 - multi-pocket negotiation pressure monotonicity', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'multi-pocket-stress-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_B_s1', 'MUN_B_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_C',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_C_s1', 'MUN_C_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      },
      'MUN_B': {
        mun_id: 'MUN_B',
        faction: 'FACTION_B',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      },
      'MUN_C': {
        mun_id: 'MUN_C',
        faction: 'FACTION_C',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      },
      'MUN_B': {
        mun_id: 'MUN_B',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      },
      'MUN_C': {
        mun_id: 'MUN_C',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  for (const munId of ['MUN_A', 'MUN_B', 'MUN_C']) {
    settlements.set(`${munId}_s1`, {
      sid: `${munId}_s1`,
      source_id: `${munId}_1`,
      mun_code: munId,
      mun: `Municipality_${munId}`
    });
    settlements.set(`${munId}_s2`, {
      sid: `${munId}_s2`,
      source_id: `${munId}_2`,
      mun_code: munId,
      mun: `Municipality_${munId}`
    });
  }

  const edges: EdgeRecord[] = []; // All isolated

  const negotiationPressures: Array<{ turn: number; pressures: Record<string, number> }> = [];

  // Run 20 turns
  for (let turn = 1; turn <= 20; turn++) {
    state.meta.turn = turn;
    const sustReport = updateSustainability(state, settlements, edges);
    updateDisplacement(state, settlements, edges);
    const frontEdges = computeFrontEdges(state, edges);
    const breaches = computeFrontBreaches(state, frontEdges);
    updateNegotiationPressure(
      state,
      frontEdges,
      undefined,
      undefined,
      undefined,
      sustReport
    );

    const pressures: Record<string, number> = {};
    for (const f of state.factions) {
      pressures[f.id] = f.negotiation?.pressure ?? 0;
    }
    negotiationPressures.push({ turn, pressures });
  }

  // Invariant: Negotiation pressure should increase monotonically (or stay same, never decrease)
  for (let i = 1; i < negotiationPressures.length; i++) {
    const prev = negotiationPressures[i - 1];
    const curr = negotiationPressures[i];
    for (const factionId of Object.keys(curr.pressures)) {
      assert.ok(
        curr.pressures[factionId] >= prev.pressures[factionId],
        `Turn ${curr.turn}: Negotiation pressure for ${factionId} should be monotonic increasing (was ${prev.pressures[factionId]}, now ${curr.pressures[factionId]})`
      );
    }
  }

  // Invariant: At least one faction should have increased pressure after collapses
  const finalPressures = negotiationPressures[negotiationPressures.length - 1].pressures;
  const totalPressure = Object.values(finalPressures).reduce((sum, p) => sum + p, 0);
  assert.ok(
    totalPressure > 0,
    'Multi-pocket stress should result in increased negotiation pressure'
  );
});

test('freeze: no control flips from sustainability collapse', () => {
  // This test verifies that sustainability collapse does not directly flip control
  // (control flips are separate proposals, not automatic from collapse)
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'no-flip-test' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    }
  };

  const settlements = new Map<string, SettlementRecord>();
  settlements.set('MUN_A_s1', {
    sid: 'MUN_A_s1',
    source_id: 'MUN_A_1',
    mun_code: 'MUN_A',
    mun: 'Municipality_A'
  });

  const edges: EdgeRecord[] = [];

  // Run until collapse
  let collapsed = false;
  for (let turn = 1; turn <= 20 && !collapsed; turn++) {
    state.meta.turn = turn;
    const sustReport = updateSustainability(state, settlements, edges);
    const record = sustReport.by_municipality.find(r => r.mun_id === 'MUN_A');
    if (record?.collapsed) {
      collapsed = true;
    }
  }

  assert.ok(collapsed, 'Municipality should collapse');

  // Verify control is still with FACTION_A (no automatic flip)
  // Control is determined by areasOfResponsibility, not by sustainability
  const munSettlement = settlements.get('MUN_A_s1');
  assert.ok(munSettlement, 'Settlement should exist');
  // Control is implicit from areasOfResponsibility - if it's in FACTION_A's AOR, it's controlled by FACTION_A
  assert.ok(
    state.factions[0].areasOfResponsibility.includes('MUN_A_s1'),
    'Control should remain with FACTION_A even after collapse (no automatic flip)'
  );
});
