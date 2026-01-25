import { test } from 'node:test';
import assert from 'node:assert';
import type { GameState } from '../src/state/game_state.js';
import type { FrontEdge } from '../src/map/front_edges.js';
import { updateNegotiationCapital } from '../src/state/negotiation_capital.js';
import { spendNegotiationCapital } from '../src/state/negotiation_capital.js';
import type { NegotiationPressureStepReport } from '../src/state/negotiation_pressure.js';
import type { FormationFatigueStepReport } from '../src/state/formation_fatigue.js';
import type { AcceptanceReport } from '../src/state/negotiation_offers.js';

function createTestState(): GameState {
  return {
    schema_version: 1,
    meta: { turn: 5, seed: 'test' },
    factions: [
      {
        id: 'faction_a',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 10 },
        areasOfResponsibility: ['sid1', 'sid2'],
        supply_sources: [],
        negotiation: { pressure: 5, last_change_turn: 3, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'faction_b',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 20 },
        areasOfResponsibility: ['sid3', 'sid4'],
        supply_sources: [],
        negotiation: { pressure: 10, last_change_turn: 4, capital: 0, spent_total: 0, last_capital_change_turn: null }
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

test('negotiation capital: defaults set correctly', () => {
  const state = createTestState();
  assert.strictEqual(state.factions[0].negotiation?.capital, 0);
  assert.strictEqual(state.factions[0].negotiation?.spent_total, 0);
  assert.strictEqual(state.factions[0].negotiation?.last_capital_change_turn, null);
  assert.ok(Array.isArray(state.negotiation_ledger));
});

test('negotiation capital: gain computation matches formula', () => {
  const state = createTestState();
  
  const pressureReport: NegotiationPressureStepReport = {
    per_faction: [
      {
        faction_id: 'faction_a',
        pressure_before: 5,
        pressure_after: 7,
        delta: 2,
        components: { exhaustion_delta: 1, instability_breaches: 1, supply_formations: 0, supply_militia: 0, sustainability_collapse: 0 },
        total_increment: 2
      },
      {
        faction_id: 'faction_b',
        pressure_before: 10,
        pressure_after: 10,
        delta: 0,
        components: { exhaustion_delta: 0, instability_breaches: 0, supply_formations: 0, supply_militia: 0, sustainability_collapse: 0 },
        total_increment: 0
      }
    ]
  };

  const formationReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [
      {
        faction_id: 'faction_a',
        formations_active: 15,
        formations_supplied: 15,
        formations_unsupplied: 0,
        total_fatigue: 0,
        total_commit_points: 15000
      },
      {
        faction_id: 'faction_b',
        formations_active: 0,
        formations_supplied: 0,
        formations_unsupplied: 0,
        total_fatigue: 0,
        total_commit_points: 0
      }
    ]
  };

  const report = updateNegotiationCapital(state, pressureReport, formationReport, undefined);

  // faction_a: pressure_gain = floor(2/2) = 1, supply_viability = floor(15/10) = 1, diplomatic_momentum = 0
  // Total = 1 + 1 + 0 = 2, capped at 5, so 2
  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  assert.ok(factionA);
  assert.strictEqual(factionA.capital_gain, 2);
  assert.strictEqual(factionA.components.pressure_gain, 1);
  assert.strictEqual(factionA.components.supply_viability, 1);
  assert.strictEqual(factionA.components.diplomatic_momentum, 0);
  assert.strictEqual(state.factions[0].negotiation?.capital, 2);
  assert.strictEqual(state.factions[0].negotiation?.last_capital_change_turn, 5);

  // faction_b: all components 0, so gain = 0
  const factionB = report.per_faction.find((f) => f.faction_id === 'faction_b');
  assert.ok(factionB);
  assert.strictEqual(factionB.capital_gain, 0);
  assert.strictEqual(state.factions[1].negotiation?.capital, 0);
});

test('negotiation capital: gain capped at 5', () => {
  const state = createTestState();
  
  const pressureReport: NegotiationPressureStepReport = {
    per_faction: [
      {
        faction_id: 'faction_a',
        pressure_before: 5,
        pressure_after: 25,
        delta: 20,
        components: { exhaustion_delta: 10, instability_breaches: 5, supply_formations: 5, supply_militia: 0, sustainability_collapse: 0 },
        total_increment: 20
      }
    ]
  };

  const formationReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [
      {
        faction_id: 'faction_a',
        formations_active: 100,
        formations_supplied: 100,
        formations_unsupplied: 0,
        total_fatigue: 0,
        total_commit_points: 100000
      }
    ]
  };

  const report = updateNegotiationCapital(state, pressureReport, formationReport, undefined);

  // pressure_gain = floor(20/2) = 10, supply_viability = floor(100/10) = 10, diplomatic_momentum = 0
  // Total = 10 + 10 + 0 = 20, but capped at 5
  const factionA = report.per_faction.find((f) => f.faction_id === 'faction_a');
  assert.ok(factionA);
  assert.strictEqual(factionA.capital_gain, 5);
  assert.strictEqual(state.factions[0].negotiation?.capital, 5);
});

test('negotiation capital: ledger ids deterministic', () => {
  const state = createTestState();
  state.meta.turn = 10;
  
  const pressureReport: NegotiationPressureStepReport = {
    per_faction: [
      {
        faction_id: 'faction_a',
        pressure_before: 5,
        pressure_after: 7,
        delta: 2,
        components: { exhaustion_delta: 2, instability_breaches: 0, supply_formations: 0, supply_militia: 0, sustainability_collapse: 0 },
        total_increment: 2
      }
    ]
  };

  const formationReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [
      {
        faction_id: 'faction_a',
        formations_active: 15,
        formations_supplied: 15,
        formations_unsupplied: 0,
        total_fatigue: 0,
        total_commit_points: 15000
      }
    ]
  };

  updateNegotiationCapital(state, pressureReport, formationReport, undefined);

  // Should have 2 ledger entries (pressure_gain and supply_viability, sorted by reason)
  const ledgerEntries = state.negotiation_ledger?.filter((e) => e.faction_id === 'faction_a' && e.turn === 10) ?? [];
  assert.strictEqual(ledgerEntries.length, 2);
  assert.strictEqual(ledgerEntries[0].id, 'NLED_10_faction_a_gain_1');
  assert.strictEqual(ledgerEntries[0].reason, 'pressure_gain');
  assert.strictEqual(ledgerEntries[1].id, 'NLED_10_faction_a_gain_2');
  assert.strictEqual(ledgerEntries[1].reason, 'supply_viability');
});

test('negotiation capital: spend reduces capital and increases spent_total', () => {
  const state = createTestState();
  state.factions[0].negotiation!.capital = 10;
  state.factions[0].negotiation!.spent_total = 0;

  spendNegotiationCapital(state, 'faction_a', 3, 'pre_treaty_reserve');

  assert.strictEqual(state.factions[0].negotiation?.capital, 7);
  assert.strictEqual(state.factions[0].negotiation?.spent_total, 3);
  assert.strictEqual(state.factions[0].negotiation?.last_capital_change_turn, 5);

  // Check ledger entry
  const ledgerEntries = state.negotiation_ledger?.filter((e) => e.faction_id === 'faction_a' && e.kind === 'spend') ?? [];
  assert.strictEqual(ledgerEntries.length, 1);
  assert.strictEqual(ledgerEntries[0].amount, 3);
  assert.strictEqual(ledgerEntries[0].reason, 'pre_treaty_reserve');
  assert.strictEqual(ledgerEntries[0].id, 'NLED_5_faction_a_spend_1');
});

test('negotiation capital: spend fails if insufficient capital', () => {
  const state = createTestState();
  state.factions[0].negotiation!.capital = 2;

  assert.throws(() => {
    spendNegotiationCapital(state, 'faction_a', 5, 'pre_treaty_reserve');
  }, /Insufficient capital/);
});

test('negotiation capital: determinism regression', () => {
  const state1 = createTestState();
  const state2 = createTestState();

  const pressureReport: NegotiationPressureStepReport = {
    per_faction: [
      {
        faction_id: 'faction_a',
        pressure_before: 5,
        pressure_after: 7,
        delta: 2,
        components: { exhaustion_delta: 2, instability_breaches: 0, supply_formations: 0, supply_militia: 0, sustainability_collapse: 0 },
        total_increment: 2
      }
    ]
  };

  const formationReport: FormationFatigueStepReport = {
    by_formation: [],
    by_faction: [
      {
        faction_id: 'faction_a',
        formations_active: 15,
        formations_supplied: 15,
        formations_unsupplied: 0,
        total_fatigue: 0,
        total_commit_points: 15000
      }
    ]
  };

  updateNegotiationCapital(state1, pressureReport, formationReport, undefined);
  updateNegotiationCapital(state2, pressureReport, formationReport, undefined);

  // Results should be identical
  assert.strictEqual(state1.factions[0].negotiation?.capital, state2.factions[0].negotiation?.capital);
  assert.strictEqual(state1.negotiation_ledger?.length, state2.negotiation_ledger?.length);
  if (state1.negotiation_ledger && state2.negotiation_ledger) {
    assert.deepStrictEqual(state1.negotiation_ledger, state2.negotiation_ledger);
  }
});
