import assert from 'node:assert';
import { test } from 'node:test';

import { CURRENT_SCHEMA_VERSION, type GameState } from '../src/state/game_state.js';
import { computeFrontRegions } from '../src/map/front_regions.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import { runPhase5CheckInProcess } from '../src/cli/sim_phase5_check.js';

test('phase5 sanity: region expansion, edge override, deterministic + no timestamps', async () => {
  // Tiny graph with one active front edge => one region
  const edges = [{ a: 's1', b: 's2' }];
  const derived: FrontEdge[] = [{ edge_id: 's1__s2', a: 's1', b: 's2', side_a: 'A', side_b: 'B' }];

  const base: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'phase5-seed' },
    factions: [
      // Supply sources so pressure path is stable; no special assertions here beyond determinism.
      { id: 'A', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s1'], supply_sources: ['s1'] },
      { id: 'B', profile: { authority: 0, legitimacy: 0, control: 0, logistics: 0, exhaustion: 0 }, areasOfResponsibility: ['s2'], supply_sources: ['s2'] }
    ],
    formations: {},
    // Mark the edge active so computeFrontRegions can derive a region_id for selection.
    front_segments: {
      s1__s2: {
        edge_id: 's1__s2',
        active: true,
        created_turn: 0,
        since_turn: 0,
        last_active_turn: 0,
        active_streak: 0,
        max_active_streak: 0,
        friction: 0,
        max_friction: 0
      }
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const regions = computeFrontRegions(base, derived);
  assert.ok(regions.regions.length > 0);
  const region_id = regions.regions[0].region_id;

  const res = await runPhase5CheckInProcess(base, edges, {
    faction: 'A',
    region_id,
    edge_id: 's1__s2',
    weight: 3
  });

  assert.ok(res.expanded_edges_count_before > 0);
  assert.ok(res.expanded_edges_count_after <= res.expanded_edges_count_before);
  assert.strictEqual(res.determinism_ok, true);
  assert.strictEqual(res.no_timestamps_ok, true);
});

