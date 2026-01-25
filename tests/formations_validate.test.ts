import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { validateFormations } from '../src/validate/formations.js';
import type { FrontRegionsFile } from '../src/map/front_regions.js';
import type { FrontEdge } from '../src/map/front_edges.js';

test('validateFormations emits deterministic errors/warnings', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] },
      { id: 'RS', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      ok1: {
        id: 'ok1',
        faction: 'RBiH',
        name: 'Test Formation',
        created_turn: 5,
        status: 'active',
        assignment: null
      },
      badFaction: {
        id: 'badFaction',
        faction: 'NOPE',
        name: 'Bad Faction',
        created_turn: 5,
        status: 'active',
        assignment: null
      },
      badStatus: {
        id: 'badStatus',
        faction: 'RBiH',
        name: 'Bad Status',
        created_turn: 5,
        status: 'invalid' as any,
        assignment: null
      },
      badAssignmentRegion: {
        id: 'badAssignmentRegion',
        faction: 'RBiH',
        name: 'Bad Assignment',
        created_turn: 5,
        status: 'active',
        assignment: { kind: 'region', region_id: 'UNKNOWN_REGION' }
      },
      badAssignmentEdge: {
        id: 'badAssignmentEdge',
        faction: 'RBiH',
        name: 'Bad Edge',
        created_turn: 5,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'UNKNOWN_EDGE' }
      },
      badTags: {
        id: 'badTags',
        faction: 'RBiH',
        name: 'Bad Tags',
        created_turn: 5,
        status: 'active',
        assignment: null,
        tags: ['', 'duplicate', 'duplicate', 'valid']
      },
      idMismatch: {
        id: 'different',
        faction: 'RBiH',
        name: 'ID Mismatch',
        created_turn: 5,
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

  const frontRegions: FrontRegionsFile = {
    schema: 1,
    turn: 5,
    regions: [
      {
        region_id: 'RBiH--RS::e2',
        side_pair: 'A--B',
        edge_ids: [],
        settlements: [],
        active_edge_count: 0
      }
    ]
  };

  const frontEdges: FrontEdge[] = [
    {
      edge_id: 'a__b',
      a: 'a',
      b: 'b',
      side_a: 'RBiH',
      side_b: 'RS'
    }
  ];

  const issues = validateFormations(state, frontRegions, frontEdges);
  // Deterministic order from validateFormations: formation ids sorted
  const issueStrings = issues.map((i) => `${i.severity}:${i.code}@${i.path ?? ''}`);
  assert.ok(issueStrings.includes('error:formations.faction.not_political_side@formations.badFaction.faction'));
  assert.ok(issueStrings.includes('error:formations.status.invalid@formations.badStatus.status'));
  assert.ok(issueStrings.includes('error:formations.assignment.region_id.unknown@formations.badAssignmentRegion.assignment.region_id'));
  assert.ok(issueStrings.includes('error:formations.assignment.edge_id.unknown@formations.badAssignmentEdge.assignment.edge_id'));
  assert.ok(issueStrings.includes('error:formations.tags.item.empty@formations.badTags.tags[0]'));
  assert.ok(issueStrings.includes('error:formations.tags.duplicate@formations.badTags.tags[2]'));
  assert.ok(issueStrings.includes('error:formations.id.mismatch@formations.idMismatch'));
});

test('validateFormations accepts valid formations', () => {
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'seed' },
    factions: [
      { id: 'RBiH', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: [], supply_sources: [] }
    ],
    formations: {
      valid1: {
        id: 'valid1',
        faction: 'RBiH',
        name: 'Valid Formation',
        created_turn: 5,
        status: 'active',
        assignment: null
      },
      valid2: {
        id: 'valid2',
        faction: 'RBiH',
        name: 'Valid with Region',
        created_turn: 5,
        status: 'inactive',
        assignment: { kind: 'region', region_id: 'RBiH--RS::e2' }
      },
      valid3: {
        id: 'valid3',
        faction: 'RBiH',
        name: 'Valid with Edge',
        created_turn: 5,
        status: 'active',
        assignment: { kind: 'edge', edge_id: 'a__b' },
        tags: ['tag1', 'tag2']
      }
    },
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const frontRegions: FrontRegionsFile = {
    schema: 1,
    turn: 5,
    regions: [
      {
        region_id: 'RBiH--RS::e2',
        side_pair: 'A--B',
        edge_ids: [],
        settlements: [],
        active_edge_count: 0
      }
    ]
  };

  const frontEdges: FrontEdge[] = [
    {
      edge_id: 'a__b',
      a: 'a',
      b: 'b',
      side_a: 'RBiH',
      side_b: 'RS'
    }
  ];

  const issues = validateFormations(state, frontRegions, frontEdges);
  const errors = issues.filter((i) => i.severity === 'error');
  assert.strictEqual(errors.length, 0, `Expected no errors but got: ${JSON.stringify(errors)}`);
});
