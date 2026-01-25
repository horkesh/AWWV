import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontBreaches } from '../state/front_breaches.js';
import { buildAdjacencyMap, computeControlFlipProposals } from '../state/control_flip_proposals.js';

type CliOptions = {
  savePath: string;
  topN: number;
  writeJson: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const defaultSavePath = resolve('saves', 'save_0001.json');
  let savePath = defaultSavePath;
  let topN = 10;
  let writeJson = true; // default: write artifact

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-json') {
      writeJson = false;
      continue;
    }
    if (arg === '--json') {
      writeJson = true;
      continue;
    }
    if (arg === '--top') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --top');
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --top value: ${next}`);
      topN = n;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  if (positional.length >= 1) savePath = resolve(positional[0]);
  return { savePath, topN, writeJson };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const breaches = computeFrontBreaches(state, derivedFrontEdges);
  const adjacencyMap = buildAdjacencyMap(graph.edges);
  const file = computeControlFlipProposals(state, derivedFrontEdges, breaches, adjacencyMap);

  const totalProposals = file.proposals.length;
  const totalTargets = file.proposals.reduce((acc, p) => acc + p.targets.length, 0);

  process.stdout.write(`control_flip_proposals for turn ${file.turn}\n`);
  process.stdout.write(`  total_proposals: ${totalProposals}\n`);
  process.stdout.write(`  total_targets: ${totalTargets}\n`);

  const top = file.proposals.slice(0, opts.topN);
  process.stdout.write(`  top_by_abs_pressure (top ${opts.topN}):\n`);
  if (top.length === 0) {
    process.stdout.write(`    (none)\n`);
  } else {
    for (const p of top) {
      process.stdout.write(
        `    - ${p.edge_id} pressure_value=${p.pressure_value} favored=${p.favored_side} losing=${p.losing_side} targets=${p.targets.length}\n`
      );
    }
  }

  if (opts.writeJson) {
    const outPath = resolve('data', 'derived', 'control_flip_proposals.json');
    await mkdir(resolve('data', 'derived'), { recursive: true });
    await writeFile(outPath, JSON.stringify(file, null, 2), 'utf8');
    process.stdout.write(`  wrote: ${outPath}\n`);
  }
}

main().catch((err) => {
  console.error('sim:proposeflips failed', err);
  process.exitCode = 1;
});

