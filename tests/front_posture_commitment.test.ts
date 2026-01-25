import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { applyFormationCommitment } from '../src/state/front_posture_commitment.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import type { FrontRegionsFile } from '../src/map/front_regions.js';

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

function edge(edge_id: string, side_a: string, side_b: string): FrontEdge {
  const [a, b] = edge_id.split('__');
  return { edge_id, a, b, side_a, side_b };
}

test('commitment: zero commitment => effective weight = 0', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {},
    front_segments: { e1: seg('e1', true) },
    front_posture: {
      A: { assignments: { e1: { edge_id: 'e1', posture: 'push', weight: 5 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 1, regions: [] };

  const { effectivePosture, report } = applyFormationCommitment(state, frontEdges, frontRegions);

  assert.strictEqual(effectivePosture.A.assignments.e1.effective_weight, 0, 'no commitment => effective weight = 0');
  assert.strictEqual(report.by_faction[0].total_commit_points, 0);
  assert.strictEqual(report.by_faction[0].total_demand_weight, 5);
  assert.strictEqual(report.by_faction[0].total_effective_weight, 0);
});

test('commitment: edge assignment contributes 1000 milli-points', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'e1' },
        ops: { fatigue: 0, last_supplied_turn: 1 } // Phase 10: supplied this turn, no fatigue
      }
    },
    front_segments: { e1: seg('e1', true) },
    front_posture: {
      A: { assignments: { e1: { edge_id: 'e1', posture: 'push', weight: 1 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 1, regions: [] };

  const { effectivePosture, report } = applyFormationCommitment(state, frontEdges, frontRegions);

  // 1 commit point (1000 milli-points) for weight 1 (1000 milli-points demand) => friction = 1.0
  assert.strictEqual(effectivePosture.A.assignments.e1.effective_weight, 1, 'sufficient commitment => effective = base');
  assert.strictEqual(report.by_edge[0].commit_points, 1000);
  assert.strictEqual(report.by_edge[0].friction_factor, 1.0);
});

test('commitment: region assignment splits evenly across active edges', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'region', region_id: 'A--B::e1' },
        ops: { fatigue: 0, last_supplied_turn: 1 } // Phase 10: supplied this turn, no fatigue
      }
    },
    front_segments: {
      e1: seg('e1', true),
      e2: seg('e2', true),
      e3: seg('e3', true)
    },
    front_posture: {
      A: {
        assignments: {
          e1: { edge_id: 'e1', posture: 'push', weight: 1 },
          e2: { edge_id: 'e2', posture: 'push', weight: 1 },
          e3: { edge_id: 'e3', posture: 'push', weight: 1 }
        }
      }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B'), edge('e2', 'A', 'B'), edge('e3', 'A', 'B')];
  const frontRegions: FrontRegionsFile = {
    schema: 1,
    turn: 1,
    regions: [
      {
        region_id: 'A--B::e1',
        side_pair: 'A--B',
        edge_ids: ['e1', 'e2', 'e3'],
        settlements: [],
        active_edge_count: 3
      }
    ]
  };

  const { effectivePosture, report } = applyFormationCommitment(state, frontEdges, frontRegions);

  // 1 formation => 1000 milli-points split across 3 edges = 333 per edge (with remainder 1)
  // Each edge gets 333 or 334 milli-points deterministically
  const e1Commit = report.by_edge.find((e) => e.edge_id === 'e1')?.commit_points ?? 0;
  const e2Commit = report.by_edge.find((e) => e.edge_id === 'e2')?.commit_points ?? 0;
  const e3Commit = report.by_edge.find((e) => e.edge_id === 'e3')?.commit_points ?? 0;

  assert.strictEqual(e1Commit + e2Commit + e3Commit, 1000, 'total commit points should be 1000');
  assert.ok(e1Commit >= 333 && e1Commit <= 334);
  assert.ok(e2Commit >= 333 && e2Commit <= 334);
  assert.ok(e3Commit >= 333 && e3Commit <= 334);
});

test('commitment: partial commitment reduces effective weight', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'e1' },
        ops: { fatigue: 0, last_supplied_turn: 1 } // Phase 10: supplied this turn, no fatigue
      }
    },
    front_segments: { e1: seg('e1', true) },
    front_posture: {
      A: { assignments: { e1: { edge_id: 'e1', posture: 'push', weight: 3 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 1, regions: [] };

  const { effectivePosture, report } = applyFormationCommitment(state, frontEdges, frontRegions);

  // 1 commit (1000) for weight 3 (3000 demand) => friction = 1000/3000 = 0.333...
  // effective = floor(3 * 0.333...) = floor(1.0) = 1
  assert.strictEqual(effectivePosture.A.assignments.e1.effective_weight, 1, 'partial commitment reduces weight');
  assert.ok(report.by_edge[0].friction_factor > 0 && report.by_edge[0].friction_factor < 1);
});

test('commitment: command capacity applies global scaling', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 5 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'e1' }
      },
      F2: {
        id: 'F2',
        faction: 'A',
        name: 'Formation 2',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'e2' }
      }
    },
    front_segments: {
      e1: seg('e1', true),
      e2: seg('e2', true)
    },
    front_posture: {
      A: {
        assignments: {
          e1: { edge_id: 'e1', posture: 'push', weight: 5 },
          e2: { edge_id: 'e2', posture: 'push', weight: 5 }
        }
      }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B'), edge('e2', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 1, regions: [] };

  const { effectivePosture, report } = applyFormationCommitment(state, frontEdges, frontRegions);

  // Total demand = 10, capacity = 5 => global factor = 0.5
  // Each edge: base=5, commit=1000, demand=5000, friction=0.2, effective=1
  // After global scaling: effective = floor(1 * 0.5) = 0
  const faction = report.by_faction[0];
  assert.strictEqual(faction.capacity_applied, true);
  assert.strictEqual(faction.global_factor, 0.5);
  assert.strictEqual(faction.total_demand_weight, 10);
});

test('commitment: determinism - same inputs produce same outputs', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'region', region_id: 'A--B::e1' }
      }
    },
    front_segments: {
      e1: seg('e1', true),
      e2: seg('e2', true),
      e3: seg('e3', true)
    },
    front_posture: {
      A: {
        assignments: {
          e1: { edge_id: 'e1', posture: 'push', weight: 1 },
          e2: { edge_id: 'e2', posture: 'push', weight: 1 },
          e3: { edge_id: 'e3', posture: 'push', weight: 1 }
        }
      }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B'), edge('e2', 'A', 'B'), edge('e3', 'A', 'B')];
  const frontRegions: FrontRegionsFile = {
    schema: 1,
    turn: 1,
    regions: [
      {
        region_id: 'A--B::e1',
        side_pair: 'A--B',
        edge_ids: ['e1', 'e2', 'e3'],
        settlements: [],
        active_edge_count: 3
      }
    ]
  };

  const run1 = applyFormationCommitment(state, frontEdges, frontRegions);
  const run2 = applyFormationCommitment(state, frontEdges, frontRegions);

  // Compare effective weights
  const e1_1 = run1.effectivePosture.A.assignments.e1?.effective_weight ?? -1;
  const e1_2 = run2.effectivePosture.A.assignments.e1?.effective_weight ?? -1;
  assert.strictEqual(e1_1, e1_2, 'deterministic effective weights');

  // Compare commit points
  const commit1 = run1.report.by_edge.find((e) => e.edge_id === 'e1')?.commit_points ?? -1;
  const commit2 = run2.report.by_edge.find((e) => e.edge_id === 'e1')?.commit_points ?? -1;
  assert.strictEqual(commit1, commit2, 'deterministic commit points');
});

test('commitment: explicit override precedence - friction applies to overrides too', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [{ id: 'A', profile: { authority: 1, legitimacy: 1, control: 1, logistics: 1, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [], command_capacity: 0 }],
    formations: {
      F1: {
        id: 'F1',
        faction: 'A',
        name: 'Formation 1',
        created_turn: 1,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'e1' }
      }
    },
    front_segments: { e1: seg('e1', true) },
    front_posture: {
      // Explicit per-edge override
      A: { assignments: { e1: { edge_id: 'e1', posture: 'push', weight: 5 } } }
    },
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontEdges: FrontEdge[] = [edge('e1', 'A', 'B')];
  const frontRegions: FrontRegionsFile = { schema: 1, turn: 1, regions: [] };

  const { effectivePosture } = applyFormationCommitment(state, frontEdges, frontRegions);

  // Explicit override with base_weight=5, but only 1 commit => friction reduces it
  assert.strictEqual(effectivePosture.A.assignments.e1.base_weight, 5, 'base weight preserved');
  assert.ok(effectivePosture.A.assignments.e1.effective_weight < 5, 'friction reduces effective weight');
});
