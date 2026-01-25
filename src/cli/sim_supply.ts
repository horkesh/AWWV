import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { buildAdjacencyMap } from '../map/adjacency_map.js';
import { computeSupplyReachability } from '../state/supply_reachability.js';

const defaultPath = resolve('saves', 'save_0001.json');
const defaultOutPath = resolve('data', 'derived', 'supply_reachability.json');

type CliOptions = {
  savePath: string;
  outPath: string;
};

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  const savePath = positional.length > 0 ? resolve(positional[0]) : defaultPath;

  return {
    savePath,
    outPath: outPath ?? defaultOutPath
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const adjacencyMap = buildAdjacencyMap(graph.edges);
  const report = computeSupplyReachability(state, adjacencyMap);

  await mkdir(resolve(opts.outPath, '..'), { recursive: true });
  await writeFile(opts.outPath, JSON.stringify(report, null, 2), 'utf8');

  process.stdout.write(`supply_reachability for turn ${report.turn}\n`);
  for (const faction of report.factions) {
    process.stdout.write(
      `  ${faction.faction_id}: controlled=${faction.controlled.length}, ` +
      `reachable=${faction.reachable_controlled.length}, ` +
      `isolated=${faction.isolated_controlled.length}\n`
    );
  }

  process.stdout.write(`  wrote: ${opts.outPath}\n`);
}

// Only run the CLI when invoked directly (tests may import functions).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:supply failed', err);
    process.exitCode = 1;
  });
}
