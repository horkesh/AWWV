/**
 * Phase 13B.1: Brčko completeness acceptance constraint
 *
 * - Peace-triggering treaties without brcko_special_status are rejected (brcko_unresolved).
 * - Military-only or non-peace treaties are unaffected.
 * - Ordering: bundle violations win over brcko_unresolved.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import { createClause, buildTreatyDraft } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import type { FrontEdge } from '../src/map/front_edges.js';

function createTestState(): GameState {
  return {
    schema_version: 1,
    meta: { turn: 5, seed: 'test' },
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['1', '2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 100, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['3', '4'],
        supply_sources: [],
        negotiation: { pressure: 15, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    negotiation_ledger: []
  };
}

function createHighPressureState(): GameState {
  return {
    ...createTestState(),
    factions: [
      {
        id: 'RBiH',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['1', '2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 100, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'RS',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['3', '4'],
        supply_sources: [],
        negotiation: { pressure: 50, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ]
  };
}

const frontEdges: FrontEdge[] = [];

function militaryAndTerritorialClauses() {
  return [
    createClause('m1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' }),
    createClause('t1', 'territorial', 'recognize_control_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] })
  ];
}

function brckoClause() {
  return createClause('b1', 'territorial', 'brcko_special_status', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] });
}

function allocateClause(id: string, competence: string, holder: string) {
  return createClause(
    id,
    'institutional',
    'allocate_competence',
    'RBiH',
    ['RS'],
    { kind: 'global' },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    competence,
    holder
  );
}

test('Brčko completeness: peace-triggering treaty without brcko_special_status is rejected', () => {
  const state = createHighPressureState();
  const clauses = [...militaryAndTerritorialClauses()];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'brcko_unresolved');
  assert.ok(report.rejection_details);
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_brcko_resolution');
});

test('Brčko completeness: peace-triggering with transfer_settlements without brcko is rejected', () => {
  const state = createHighPressureState();
  const clauses = [
    createClause('m1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' }),
    createClause('t1', 'territorial', 'transfer_settlements', 'RBiH', ['RS'], { kind: 'settlements', sids: ['1'] }, undefined, 'RS', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'brcko_unresolved');
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_brcko_resolution');
});

test('Brčko completeness: peace-triggering treaty WITH brcko_special_status is accepted', () => {
  const state = createHighPressureState();
  const clauses = [...militaryAndTerritorialClauses(), brckoClause()];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
  assert.strictEqual(report.rejection_details, undefined);
});

test('Brčko completeness: military-only treaty without brcko_special_status is not rejected by brcko constraint', () => {
  const state = createHighPressureState();
  const clauses = [
    createClause('m1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' })
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
  assert.strictEqual(report.rejection_details, undefined);
});

test('Brčko completeness: treaty with only brcko_special_status (no other territorial) accepted', () => {
  const state = createHighPressureState();
  const clauses = [
    createClause('m1', 'military', 'monitoring_light', 'RBiH', ['RS'], { kind: 'global' }),
    brckoClause()
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, true);
  assert.strictEqual(report.rejection_reason, undefined);
});

test('Brčko completeness: bundle violation wins over brcko_unresolved (determinism)', () => {
  const state = createHighPressureState();
  const clauses = [
    ...militaryAndTerritorialClauses(),
    allocateClause('c1', 'customs', 'RBiH')
  ];
  const draft = buildTreatyDraft(5, 'RBiH', clauses);
  const report = evaluateTreatyAcceptance(state, draft, frontEdges, undefined);

  assert.strictEqual(report.accepted_by_all_targets, false);
  assert.strictEqual(report.rejection_reason, 'competence_bundle_incomplete');
  assert.strictEqual(report.rejection_details!.constraint_type, 'require_bundle');
});
