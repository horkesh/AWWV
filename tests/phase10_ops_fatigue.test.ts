import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { updateFormationFatigue } from '../src/state/formation_fatigue.js';
import { applyFormationCommitment } from '../src/state/front_posture_commitment.js';
import { updateMilitiaFatigue } from '../src/state/militia_fatigue.js';
import { runScenarioDeterministic } from '../src/cli/sim_scenario.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import type { FrontRegionsFile } from '../src/map/front_regions.js';
import type { EdgeRecord } from '../src/map/settlements.js';
import type { SettlementRecord } from '../src/map/settlements.js';

// Helper to create a minimal front segment
function seg(edge_id: string, active: boolean): GameState['front_segments'][string] {
  return {
    edge_id,
    active,
    created_turn: 1,
    since_turn: 1,
    last_active_turn: active ? 1 : 0,
    active_streak: active ? 1 : 0,
    max_active_streak: active ? 1 : 0,
    friction: 0,
    max_friction: 0
  };
}

// Helper to create a front edge
function edge(edge_id: string, side_a: string, side_b: string): FrontEdge {
  const [a, b] = edge_id.split('__');
  return { edge_id, a, b, side_a, side_b };
}

// ============================================================================
// A) Formation fatigue update rules
// ============================================================================

test('formation fatigue: assigned + unsupplied => fatigue increments by 1 per turn', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [] // No supply sources => unsupplied
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: []
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 0, last_supplied_turn: null }
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };
  const settlementEdges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const report = updateFormationFatigue(state, frontEdges, frontRegions, settlementEdges);

  // Formation should be unsupplied and fatigue should increment
  const record = report.by_formation.find((r) => r.formation_id === 'F1');
  assert.ok(record, 'formation record should exist');
  assert.strictEqual(record.supplied, false, 'formation should be unsupplied');
  assert.strictEqual(record.fatigue_before, 0, 'fatigue should start at 0');
  assert.strictEqual(record.fatigue_after, 1, 'fatigue should increment by 1');
  assert.strictEqual(state.formations.F1.ops?.fatigue, 1, 'state should be updated');
  assert.strictEqual(state.formations.F1.ops?.last_supplied_turn, null, 'last_supplied_turn should remain null');
});

test('formation fatigue: assigned + supplied => fatigue unchanged, last_supplied_turn set', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1'] // Supply source => supplied
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: []
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 2, last_supplied_turn: null }
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };
  const settlementEdges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const report = updateFormationFatigue(state, frontEdges, frontRegions, settlementEdges);

  // Formation should be supplied and fatigue should not change
  const record = report.by_formation.find((r) => r.formation_id === 'F1');
  assert.ok(record, 'formation record should exist');
  assert.strictEqual(record.supplied, true, 'formation should be supplied');
  assert.strictEqual(record.fatigue_before, 2, 'fatigue should start at 2');
  assert.strictEqual(record.fatigue_after, 2, 'fatigue should remain 2');
  assert.strictEqual(state.formations.F1.ops?.fatigue, 2, 'state fatigue should remain 2');
  assert.strictEqual(state.formations.F1.ops?.last_supplied_turn, 5, 'last_supplied_turn should be set to current turn');
});

test('formation fatigue: unassigned formations do NOT accumulate fatigue even if faction is unsupplied', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [] // No supply sources => unsupplied
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: []
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: null, // Unassigned
        ops: { fatigue: 0, last_supplied_turn: null }
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };
  const settlementEdges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const report = updateFormationFatigue(state, frontEdges, frontRegions, settlementEdges);

  // Unassigned formation should be treated as supplied (no fatigue increase)
  const record = report.by_formation.find((r) => r.formation_id === 'F1');
  assert.ok(record, 'formation record should exist');
  assert.strictEqual(record.supplied, true, 'unassigned formation should be treated as supplied');
  assert.strictEqual(record.fatigue_before, 0, 'fatigue should start at 0');
  assert.strictEqual(record.fatigue_after, 0, 'fatigue should remain 0');
  assert.strictEqual(state.formations.F1.ops?.fatigue, 0, 'state fatigue should remain 0');
});

test('formation fatigue: inactive formations do not accumulate fatigue', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [] // No supply sources => unsupplied
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: []
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'inactive', // Inactive
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 0, last_supplied_turn: null }
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };
  const settlementEdges: EdgeRecord[] = [{ a: 's1', b: 's2' }];

  const report = updateFormationFatigue(state, frontEdges, frontRegions, settlementEdges);

  // Inactive formations should not be processed
  assert.strictEqual(report.by_formation.length, 0, 'inactive formations should not appear in report');
  assert.strictEqual(state.formations.F1.ops?.fatigue, 0, 'inactive formation fatigue should remain unchanged');
});

// ============================================================================
// B) Commitment penalty math
// ============================================================================

test('commitment penalty: supplied, fatigue=0 => commit points = 1000', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1'],
        command_capacity: 0
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: [],
        command_capacity: 0
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 0, last_supplied_turn: 5 } // Supplied this turn
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {
      A: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'push', weight: 1 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };

  const { report } = applyFormationCommitment(state, frontEdges, frontRegions);

  const edgeReport = report.by_edge.find((e) => e.edge_id === 's1__s2');
  assert.ok(edgeReport, 'edge report should exist');
  assert.strictEqual(edgeReport.commit_points, 1000, 'supplied + fatigue=0 => 1000 commit points');
});

test('commitment penalty: unsupplied, fatigue=0 => commit points = 500', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [], // No supply sources => unsupplied
        command_capacity: 0
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: [],
        command_capacity: 0
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 0, last_supplied_turn: null } // Unsupplied
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {
      A: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'push', weight: 1 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };

  const { report } = applyFormationCommitment(state, frontEdges, frontRegions);

  const edgeReport = report.by_edge.find((e) => e.edge_id === 's1__s2');
  assert.ok(edgeReport, 'edge report should exist');
  assert.strictEqual(edgeReport.commit_points, 500, 'unsupplied + fatigue=0 => 500 commit points');
});

test('commitment penalty: unsupplied, fatigue=3 => commit points = 350', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [], // No supply sources => unsupplied
        command_capacity: 0
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: [],
        command_capacity: 0
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 3, last_supplied_turn: null } // Unsupplied, fatigue=3
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {
      A: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'push', weight: 1 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };

  const { report } = applyFormationCommitment(state, frontEdges, frontRegions);

  const edgeReport = report.by_edge.find((e) => e.edge_id === 's1__s2');
  assert.ok(edgeReport, 'edge report should exist');
  // Unsupplied: 500, minus fatigue*50 = 500 - 150 = 350
  assert.strictEqual(edgeReport.commit_points, 350, 'unsupplied + fatigue=3 => 500 - 150 = 350 commit points');
});

test('commitment penalty: supplied, fatigue=3 => commit points = 850 (fatigue penalty applies even when supplied)', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1'], // Supplied
        command_capacity: 0
      },
      {
        id: 'B',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s2'],
        supply_sources: [],
        command_capacity: 0
      }
    ],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 3, last_supplied_turn: 5 } // Supplied, fatigue=3
      }
    },
    front_segments: { 's1__s2': seg('s1__s2', true) },
    front_posture: {
      A: { assignments: { 's1__s2': { edge_id: 's1__s2', posture: 'push', weight: 1 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('s1__s2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 5, regions: [] };

  const { report } = applyFormationCommitment(state, frontEdges, frontRegions);

  const edgeReport = report.by_edge.find((e) => e.edge_id === 's1__s2');
  assert.ok(edgeReport, 'edge report should exist');
  // Supplied: 1000, minus fatigue*50 = 1000 - 150 = 850
  assert.strictEqual(edgeReport.commit_points, 850, 'supplied + fatigue=3 => 1000 - 150 = 850 commit points');
});

// ============================================================================
// C) Militia fatigue update rules
// ============================================================================

test('militia fatigue: municipality unsupplied => fatigue increments by 1 per turn', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: [] // No supply sources => unsupplied
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 0
      }
    }
  };

  // Create synthetic settlements: one settlement in MUN1, not reachable from supply
  const settlements = new Map<string, SettlementRecord>();
  settlements.set('s1', {
    sid: 's1',
    source_id: '1',
    mun_code: 'MUN1',
    mun: 'Municipality 1'
  });

  const settlementEdges: EdgeRecord[] = [];
  const exhaustionDeltas = new Map<string, number>(); // No exhaustion delta

  const report = updateMilitiaFatigue(state, settlements, settlementEdges, exhaustionDeltas);

  const record = report.by_municipality.find((r) => r.mun_id === 'MUN1');
  assert.ok(record, 'municipality record should exist');
  assert.strictEqual(record.supplied, false, 'municipality should be unsupplied');
  assert.strictEqual(record.fatigue_before, 0, 'fatigue should start at 0');
  assert.strictEqual(record.fatigue_after, 1, 'fatigue should increment by 1');
  assert.strictEqual(state.militia_pools['MUN1'].fatigue, 1, 'state should be updated');
});

test('militia fatigue: municipality supplied => fatigue unchanged', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1'] // Supply source => supplied
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 2
      }
    }
  };

  // Create synthetic settlements: one settlement in MUN1, reachable from supply
  const settlements = new Map<string, SettlementRecord>();
  settlements.set('s1', {
    sid: 's1',
    source_id: '1',
    mun_code: 'MUN1',
    mun: 'Municipality 1'
  });

  const settlementEdges: EdgeRecord[] = [];
  const exhaustionDeltas = new Map<string, number>(); // No exhaustion delta

  const report = updateMilitiaFatigue(state, settlements, settlementEdges, exhaustionDeltas);

  const record = report.by_municipality.find((r) => r.mun_id === 'MUN1');
  assert.ok(record, 'municipality record should exist');
  assert.strictEqual(record.supplied, true, 'municipality should be supplied');
  assert.strictEqual(record.fatigue_before, 2, 'fatigue should start at 2');
  assert.strictEqual(record.fatigue_after, 2, 'fatigue should remain 2');
  assert.strictEqual(state.militia_pools['MUN1'].fatigue, 2, 'state fatigue should remain 2');
});

test('militia fatigue: exhaustion increase adds +1 fatigue to all pools for that faction', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1', 's2'], // Control both settlements
        supply_sources: ['s1'] // Supplied, and s2 is reachable via edge
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 0
      },
      'MUN2': {
        mun_id: 'MUN2',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 1
      }
    }
  };

  // Create synthetic settlements: both municipalities have reachable settlements
  // s1 is in supply_sources, s2 is reachable via edge from s1
  const settlements = new Map<string, SettlementRecord>();
  settlements.set('s1', {
    sid: 's1',
    source_id: '1',
    mun_code: 'MUN1',
    mun: 'Municipality 1'
  });
  settlements.set('s2', {
    sid: 's2',
    source_id: '2',
    mun_code: 'MUN2',
    mun: 'Municipality 2'
  });

  // Add edge so s2 is reachable from s1 (supply source)
  const settlementEdges: EdgeRecord[] = [{ a: 's1', b: 's2' }];
  const exhaustionDeltas = new Map<string, number>();
  exhaustionDeltas.set('A', 1); // Exhaustion increased by 1

  const report = updateMilitiaFatigue(state, settlements, settlementEdges, exhaustionDeltas);

  // Both pools should get +1 from exhaustion, plus supply status
  const mun1Record = report.by_municipality.find((r) => r.mun_id === 'MUN1');
  assert.ok(mun1Record, 'MUN1 record should exist');
  assert.strictEqual(mun1Record.supplied, true, 'MUN1 should be supplied');
  assert.strictEqual(mun1Record.fatigue_before, 0, 'MUN1 fatigue should start at 0');
  assert.strictEqual(mun1Record.fatigue_after, 1, 'MUN1 fatigue should be +1 from exhaustion only');

  const mun2Record = report.by_municipality.find((r) => r.mun_id === 'MUN2');
  assert.ok(mun2Record, 'MUN2 record should exist');
  assert.strictEqual(mun2Record.supplied, true, 'MUN2 should be supplied');
  assert.strictEqual(mun2Record.fatigue_before, 1, 'MUN2 fatigue should start at 1');
  assert.strictEqual(mun2Record.fatigue_after, 2, 'MUN2 fatigue should be +1 from exhaustion (1 -> 2)');
});

test('militia fatigue: deterministic municipal supply uses settlement reachability + mun_code mapping', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 },
        areasOfResponsibility: ['s1', 's3'],
        supply_sources: ['s1'] // Only s1 is reachable
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 0
      },
      'MUN2': {
        mun_id: 'MUN2',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 1,
        fatigue: 0
      }
    }
  };

  // Create synthetic settlements:
  // MUN1 has s1 (reachable) and s2 (not reachable) - should be supplied (at least one reachable)
  // MUN2 has s3 (in AoR but not in supply_sources) - should be unsupplied
  const settlements = new Map<string, SettlementRecord>();
  settlements.set('s1', {
    sid: 's1',
    source_id: '1',
    mun_code: 'MUN1',
    mun: 'Municipality 1'
  });
  settlements.set('s2', {
    sid: 's2',
    source_id: '2',
    mun_code: 'MUN1',
    mun: 'Municipality 1'
  });
  settlements.set('s3', {
    sid: 's3',
    source_id: '3',
    mun_code: 'MUN2',
    mun: 'Municipality 2'
  });

  const settlementEdges: EdgeRecord[] = [];
  const exhaustionDeltas = new Map<string, number>();

  const report = updateMilitiaFatigue(state, settlements, settlementEdges, exhaustionDeltas);

  const mun1Record = report.by_municipality.find((r) => r.mun_id === 'MUN1');
  assert.ok(mun1Record, 'MUN1 record should exist');
  assert.strictEqual(mun1Record.supplied, true, 'MUN1 should be supplied (s1 is reachable)');

  const mun2Record = report.by_municipality.find((r) => r.mun_id === 'MUN2');
  assert.ok(mun2Record, 'MUN2 record should exist');
  assert.strictEqual(mun2Record.supplied, false, 'MUN2 should be unsupplied (s3 not in supply_sources)');
});

// ============================================================================
// D) Determinism regression test
// ============================================================================

test('determinism: same scenario run twice produces identical scenario_summary.json', async () => {
  const edges: EdgeRecord[] = [
    { a: 's1', b: 's2' }, // canonical edge_id s1__s2
    { a: 's1', b: 's3' } // canonical edge_id s1__s3
  ];

  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'determinism-test-seed' },
    factions: [
      {
        id: 'A',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s1'],
        supply_sources: ['s1'],
        command_capacity: 0
      },
      {
        id: 'B',
        profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 },
        areasOfResponsibility: ['s2', 's3'],
        supply_sources: ['s2'],
        command_capacity: 0
      }
    ],
    formations: {
      F_A_0001: {
        id: 'F_A_0001',
        faction: 'A',
        name: 'Test Formation 1',
        created_turn: 0,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 's1__s2' },
        ops: { fatigue: 0, last_supplied_turn: null }
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN1': {
        mun_id: 'MUN1',
        faction: 'A',
        available: 1000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0,
        fatigue: 0
      }
    }
  };

  const script = {
    schema: 1 as const,
    turns: {
      '1': [{ faction: 'A', edge_id: 's1__s2', posture: 'push' as const, weight: 1 }],
      '2': [{ faction: 'A', edge_id: 's1__s2', posture: 'push' as const, weight: 1 }],
      '3': [{ faction: 'A', edge_id: 's1__s2', posture: 'push' as const, weight: 1 }]
    }
  };

  // Run scenario twice
  const { summary: summary1 } = await runScenarioDeterministic(state, {
    turns: 3,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges: edges
  });

  // Create fresh state (clone to avoid mutations)
  const state2: GameState = JSON.parse(JSON.stringify(state));
  const { summary: summary2 } = await runScenarioDeterministic(state2, {
    turns: 3,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges: edges
  });

  // Compare summaries - they should be byte-for-byte identical
  const json1 = JSON.stringify(summary1, null, 2);
  const json2 = JSON.stringify(summary2, null, 2);

  assert.strictEqual(json1, json2, 'scenario summaries should be identical');

  // Verify no timestamps in output
  assert.ok(!json1.includes('generated_at'), 'should not include generated_at timestamps');
  assert.ok(!json1.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), 'should not include ISO timestamps');

  // Verify fatigue counts are present and deterministic
  assert.ok(summary1.turns.length >= 3, 'should have at least 3 turns');
  for (let i = 0; i < 3; i += 1) {
    const turn1 = summary1.turns[i];
    const turn2 = summary2.turns[i];
    assert.strictEqual(
      turn1.formations.formations_unsupplied_count,
      turn2.formations.formations_unsupplied_count,
      `turn ${i + 1}: formations_unsupplied_count should match`
    );
    assert.strictEqual(
      turn1.formations.formations_avg_fatigue,
      turn2.formations.formations_avg_fatigue,
      `turn ${i + 1}: formations_avg_fatigue should match`
    );
    assert.strictEqual(
      turn1.militia_pools.militia_pools_unsupplied_count,
      turn2.militia_pools.militia_pools_unsupplied_count,
      `turn ${i + 1}: militia_pools_unsupplied_count should match`
    );
    assert.strictEqual(
      turn1.militia_pools.militia_pools_avg_fatigue,
      turn2.militia_pools.militia_pools_avg_fatigue,
      `turn ${i + 1}: militia_pools_avg_fatigue should match`
    );
  }
});
