import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/game_state.js';
import {
  generateNegotiationOffers,
  checkOfferAcceptance,
  applyEnforcementPackage,
  expireCeasefireEntries,
  type Offer
} from '../src/state/negotiation_offers.js';
import type { ExhaustionStats } from '../src/state/exhaustion.js';
import type { FormationFatigueStepReport } from '../src/state/formation_fatigue.js';
import type { MilitiaFatigueStepReport } from '../src/state/militia_fatigue.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import type { EdgeRecord } from '../src/map/settlements.js';

function createTestState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 5, seed: 'test-seed' },
    factions: [
      {
        id: 'faction_a',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: ['sid1'],
        negotiation: { pressure: 15, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'faction_b',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['sid3', 'sid4'],
        supply_sources: ['sid3'],
        negotiation: { pressure: 12, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {
      edge1: { edge_id: 'edge1', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 3, max_friction: 3 },
      edge2: { edge_id: 'edge2', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 4, max_active_streak: 4, friction: 2, max_friction: 2 }
    },
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };
}

function createTestEdges(): EdgeRecord[] {
  return [
    { a: 'sid1', b: 'sid3' },
    { a: 'sid2', b: 'sid4' }
  ];
}

test('offer generation: triggers only when pressure threshold met', () => {
  const state = createTestState();
  state.factions[0].negotiation!.pressure = 5; // Below threshold
  state.factions[1].negotiation!.pressure = 5; // Below threshold
  const derivedFrontEdges: FrontEdge[] = [];
  const edges: EdgeRecord[] = [];

  const report = generateNegotiationOffers(state, derivedFrontEdges, edges, undefined, undefined, undefined);

  strictEqual(report.offer, null);
  strictEqual(report.scoring_inputs.max_pressure, 5);
});

test('offer generation: no offer when ceasefire active', () => {
  const state = createTestState();
  state.negotiation_status = { ceasefire_active: true, ceasefire_since_turn: 3, last_offer_turn: 3 };
  const derivedFrontEdges: FrontEdge[] = [];
  const edges: EdgeRecord[] = [];

  const report = generateNegotiationOffers(state, derivedFrontEdges, edges, undefined, undefined, undefined);

  strictEqual(report.offer, null);
});

test('offer generation: generates offer when threshold met', () => {
  const state = createTestState();
  // Ensure edges are active in front_segments
  state.front_segments = {
    'sid1__sid3': { edge_id: 'sid1__sid3', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 5, max_active_streak: 5, friction: 3, max_friction: 3 },
    'sid2__sid4': { edge_id: 'sid2__sid4', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 4, max_active_streak: 4, friction: 2, max_friction: 2 }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'sid1__sid3', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'sid2__sid4', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const report = generateNegotiationOffers(state, derivedFrontEdges, edges, undefined, undefined, undefined);

  ok(report.offer);
  strictEqual(report.offer.turn, 5);
  strictEqual(report.offer.kind === 'ceasefire' || report.offer.kind === 'local_freeze' || report.offer.kind === 'corridor_opening', true);
  ok(report.offer.terms.freeze_edges.length > 0);
});

test('offer generation: deterministic selection and tie-breaks', () => {
  const state1 = createTestState();
  const state2 = createTestState();
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'sid1__sid3', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const exhaustionReport: ExhaustionStats = {
    per_faction: [
      { faction_id: 'faction_a', exhaustion_before: 10, exhaustion_after: 12, delta: 2, work_supplied: 15, work_unsupplied: 5 },
      { faction_id: 'faction_b', exhaustion_before: 20, exhaustion_after: 22, delta: 2, work_supplied: 10, work_unsupplied: 10 }
    ]
  };

  const report1 = generateNegotiationOffers(state1, derivedFrontEdges, edges, exhaustionReport, undefined, undefined);
  const report2 = generateNegotiationOffers(state2, derivedFrontEdges, edges, exhaustionReport, undefined, undefined);

  strictEqual(report1.offer?.id, report2.offer?.id);
  strictEqual(report1.offer?.kind, report2.offer?.kind);
});

test('acceptance gating: enforceability check', () => {
  const state = createTestState();
  // Set low friction and streak to fail enforceability
  state.front_segments = {
    edge1: { edge_id: 'edge1', active: true, created_turn: 1, since_turn: 1, last_active_turn: 5, active_streak: 1, max_active_streak: 1, friction: 0, max_friction: 0 }
  };
  const offer: Offer = {
    id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    kind: 'ceasefire',
    scope: { kind: 'global' },
    rationale: {
      pressure_trigger: 10,
      exhaustion_snapshot: {},
      instability_snapshot: { breaches_total: 0 },
      supply_snapshot: { unsupplied_formations: 0, unsupplied_militia_pools: 0 }
    },
    terms: {
      duration_turns: 'indefinite',
      freeze_edges: ['edge1']
    }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const acceptance = checkOfferAcceptance(state, offer, derivedFrontEdges, edges, undefined, undefined);

  strictEqual(acceptance.accepted, false);
  ok(acceptance.reasons.some((r) => r.includes('enforceability_failed')));
});

test('acceptance gating: symmetry check', () => {
  const state = createTestState();
  // Only one faction above threshold
  state.factions[0].negotiation!.pressure = 15;
  state.factions[1].negotiation!.pressure = 5; // Below threshold
  const offer: Offer = {
    id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    kind: 'ceasefire',
    scope: { kind: 'global' },
    rationale: {
      pressure_trigger: 10,
      exhaustion_snapshot: {},
      instability_snapshot: { breaches_total: 0 },
      supply_snapshot: { unsupplied_formations: 0, unsupplied_militia_pools: 0 }
    },
    terms: {
      duration_turns: 'indefinite',
      freeze_edges: ['edge1']
    }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const acceptance = checkOfferAcceptance(state, offer, derivedFrontEdges, edges, undefined, undefined);

  strictEqual(acceptance.accepted, false);
  ok(acceptance.reasons.some((r) => r.includes('symmetry_failed')));
});

test('acceptance gating: supply sanity check', () => {
  const state = createTestState();
  // Remove supply sources to fail supply sanity
  state.factions[0].supply_sources = [];
  state.factions[1].supply_sources = [];
  const offer: Offer = {
    id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    kind: 'ceasefire',
    scope: { kind: 'global' },
    rationale: {
      pressure_trigger: 10,
      exhaustion_snapshot: {},
      instability_snapshot: { breaches_total: 0 },
      supply_snapshot: { unsupplied_formations: 0, unsupplied_militia_pools: 0 }
    },
    terms: {
      duration_turns: 'indefinite',
      freeze_edges: ['edge1']
    }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const acceptance = checkOfferAcceptance(state, offer, derivedFrontEdges, edges, undefined, undefined);

  strictEqual(acceptance.accepted, false);
  ok(acceptance.reasons.some((r) => r.includes('supply_sanity_failed')));
});

test('acceptance gating: all checks pass', () => {
  const state = createTestState();
  const offer: Offer = {
    id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    kind: 'ceasefire',
    scope: { kind: 'global' },
    rationale: {
      pressure_trigger: 10,
      exhaustion_snapshot: {},
      instability_snapshot: { breaches_total: 0 },
      supply_snapshot: { unsupplied_formations: 0, unsupplied_militia_pools: 0 }
    },
    terms: {
      duration_turns: 'indefinite',
      freeze_edges: ['edge1', 'edge2']
    }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge2', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' }
  ];
  const edges: EdgeRecord[] = createTestEdges();

  const acceptance = checkOfferAcceptance(state, offer, derivedFrontEdges, edges, undefined, undefined);

  strictEqual(acceptance.accepted, true);
  ok(acceptance.enforcement_package);
  strictEqual(acceptance.enforcement_package?.freeze_edges.length, 2);
});

test('apply enforcement package: mutates state correctly', () => {
  const state = createTestState();
  const enforcementPackage = {
    schema: 1 as const,
    offer_id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    freeze_edges: ['edge1', 'edge2'],
    duration_turns: 6 as const
  };

  applyEnforcementPackage(state, enforcementPackage);

  strictEqual(state.negotiation_status?.ceasefire_active, true);
  strictEqual(state.negotiation_status?.ceasefire_since_turn, 5);
  strictEqual(state.negotiation_status?.last_offer_turn, 5);
  ok(state.ceasefire);
  strictEqual(state.ceasefire?.['edge1']?.since_turn, 5);
  strictEqual(state.ceasefire?.['edge1']?.until_turn, 11); // 5 + 6
  strictEqual(state.ceasefire?.['edge2']?.since_turn, 5);
  strictEqual(state.ceasefire?.['edge2']?.until_turn, 11);
});

test('apply enforcement package: indefinite duration', () => {
  const state = createTestState();
  const enforcementPackage = {
    schema: 1 as const,
    offer_id: 'OFF_5_ceasefire_GLOBAL',
    turn: 5,
    freeze_edges: ['edge1'],
    duration_turns: 'indefinite' as const
  };

  applyEnforcementPackage(state, enforcementPackage);

  strictEqual(state.ceasefire?.['edge1']?.until_turn, null);
});

test('expire ceasefire entries: removes expired entries', () => {
  const state = createTestState();
  state.ceasefire = {
    edge1: { since_turn: 1, until_turn: 3 }, // Expired
    edge2: { since_turn: 1, until_turn: 10 }, // Not expired
    edge3: { since_turn: 1, until_turn: null } // Indefinite
  };
  state.meta.turn = 5;

  expireCeasefireEntries(state);

  strictEqual(state.ceasefire?.['edge1'], undefined);
  ok(state.ceasefire?.['edge2']);
  ok(state.ceasefire?.['edge3']);
});

test('expire ceasefire entries: deactivates when all expired', () => {
  const state = createTestState();
  state.negotiation_status = { ceasefire_active: true, ceasefire_since_turn: 1, last_offer_turn: 1 };
  state.ceasefire = {
    edge1: { since_turn: 1, until_turn: 3 }
  };
  state.meta.turn = 5;

  expireCeasefireEntries(state);

  strictEqual(state.negotiation_status?.ceasefire_active, false);
  strictEqual(Object.keys(state.ceasefire ?? {}).length, 0);
});

test('frozen edges: effective weight becomes 0', async () => {
  const state = createTestState();
  state.ceasefire = {
    edge1: { since_turn: 5, until_turn: null }
  };
  state.front_posture = {
    faction_a: {
      assignments: {
        edge1: { edge_id: 'edge1', posture: 'push', weight: 5 },
        edge2: { edge_id: 'edge2', posture: 'push', weight: 3 }
      }
    }
  };
  // Add formations to provide commitment so edge2 gets non-zero effective weight
  state.formations = {
    F1: {
      id: 'F1',
      faction: 'faction_a',
      name: 'Test Formation',
      created_turn: 1,
      status: 'active',
      assignment: { kind: 'edge', edge_id: 'edge2' },
      ops: { fatigue: 0, last_supplied_turn: 5 }
    }
  };
  const derivedFrontEdges: FrontEdge[] = [
    { edge_id: 'edge1', a: 'sid1', b: 'sid3', side_a: 'faction_a', side_b: 'faction_b' },
    { edge_id: 'edge2', a: 'sid2', b: 'sid4', side_a: 'faction_a', side_b: 'faction_b' }
  ];

  // Import the commitment function to test frozen edge behavior
  const { applyFormationCommitment } = await import('../src/state/front_posture_commitment.js');
  const { computeFrontRegions } = await import('../src/map/front_regions.js');
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);
  const { effectivePosture } = applyFormationCommitment(state, derivedFrontEdges, frontRegions);

  // edge1 should have effective_weight = 0 (frozen)
  const edge1Effective = effectivePosture.faction_a?.assignments?.['edge1'];
  strictEqual(edge1Effective?.effective_weight, 0);
  strictEqual(edge1Effective?.base_weight, 5);

  // edge2 should have normal effective_weight (not frozen, has commitment)
  const edge2Effective = effectivePosture.faction_a?.assignments?.['edge2'];
  ok(edge2Effective);
  strictEqual(edge2Effective.base_weight, 3);
  // With 1000 commit points and 3000 demand points, friction = 1/3, so effective = floor(3 * 1/3) = 1
  ok(edge2Effective.effective_weight > 0, `edge2 effective_weight should be > 0, got ${edge2Effective.effective_weight}`);
});
