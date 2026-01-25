import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontBreaches } from '../state/front_breaches.js';

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
    if (arg === '--json') {
      writeJson = true;
      continue;
    }
    if (arg === '--no-json') {
      writeJson = false;
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

  const total = breaches.length;
  let favoredA = 0;
  let favoredB = 0;
  for (const b of breaches) {
    if (b.favored_side === 'side_a') favoredA += 1;
    else favoredB += 1;
  }

  process.stdout.write(`front_breaches for turn ${state.meta.turn}\n`);
  process.stdout.write(`  total_breaches: ${total}\n`);
  process.stdout.write(`  favored_side_a: ${favoredA}\n`);
  process.stdout.write(`  favored_side_b: ${favoredB}\n`);

  const top = breaches.slice(0, opts.topN);
  process.stdout.write(`  top_by_abs_pressure (top ${opts.topN}):\n`);
  if (top.length === 0) {
    process.stdout.write(`    (none)\n`);
  } else {
    for (const b of top) {
      process.stdout.write(
        `    - ${b.edge_id} pressure_value=${b.pressure_value} threshold=${b.threshold} favored_side=${b.favored_side} (${b.side_a} vs ${b.side_b})\n`
      );
    }
  }

  if (opts.writeJson) {
    const outPath = resolve('data', 'derived', 'front_breaches.json');
    await mkdir(resolve('data', 'derived'), { recursive: true });
    await writeFile(outPath, JSON.stringify(breaches, null, 2), 'utf8');
    process.stdout.write(`  wrote: ${outPath}\n`);
  }
}

main().catch((err) => {
  console.error('sim:frontbreaches failed', err);
  process.exitCode = 1;
});

