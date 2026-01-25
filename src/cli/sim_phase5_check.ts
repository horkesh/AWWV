import assert from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { deserializeState, serializeState } from '../state/serialize.js';
import type { GameState, PostureLevel } from '../state/game_state.js';
import { runScenarioDeterministic } from './sim_scenario.js';
import { runTurn } from '../sim/turn_pipeline.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type Phase5CheckResult = {
  chosen_region_id: string;
  chosen_edge_id: string;
  expanded_edges_count_before: number;
  expanded_edges_count_after: number;
  determinism_ok: boolean;
  no_timestamps_ok: boolean;
  scenario_summary_1_text: string;
  scenario_summary_2_text: string;
  scenario_summary_3_text: string;
};

type CliOptions = {
  savePath: string;
  faction: string;
  outdir: string;
  region: string | null;
  weight: number;
};

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 1) {
    throw new Error('Usage: npm run sim:phase5check <save.json> --faction <id> [--outdir <dir>] [--region <region_id>] [--weight 3]');
  }

  const positional: string[] = [];
  let faction: string | null = null;
  let outdir: string | null = null;
  let region: string | null = null;
  let weight = 3;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--faction') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --faction');
      faction = next;
      i += 1;
      continue;
    }
    if (arg === '--outdir') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --outdir');
      outdir = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--region') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --region');
      region = next;
      i += 1;
      continue;
    }
    if (arg === '--weight') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --weight');
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n)) throw new Error(`Invalid --weight: ${next}`);
      weight = n;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  if (positional.length < 1) {
    throw new Error('Usage: npm run sim:phase5check <save.json> --faction <id> [--outdir <dir>] [--region <region_id>] [--weight 3]');
  }
  if (!faction) throw new Error('Missing required --faction <id>');
  
  // Canonicalize faction ID
  const canonicalFaction = canonicalizePoliticalSideId(faction);
  if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
    throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
  }

  return {
    savePath: resolve(positional[0]),
    faction: canonicalFaction,
    outdir: outdir ?? resolve('data', 'derived', 'phase5check'),
    region,
    weight
  };
}

function selectBestRegion(regions: Array<{ region_id: string; active_edge_count: number }>): string | null {
  if (regions.length === 0) return null;
  const sorted = [...regions].sort((a, b) => {
    if (a.active_edge_count !== b.active_edge_count) return b.active_edge_count - a.active_edge_count;
    return a.region_id.localeCompare(b.region_id);
  });
  return sorted[0].region_id;
}

function hasTimestampLike(text: string): boolean {
  if (/"generated_at"\s*:/.test(text)) return true;
  if (/"timestamp"\s*:/.test(text)) return true;
  if (/"time"\s*:/.test(text)) return true;
  // ISO-like datetime prefix
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return true;
  return false;
}

function ensureFactionMaps(state: GameState, faction: string): void {
  if (!state.front_posture || typeof state.front_posture !== 'object') state.front_posture = {};
  if (!state.front_posture[faction]) state.front_posture[faction] = { assignments: {} };
  if (!state.front_posture[faction].assignments) state.front_posture[faction].assignments = {};

  if (!state.front_posture_regions || typeof state.front_posture_regions !== 'object') state.front_posture_regions = {};
  if (!state.front_posture_regions[faction]) state.front_posture_regions[faction] = { assignments: {} };
  if (!state.front_posture_regions[faction].assignments) state.front_posture_regions[faction].assignments = {};
}

export async function runPhase5CheckInProcess(
  baseState: GameState,
  settlementEdges: Array<{ a: string; b: string }>,
  options: { faction: string; region_id: string; edge_id: string; weight: number }
): Promise<Phase5CheckResult> {
  // Step 1: region posture set
  const state1 = structuredClone(baseState);
  ensureFactionMaps(state1, options.faction);
  state1.front_posture_regions[options.faction].assignments[options.region_id] = { posture: 'push', weight: options.weight };

  const script = { schema: 1 as const, turns: {} as Record<string, any> };
  const { summary: summary1 } = await runScenarioDeterministic(state1, {
    turns: 2,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges
  });
  const summary1Text = JSON.stringify(summary1, null, 2);
  const expandedBefore = summary1.turns[0]?.region_posture_expansion?.expanded_edges_count ?? 0;
  assert.ok(expandedBefore > 0, 'expected region posture expansion to expand at least one edge on turn 1');

  // Step 3: add explicit per-edge override (must not be overwritten)
  const state2 = structuredClone(state1);
  ensureFactionMaps(state2, options.faction);
  state2.front_posture[options.faction].assignments[options.edge_id] = { edge_id: options.edge_id, posture: 'hold', weight: 0 };

  const { summary: summary2 } = await runScenarioDeterministic(state2, {
    turns: 2,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges
  });
  const summary2Text = JSON.stringify(summary2, null, 2);
  const expandedAfter = summary2.turns[0]?.region_posture_expansion?.expanded_edges_count ?? 0;
  assert.ok(
    expandedAfter <= expandedBefore,
    `expected expanded_edges_count_after (${expandedAfter}) <= expanded_edges_count_before (${expandedBefore})`
  );

  // Verify override after expansion step on turn 1 by executing a single turn and inspecting nextState.
  const { nextState: afterTurn1 } = await runTurn(state2, { seed: state2.meta.seed, settlementEdges: settlementEdges as any });
  const got = (afterTurn1.front_posture as any)?.[options.faction]?.assignments?.[options.edge_id];
  assert.ok(got && typeof got === 'object', 'expected chosen edge to have a posture assignment after turn 1');
  assert.strictEqual(got.posture, 'hold', 'expected explicit per-edge override posture to remain after expansion');
  assert.strictEqual(got.weight, 0, 'expected explicit per-edge override weight to remain after expansion');

  // Step 5: determinism check (run same scenario again from identical input)
  const { summary: summary3 } = await runScenarioDeterministic(structuredClone(state2), {
    turns: 2,
    applyBreaches: false,
    applyNegotiation: false,
    script,
    settlementEdges
  });
  const summary3Text = JSON.stringify(summary3, null, 2);
  const determinismOk = summary2Text === summary3Text;

  // Step 6: no timestamps check on summaries (string scan)
  const noTimestampsOk = !hasTimestampLike(summary1Text) && !hasTimestampLike(summary2Text) && !hasTimestampLike(summary3Text);

  return {
    chosen_region_id: options.region_id,
    chosen_edge_id: options.edge_id,
    expanded_edges_count_before: expandedBefore,
    expanded_edges_count_after: expandedAfter,
    determinism_ok: determinismOk,
    no_timestamps_ok: noTimestampsOk,
    scenario_summary_1_text: summary1Text,
    scenario_summary_2_text: summary2Text,
    scenario_summary_3_text: summary3Text
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);

  const chosenRegionId = opts.region ?? selectBestRegion(frontRegions.regions);
  if (!chosenRegionId) throw new Error('No eligible front region found (requires at least one active front region in the save)');

  const region = frontRegions.regions.find((r) => r.region_id === chosenRegionId);
  if (!region) throw new Error(`Region not found: ${chosenRegionId}`);
  if (!Array.isArray(region.edge_ids) || region.edge_ids.length === 0) throw new Error(`Region has no edge_ids: ${chosenRegionId}`);

  const chosenEdgeId = [...region.edge_ids].sort((a, b) => a.localeCompare(b))[0];
  if (!chosenEdgeId) throw new Error('Could not select an edge_id from chosen region');

  await mkdir(opts.outdir, { recursive: true });

  // Write temp saves for auditability
  const state1 = structuredClone(state);
  ensureFactionMaps(state1, opts.faction);
  state1.front_posture_regions[opts.faction].assignments[chosenRegionId] = { posture: 'push', weight: opts.weight };
  const save1Path = resolve(opts.outdir, 'save_region.json');
  await writeFile(save1Path, serializeState(state1), 'utf8');

  const state2 = structuredClone(state1);
  ensureFactionMaps(state2, opts.faction);
  (state2.front_posture as any)[opts.faction].assignments[chosenEdgeId] = { edge_id: chosenEdgeId, posture: 'hold', weight: 0 };
  const save2Path = resolve(opts.outdir, 'save_region_plus_override.json');
  await writeFile(save2Path, serializeState(state2), 'utf8');

  // Execute checks in-process and write summaries
  const result = await runPhase5CheckInProcess(state, graph.edges, {
    faction: opts.faction,
    region_id: chosenRegionId,
    edge_id: chosenEdgeId,
    weight: opts.weight
  });

  const summary1Path = resolve(opts.outdir, 'scenario_summary_1.json');
  const summary2Path = resolve(opts.outdir, 'scenario_summary_2.json');
  const summary3Path = resolve(opts.outdir, 'scenario_summary_3.json');
  await Promise.all([
    writeFile(summary1Path, result.scenario_summary_1_text, 'utf8'),
    writeFile(summary2Path, result.scenario_summary_2_text, 'utf8'),
    writeFile(summary3Path, result.scenario_summary_3_text, 'utf8')
  ]);

  // Print deterministic summary (no timestamps)
  process.stdout.write('phase5check PASS\n');
  process.stdout.write(`  chosen_region_id: ${result.chosen_region_id}\n`);
  process.stdout.write(`  chosen_edge_id: ${result.chosen_edge_id}\n`);
  process.stdout.write(`  expanded_edges_count_before: ${result.expanded_edges_count_before}\n`);
  process.stdout.write(`  expanded_edges_count_after: ${result.expanded_edges_count_after}\n`);
  process.stdout.write(`  determinism_ok: ${result.determinism_ok}\n`);
  process.stdout.write(`  no_timestamps_ok: ${result.no_timestamps_ok}\n`);
  process.stdout.write(`  outdir: ${opts.outdir}\n`);

  if (!result.determinism_ok) throw new Error('Determinism check failed: scenario_summary_2.json != scenario_summary_3.json');
  if (!result.no_timestamps_ok) throw new Error('No-timestamps check failed: scenario summaries contain timestamp-like fields/strings');
}

// Only run the CLI when invoked directly (tests import runPhase5CheckInProcess).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:phase5check failed', err);
    process.exitCode = 1;
  });
}

