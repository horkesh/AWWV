/**
 * Engine Smoke Test (v0.2.6 FROZEN)
 * 
 * Validates a save file, runs N turns, and outputs a compact deterministic summary.
 * This is a testing tool, not gameplay.
 * 
 * Usage: npm run sim:smoke <save_or_fixture> --turns N
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState, serializeState } from '../state/serialize.js';
import { validateState } from '../validate/validate.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { runTurn } from '../sim/turn_pipeline.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { computeSupplyReachability } from '../state/supply_reachability.js';
import { buildAdjacencyMap } from '../map/adjacency_map.js';
import type { GameState } from '../state/game_state.js';

interface SmokeSummary {
  turn: number;
  factions: number;
  settlements_controlled: Record<string, number>;
  front_edges: number;
  front_regions: number;
  supply_isolated: number;
  sustainability_collapsed: number;
  displacement_total: number;
  negotiation_pressure_total: number;
  exhaustion_total: number;
  end_state: boolean;
}

function parseArgs(argv: string[]): { savePath: string; turns: number } {
  let savePath: string | null = null;
  let turns: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--turns') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --turns');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --turns: ${next} (expected positive int)`);
      }
      turns = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (savePath === null) {
      savePath = resolve(arg);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (savePath === null) {
    throw new Error('Usage: npm run sim:smoke <save_or_fixture> --turns N');
  }
  if (turns === null) {
    throw new Error('Missing required --turns N');
  }

  return { savePath, turns };
}

function computeSmokeSummary(state: GameState, graph: Awaited<ReturnType<typeof loadSettlementGraph>>): SmokeSummary {
  const frontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, frontEdges);
  const adjacencyMap = buildAdjacencyMap(graph.edges);
  const supplyReport = computeSupplyReachability(state, adjacencyMap);

  // Count settlements controlled by each faction
  const settlementsControlled: Record<string, number> = {};
  for (const f of state.factions) {
    settlementsControlled[f.id] = f.areasOfResponsibility.length;
  }

  // Count isolated settlements
  const totalIsolated = supplyReport.factions.reduce((sum, f) => sum + f.isolated_controlled.length, 0);

  // Count collapsed municipalities
  let collapsedCount = 0;
  if (state.sustainability_state) {
    for (const sust of Object.values(state.sustainability_state)) {
      if (sust.collapsed) collapsedCount += 1;
    }
  }

  // Sum displacement
  let displacementTotal = 0;
  if (state.displacement_state) {
    for (const disp of Object.values(state.displacement_state)) {
      displacementTotal += disp.displaced_out + disp.lost_population;
    }
  }

  // Sum negotiation pressure
  let negotiationPressureTotal = 0;
  for (const f of state.factions) {
    negotiationPressureTotal += f.negotiation?.pressure ?? 0;
  }

  // Sum exhaustion
  let exhaustionTotal = 0;
  for (const f of state.factions) {
    exhaustionTotal += f.profile.exhaustion;
  }

  return {
    turn: state.meta.turn,
    factions: state.factions.length,
    settlements_controlled: settlementsControlled,
    front_edges: frontEdges.length,
    front_regions: frontRegions.regions.length,
    supply_isolated: totalIsolated,
    sustainability_collapsed: collapsedCount,
    displacement_total: displacementTotal,
    negotiation_pressure_total: negotiationPressureTotal,
    exhaustion_total: exhaustionTotal,
    end_state: state.end_state !== null && state.end_state !== undefined
  };
}

function printSummary(summary: SmokeSummary): void {
  // Compact deterministic output (no timestamps)
  process.stdout.write(`turn=${summary.turn} `);
  process.stdout.write(`factions=${summary.factions} `);
  process.stdout.write(`front_edges=${summary.front_edges} `);
  process.stdout.write(`front_regions=${summary.front_regions} `);
  process.stdout.write(`supply_isolated=${summary.supply_isolated} `);
  process.stdout.write(`sustainability_collapsed=${summary.sustainability_collapsed} `);
  process.stdout.write(`displacement_total=${summary.displacement_total} `);
  process.stdout.write(`negotiation_pressure_total=${summary.negotiation_pressure_total} `);
  process.stdout.write(`exhaustion_total=${summary.exhaustion_total} `);
  process.stdout.write(`end_state=${summary.end_state ? 'yes' : 'no'}`);
  process.stdout.write('\n');

  // Settlements controlled per faction (sorted for determinism)
  const factionIds = Object.keys(summary.settlements_controlled).sort();
  for (const factionId of factionIds) {
    process.stdout.write(`  ${factionId}: ${summary.settlements_controlled[factionId]} settlements\n`);
  }
}

async function main(): Promise<void> {
  const { savePath, turns } = parseArgs(process.argv.slice(2));

  // Step 1: Load and validate save
  const payload = await readFile(savePath, 'utf8');
  const state = deserializeState(payload);
  const issues = validateState(state);

  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    process.stderr.write(`Validation failed: ${errors.length} error(s)\n`);
    for (const issue of errors) {
      process.stderr.write(`  [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // Step 2: Load settlement graph
  const graph = await loadSettlementGraph();

  // Step 3: Run N turns
  let currentState = state;
  for (let i = 1; i <= turns; i++) {
    const { nextState } = await runTurn(currentState, {
      seed: currentState.meta.seed,
      settlementEdges: graph.edges,
      applyNegotiation: false // Smoke test doesn't apply negotiation
    });
    currentState = nextState;

    // Check for end state (early termination)
    if (currentState.end_state) {
      process.stdout.write(`End state reached at turn ${currentState.meta.turn}\n`);
      break;
    }
  }

  // Step 4: Compute and print summary
  const summary = computeSmokeSummary(currentState, graph);
  printSummary(summary);

  // Step 5: Basic invariant checks
  let invariantFailed = false;

  // Invariant: Sustainability scores should be monotonic (never increase)
  if (state.sustainability_state && currentState.sustainability_state) {
    for (const munId of Object.keys(currentState.sustainability_state)) {
      const initial = state.sustainability_state[munId];
      const final = currentState.sustainability_state[munId];
      if (initial && final) {
        if (final.sustainability_score > initial.sustainability_score) {
          process.stderr.write(`Invariant violation: sustainability_score increased for ${munId} (${initial.sustainability_score} -> ${final.sustainability_score})\n`);
          invariantFailed = true;
        }
      }
    }
  }

  // Invariant: Displacement should be monotonic (never decrease)
  if (state.displacement_state && currentState.displacement_state) {
    for (const munId of Object.keys(currentState.displacement_state)) {
      const initial = state.displacement_state[munId];
      const final = currentState.displacement_state[munId];
      if (initial && final) {
        if (final.displaced_out < initial.displaced_out || final.lost_population < initial.lost_population) {
          process.stderr.write(`Invariant violation: displacement decreased for ${munId}\n`);
          invariantFailed = true;
        }
      }
    }
  }

  if (invariantFailed) {
    process.exitCode = 1;
    return;
  }

  // Success
  process.stdout.write('Smoke test passed.\n');
}

main().catch((err) => {
  console.error('sim:smoke failed', err);
  process.exitCode = 1;
});
