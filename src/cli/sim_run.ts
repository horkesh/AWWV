import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { runTurn } from '../sim/turn_pipeline.js';
import { CURRENT_SCHEMA_VERSION, GameState } from '../state/game_state.js';
import { serializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges, computeFrontEdgeStats } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { computeFrontBreaches } from '../state/front_breaches.js';
import { applyControlFlipProposals, buildAdjacencyMap, computeControlFlipProposals } from '../state/control_flip_proposals.js';

const savePath = resolve('saves', 'save_0001.json');
const frontEdgesPath = resolve('data', 'derived', 'front_edges.json');
const frontBreachesPath = resolve('data', 'derived', 'front_breaches.json');
const controlFlipProposalsPath = resolve('data', 'derived', 'control_flip_proposals.json');
const frontRegionsPath = resolve('data', 'derived', 'front_regions.json');

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

async function main(): Promise<void> {
  const applyBreaches = hasFlag('--apply-breaches');
  const graph = await loadSettlementGraph();
  const initial: GameState = {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'sim-seed' },
    factions: [],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };

  const { nextState, report } = await runTurn(initial, { seed: initial.meta.seed, settlementEdges: graph.edges });

  await mkdir(dirname(savePath), { recursive: true });
  await writeFile(savePath, serializeState(nextState), 'utf8');

  // Compute and write front edges
  try {
    const frontEdges = computeFrontEdges(nextState, graph.edges);
    const stats = computeFrontEdgeStats(frontEdges);
    
    const frontEdgesJson = {
      version: '1.0.0',
      turn: nextState.meta.turn,
      front_edges: frontEdges,
      stats: stats
    };
    
    await mkdir(dirname(frontEdgesPath), { recursive: true });
    await writeFile(frontEdgesPath, JSON.stringify(frontEdgesJson, null, 2), 'utf8');

    // Compute and write derived breach candidates (scaffolding only; no state mutation).
    const breaches = computeFrontBreaches(nextState, frontEdges);
    await writeFile(frontBreachesPath, JSON.stringify(breaches, null, 2), 'utf8');

    // Compute and write control flip proposals (audit artifact; proposal-only by default).
    const adjacencyMap = buildAdjacencyMap(graph.edges);
    const proposalsFile = computeControlFlipProposals(nextState, frontEdges, breaches, adjacencyMap);
    await writeFile(controlFlipProposalsPath, JSON.stringify(proposalsFile, null, 2), 'utf8');

    // Compute and write derived front regions (connected components of active front edges by side-pair).
    const frontRegionsFile = computeFrontRegions(nextState, frontEdges);
    await writeFile(frontRegionsPath, JSON.stringify(frontRegionsFile, null, 2), 'utf8');

    if (applyBreaches) {
      const { applied } = applyControlFlipProposals(nextState, proposalsFile);
      await writeFile(savePath, serializeState(nextState), 'utf8');
      process.stdout.write(`Applied ${applied} control flip(s) from breach proposals\n`);
    }
    
    process.stdout.write(`Saved turn ${nextState.meta.turn} to ${relativePath(savePath)} using seed ${report.seed}\n`);
    process.stdout.write(`Front edges: ${stats.total_front_edges} total\n`);
    if (stats.total_front_edges > 0) {
      const pairs = Object.entries(stats.side_pairs)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([pair, count]) => `${pair}: ${count}`)
        .join(', ');
      process.stdout.write(`  Side pairs: ${pairs}${Object.keys(stats.side_pairs).length > 5 ? '...' : ''}\n`);
    }
    process.stdout.write(`Front breaches: ${breaches.length} candidate(s)\n`);
    process.stdout.write(`Control flip proposals: ${proposalsFile.proposals.length} proposal(s)\n`);
    process.stdout.write(`Front regions: ${frontRegionsFile.regions.length} region(s)\n`);
  } catch (err) {
    process.stderr.write(`WARNING: Failed to compute front edges: ${err}\n`);
    process.stdout.write(`Saved turn ${nextState.meta.turn} to ${relativePath(savePath)} using seed ${report.seed}\n`);
  }
}

function relativePath(fullPath: string): string {
  const cwd = process.cwd();
  return fullPath.startsWith(cwd) ? fullPath.slice(cwd.length + 1) : basename(fullPath);
}

main().catch((err) => {
  console.error('sim:run failed', err);
  process.exitCode = 1;
});
