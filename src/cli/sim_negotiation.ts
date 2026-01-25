import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { deserializeState } from '../state/serialize.js';
import { runTurn } from '../sim/turn_pipeline.js';
import type { NegotiationPressureStepReport } from '../state/negotiation_pressure.js';

function parseArgs(argv: string[]): { savePath: string; outPath: string; json: boolean } {
  let savePath: string | null = null;
  let outPath: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (savePath === null) {
      savePath = resolve(arg);
    }
  }

  if (savePath === null) {
    throw new Error('Usage: npm run sim:negotiation <save.json> [--json] [--out <path>]');
  }

  const defaultOut = resolve('data', 'derived', 'negotiation_pressure_report.json');
  return { savePath, outPath: outPath ?? defaultOut, json };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();

  // Run one turn to compute negotiation pressure report
  const { report } = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });

  const negotiationReport: NegotiationPressureStepReport | undefined = report.negotiation_pressure;

  if (!negotiationReport) {
    throw new Error('Negotiation pressure report not found in turn report');
  }

  if (opts.json) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, JSON.stringify(negotiationReport, null, 2), 'utf8');
    process.stdout.write(`Negotiation pressure report written to ${opts.outPath}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Negotiation Pressure Report (Turn ${state.meta.turn + 1})\n`);
    process.stdout.write(`\n`);
    for (const f of negotiationReport.per_faction) {
      process.stdout.write(`Faction: ${f.faction_id}\n`);
      process.stdout.write(`  Pressure: ${f.pressure_before} → ${f.pressure_after} (delta: ${f.delta})\n`);
      process.stdout.write(`  Components:\n`);
      process.stdout.write(`    Exhaustion delta: +${f.components.exhaustion_delta}\n`);
      process.stdout.write(`    Instability (breaches): +${f.components.instability_breaches}\n`);
      process.stdout.write(`    Supply isolation (formations): +${f.components.supply_formations}\n`);
      process.stdout.write(`    Supply isolation (militia): +${f.components.supply_militia}\n`);
      process.stdout.write(`  Total increment: ${f.total_increment}\n`);
      process.stdout.write(`\n`);
    }
  }
}

main().catch((err) => {
  console.error('sim:negotiation failed', err);
  process.exitCode = 1;
});
