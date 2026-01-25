import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import { accumulateExhaustion } from '../src/state/exhaustion.js';

test('accumulateExhaustion increments deterministically from supplied vs unsupplied work', () => {
  // One active edge, delta=6 => abs(delta)=6 work attributed to both sides.
  // A supplied => total_work=6 => floor(6/10)=0
  // B unsupplied => total_work=2*6=12 => floor(12/10)=1
  const state: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 1, seed: 'seed' },
    factions: [
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s1'], supply_sources: [] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s2'], supply_sources: [] }
    ],
    formations: {},
    front_segments: { s1__s2: { edge_id: 's1__s2', active: true, created_turn: 1, since_turn: 1, last_active_turn: 1, active_streak: 1, max_active_streak: 1, friction: 0, max_friction: 0 } },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const derivedFrontEdges: FrontEdge[] = [{ edge_id: 's1__s2', a: 's1', b: 's2', side_a: 'A', side_b: 'B' }];
  const pressureDeltasByEdge = new Map<string, number>([['s1__s2', 6]]);
  const localSupplyByEdgeSide = new Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }>([
    ['s1__s2', { side_a_supplied: true, side_b_supplied: false }]
  ]);

  const stats = accumulateExhaustion(state, derivedFrontEdges, pressureDeltasByEdge, localSupplyByEdgeSide);
  assert.deepStrictEqual(stats.per_faction, [
    {
      faction_id: 'A',
      exhaustion_before: 0,
      exhaustion_after: 0,
      delta: 0,
      work_supplied: 6,
      work_unsupplied: 0
    },
    {
      faction_id: 'B',
      exhaustion_before: 0,
      exhaustion_after: 1,
      delta: 1,
      work_supplied: 0,
      work_unsupplied: 6
    }
  ]);

  // Irreversible and applied to state.
  assert.strictEqual(state.factions.find((f) => f.id === 'A')!.profile.exhaustion, 0);
  assert.strictEqual(state.factions.find((f) => f.id === 'B')!.profile.exhaustion, 1);
});

