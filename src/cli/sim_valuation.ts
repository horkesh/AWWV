import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { deserializeState } from '../state/serialize.js';
import { computeSettlementValues } from '../state/territorial_valuation.js';
import type { TerritorialValuationReport } from '../state/territorial_valuation.js';

function parseArgs(argv: string[]): {
  savePath: string;
  outPath: string | null;
  reportOutPath: string | null;
  json: boolean;
} {
  let savePath: string | null = null;
  let outPath: string | null = null;
  let reportOutPath: string | null = null;
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
    if (arg === '--report-out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --report-out');
      reportOutPath = resolve(next);
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
    throw new Error('Usage: npm run sim:valuation <save.json> [--json] [--out <path>] [--report-out <path>]');
  }

  return { savePath, outPath, reportOutPath, json };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();

  // Compute valuation report
  const report = computeSettlementValues(state, graph);

  // Determine output paths
  const defaultReportOut = resolve('data', 'derived', `territorial_valuation_turn_${report.turn}.json`);
  const reportOutPath = opts.reportOutPath ?? (opts.json ? defaultReportOut : null);

  if (opts.json || reportOutPath) {
    const output = JSON.stringify(report, null, 2);
    if (reportOutPath) {
      await mkdir(dirname(reportOutPath), { recursive: true });
      await writeFile(reportOutPath, output, 'utf8');
      process.stdout.write(`Territorial valuation report written to ${reportOutPath}\n`);
    }
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`Territorial valuation report written to ${opts.outPath}\n`);
    }
  } else {
    // Human-readable summary
    process.stdout.write(`Territorial Valuation Report (Turn ${report.turn})\n`);
    process.stdout.write(`Schema: ${report.schema}\n`);
    process.stdout.write(`Sides: ${report.sides.join(', ')}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`Settlements: ${report.per_settlement.length}\n`);
    process.stdout.write(`\n`);

    // Show sample of settlements (first 20)
    const sample = report.per_settlement.slice(0, 20);
    process.stdout.write(`Sample settlements (first ${sample.length}):\n`);
    for (const entry of sample) {
      const values = report.sides.map((side) => `${side}=${entry.by_side[side]}`).join(', ');
      process.stdout.write(`  ${entry.sid}: ${values}\n`);
    }
    if (report.per_settlement.length > 20) {
      process.stdout.write(`  ... (${report.per_settlement.length - 20} more)\n`);
    }
    process.stdout.write(`\n`);

    // Summary statistics
    const allValues: Record<string, number[]> = {};
    for (const side of report.sides) {
      allValues[side] = [];
    }
    for (const entry of report.per_settlement) {
      for (const side of report.sides) {
        allValues[side].push(entry.by_side[side] ?? 0);
      }
    }

    process.stdout.write(`Summary statistics:\n`);
    for (const side of report.sides) {
      const values = allValues[side];
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = values.length > 0 ? sum / values.length : 0;
      const max = Math.max(...values);
      const min = Math.min(...values);
      process.stdout.write(`  ${side}: avg=${avg.toFixed(1)}, min=${min}, max=${max}, total=${sum}\n`);
    }
  }
}

main().catch((err) => {
  console.error('sim:valuation failed', err);
  process.exitCode = 1;
});
