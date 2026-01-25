import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges, computeFrontEdgeStats } from '../map/front_edges.js';

const defaultSavePath = resolve('saves', 'save_0001.json');
const frontEdgesPath = resolve('data', 'derived', 'front_edges.json');

async function main(): Promise<void> {
  const savePath = process.argv[2] ? resolve(process.argv[2]) : defaultSavePath;

  try {
    // Load game state
    const payload = await readFile(savePath, 'utf8');
    const state = deserializeState(payload);

    // Load settlement graph
    const graph = await loadSettlementGraph();

    // Compute front edges
    const frontEdges = computeFrontEdges(state, graph.edges);
    const stats = computeFrontEdgeStats(frontEdges);

    // Create output
    const frontEdgesJson = {
      version: '1.0.0',
      turn: state.meta.turn,
      source_state: savePath,
      front_edges: frontEdges,
      stats: stats
    };

    // Write output
    await mkdir(resolve('data', 'derived'), { recursive: true });
    await writeFile(frontEdgesPath, JSON.stringify(frontEdgesJson, null, 2), 'utf8');

    // Print summary
    process.stdout.write(`Front edges computed for turn ${state.meta.turn}\n`);
    process.stdout.write(`  Total front edges: ${stats.total_front_edges}\n`);
    if (stats.total_front_edges > 0) {
      const pairs = Object.entries(stats.side_pairs)
        .sort(([, a], [, b]) => b - a)
        .map(([pair, count]) => `    ${pair}: ${count}`)
        .join('\n');
      process.stdout.write(`  Side pairs:\n${pairs}\n`);
    }
    process.stdout.write(`  Written to: ${frontEdgesPath}\n`);
  } catch (err) {
    console.error('sim:frontedges failed', err);
    process.exitCode = 1;
  }
}

main();
