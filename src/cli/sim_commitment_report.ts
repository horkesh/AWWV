import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { applyFormationCommitment, type CommitmentStepReport } from '../state/front_posture_commitment.js';

type CliOptions = {
  savePath: string;
  json: boolean;
  outPath: string | null;
};

type CommitmentReportFile = {
  schema: 1;
  turn: number;
  commitment: CommitmentStepReport;
};

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let json = false;
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
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

  if (positional.length < 1) {
    throw new Error('Usage: npm run sim:commitment <save.json> [--json] [--out <path>]');
  }
  const savePath = resolve(positional[0]);

  return { savePath, json, outPath };
}

function printHumanReadableReport(report: CommitmentStepReport, turn: number): void {
  process.stdout.write(`Commitment Report (Turn ${turn})\n`);
  process.stdout.write('='.repeat(60) + '\n\n');

  process.stdout.write('By Faction:\n');
  for (const f of report.by_faction) {
    process.stdout.write(`  ${f.faction_id}:\n`);
    process.stdout.write(`    Active formations: ${f.formations_active}\n`);
    process.stdout.write(`      - Assigned to regions: ${f.formations_assigned_region}\n`);
    process.stdout.write(`      - Assigned to edges: ${f.formations_assigned_edge}\n`);
    process.stdout.write(`    Total commit points: ${f.total_commit_points} (milli-points)\n`);
    process.stdout.write(`    Total demand weight: ${f.total_demand_weight}\n`);
    process.stdout.write(`    Total effective weight: ${f.total_effective_weight}\n`);
    process.stdout.write(`    Command capacity: ${f.command_capacity}\n`);
    if (f.capacity_applied) {
      process.stdout.write(`    Global factor applied: ${f.global_factor.toFixed(4)}\n`);
    }
    process.stdout.write('\n');
  }

  if (report.global_capacity) {
    process.stdout.write('Global Capacity:\n');
    process.stdout.write(`  Total demand: ${report.global_capacity.total_demand}\n`);
    process.stdout.write(`  Command capacity: ${report.global_capacity.command_capacity}\n`);
    process.stdout.write(`  Global factor: ${report.global_capacity.global_factor.toFixed(4)}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write(`By Edge (${report.by_edge.length} edges):\n`);
  const topEdges = report.by_edge.slice(0, 10);
  for (const e of topEdges) {
    process.stdout.write(`  ${e.edge_id}:\n`);
    process.stdout.write(`    Base weight: ${e.base_weight}\n`);
    process.stdout.write(`    Commit points: ${e.commit_points} (milli-points)\n`);
    process.stdout.write(`    Friction factor: ${e.friction_factor.toFixed(4)}\n`);
    process.stdout.write(`    Effective weight: ${e.effective_weight}\n`);
  }
  if (report.by_edge.length > 10) {
    process.stdout.write(`  ... and ${report.by_edge.length - 10} more edges\n`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);

  const { report } = applyFormationCommitment(state, derivedFrontEdges, frontRegions);

  if (opts.json) {
    const reportFile: CommitmentReportFile = {
      schema: 1,
      turn: state.meta.turn,
      commitment: report
    };

    const outPath = opts.outPath ?? resolve('data', 'derived', 'commitment_report.json');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(reportFile, null, 2), 'utf8');
    process.stdout.write(`Commitment report written to: ${outPath}\n`);
  } else {
    printHumanReadableReport(report, state.meta.turn);
    if (opts.outPath) {
      const reportFile: CommitmentReportFile = {
        schema: 1,
        turn: state.meta.turn,
        commitment: report
      };
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, JSON.stringify(reportFile, null, 2), 'utf8');
      process.stdout.write(`\nReport also written to: ${opts.outPath}\n`);
    }
  }
}

// Only run the CLI when invoked directly
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:commitment failed', err);
    process.exitCode = 1;
  });
}
