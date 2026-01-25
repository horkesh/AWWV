import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';

type CliOptions = {
  savePath: string;
  outPath: string;
  topN: number;
  writeJson: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const defaultSavePath = resolve('saves', 'save_0001.json');
  const defaultOutPath = resolve('data', 'derived', 'front_regions.json');

  const positional: string[] = [];
  let outPath: string | null = null;
  let topN = 10;
  let writeJson = true;

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
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
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

  const savePath = positional.length > 0 ? resolve(positional[0]) : defaultSavePath;
  return {
    savePath,
    outPath: outPath ?? defaultOutPath,
    topN,
    writeJson
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const regionsFile = computeFrontRegions(state, derivedFrontEdges);

  // Summary: counts by side_pair (deterministic side_pair asc)
  const bySidePair = new Map<string, { regions: number; active_edges: number }>();
  for (const r of regionsFile.regions) {
    const cur = bySidePair.get(r.side_pair) ?? { regions: 0, active_edges: 0 };
    cur.regions += 1;
    cur.active_edges += r.active_edge_count;
    bySidePair.set(r.side_pair, cur);
  }

  process.stdout.write(`front_regions for turn ${regionsFile.turn}\n`);
  process.stdout.write(`  total_regions: ${regionsFile.regions.length}\n`);
  process.stdout.write(`  by_side_pair:\n`);
  const sidePairsSorted = Array.from(bySidePair.keys()).sort((a, b) => a.localeCompare(b));
  if (sidePairsSorted.length === 0) {
    process.stdout.write(`    (none)\n`);
  } else {
    for (const sp of sidePairsSorted) {
      const row = bySidePair.get(sp)!;
      process.stdout.write(`    - ${sp}: regions=${row.regions} active_edges=${row.active_edges}\n`);
    }
  }

  // Top N regions by active_edge_count (tie region_id asc)
  const top = [...regionsFile.regions]
    .sort((a, b) => {
      if (a.active_edge_count !== b.active_edge_count) return b.active_edge_count - a.active_edge_count;
      return a.region_id.localeCompare(b.region_id);
    })
    .slice(0, opts.topN);

  process.stdout.write(`  top_regions_by_active_edge_count (top ${opts.topN}):\n`);
  if (top.length === 0) {
    process.stdout.write(`    (none)\n`);
  } else {
    for (const r of top) {
      process.stdout.write(
        `    - ${r.region_id} side_pair=${r.side_pair} active_edge_count=${r.active_edge_count} settlements=${r.settlements.length}\n`
      );
    }
  }

  if (opts.writeJson) {
    await mkdir(resolve(opts.outPath, '..'), { recursive: true });
    await writeFile(opts.outPath, JSON.stringify(regionsFile, null, 2), 'utf8');
    process.stdout.write(`  wrote: ${opts.outPath}\n`);
  }
}

main().catch((err) => {
  console.error('sim:frontregions failed', err);
  process.exitCode = 1;
});

