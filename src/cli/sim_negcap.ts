import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { deserializeState, serializeState } from '../state/serialize.js';
import { runTurn } from '../sim/turn_pipeline.js';
import { spendNegotiationCapital } from '../state/negotiation_capital.js';
import type { NegotiationCapitalStepReport } from '../state/negotiation_capital.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliMode = 'view' | 'spend';

interface ViewOptions {
  mode: 'view';
  savePath: string;
  turns: number;
  json: boolean;
  outPath: string | null;
  reportOutPath: string | null;
}

interface SpendOptions {
  mode: 'spend';
  savePath: string;
  faction: string;
  amount: number;
  reason: string;
  outPath: string | null;
}

type CliOptions = ViewOptions | SpendOptions;

function parseTurns(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --turns: ${value} (expected non-negative int)`);
  return n;
}

function parseAmount(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --amount: ${value} (expected non-negative int)`);
  return n;
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let turns: number | null = null;
  let json = false;
  let outPath: string | null = null;
  let reportOutPath: string | null = null;
  let faction: string | null = null;
  let amount: number | null = null;
  let reason: string | null = null;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--turns') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --turns');
      turns = parseTurns(next);
      i += 2;
      continue;
    }
    if (arg === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--report-out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --report-out');
      reportOutPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === 'spend') {
      // Switch to spend mode
      i += 1;
      // Parse spend-specific args
      while (i < argv.length) {
        const spendArg = argv[i];
        if (spendArg === '--faction') {
          const next = argv[i + 1];
          if (next === undefined) throw new Error('Missing value for --faction');
          faction = next;
          i += 2;
          continue;
        }
        if (spendArg === '--amount') {
          const next = argv[i + 1];
          if (next === undefined) throw new Error('Missing value for --amount');
          amount = parseAmount(next);
          i += 2;
          continue;
        }
        if (spendArg === '--reason') {
          const next = argv[i + 1];
          if (next === undefined) throw new Error('Missing value for --reason');
          reason = next;
          i += 2;
          continue;
        }
        if (spendArg === '--out') {
          const next = argv[i + 1];
          if (next === undefined) throw new Error('Missing value for --out');
          outPath = resolve(next);
          i += 2;
          continue;
        }
        if (spendArg.startsWith('--')) {
          throw new Error(`Unknown flag: ${spendArg}`);
        }
        throw new Error(`Unexpected argument in spend mode: ${spendArg}`);
      }
      break;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
    i += 1;
  }

  if (faction !== null || amount !== null || reason !== null) {
    // Spend mode
    if (faction === null) throw new Error('Missing --faction for spend command');
    if (amount === null) throw new Error('Missing --amount for spend command');
    if (reason === null) throw new Error('Missing --reason for spend command');
    if (positional.length === 0) throw new Error('Usage: npm run sim:negcap <save.json> spend --faction <id> --amount <int> --reason <string> [--out <path>]');
    
    // Canonicalize faction ID
    const canonicalFaction = canonicalizePoliticalSideId(faction);
    if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
      throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
    }
    
    return {
      mode: 'spend',
      savePath: resolve(positional[0]),
      faction: canonicalFaction,
      amount,
      reason,
      outPath
    };
  }

  // View mode
  if (positional.length === 0) throw new Error('Usage: npm run sim:negcap <save.json> [--turns 1] [--json] [--out <path>] [--report-out <path>]');
  return {
    mode: 'view',
    savePath: resolve(positional[0]),
    turns: turns ?? 1,
    json,
    outPath,
    reportOutPath
  };
}

async function runViewMode(opts: ViewOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  let state = deserializeState(payload);

  const graph = await loadSettlementGraph();

  // Run N turns
  for (let t = 0; t < opts.turns; t += 1) {
    const { nextState, report } = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });
    state = nextState;

    const capitalReport: NegotiationCapitalStepReport | undefined = report.negotiation_capital;

    if (opts.json) {
      const output: any = {
        turn: state.meta.turn,
        negotiation_capital: capitalReport,
        ledger_tail: state.negotiation_ledger?.slice(-10) ?? []
      };
      const outPath = opts.outPath ?? resolve('data', 'derived', `negotiation_capital_turn_${state.meta.turn}.json`);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
      process.stdout.write(`Negotiation capital report written to ${outPath}\n`);
    } else {
      // Human-readable summary
      process.stdout.write(`Negotiation Capital Report (Turn ${state.meta.turn})\n`);
      process.stdout.write(`\n`);
      if (capitalReport) {
        for (const f of capitalReport.per_faction) {
          process.stdout.write(`Faction: ${f.faction_id}\n`);
          process.stdout.write(`  Capital: ${f.capital_before} → ${f.capital_after} (gain: ${f.capital_gain})\n`);
          process.stdout.write(`  Components:\n`);
          process.stdout.write(`    Pressure gain: +${f.components.pressure_gain}\n`);
          process.stdout.write(`    Supply viability: +${f.components.supply_viability}\n`);
          process.stdout.write(`    Diplomatic momentum: +${f.components.diplomatic_momentum}\n`);
          process.stdout.write(`\n`);
        }
        process.stdout.write(`Ledger entries added this turn: ${capitalReport.ledger_entries_added}\n`);
        process.stdout.write(`\n`);
      }

      // Show ledger tail
      const ledgerTail = state.negotiation_ledger?.slice(-10) ?? [];
      if (ledgerTail.length > 0) {
        process.stdout.write(`Recent ledger entries (last 10):\n`);
        for (const entry of ledgerTail) {
          process.stdout.write(`  ${entry.id}: ${entry.kind} ${entry.amount} (${entry.reason}) - turn ${entry.turn}, faction ${entry.faction_id}\n`);
        }
        process.stdout.write(`\n`);
      }
    }
  }

  // Write final state if requested
  if (opts.outPath && !opts.json) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, serializeState(state), 'utf8');
    process.stdout.write(`Final state written to ${opts.outPath}\n`);
  }

  // Write report if requested
  if (opts.reportOutPath) {
    const finalReport = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });
    const reportOutput: any = {
      turn: finalReport.nextState.meta.turn,
      negotiation_capital: finalReport.report.negotiation_capital
    };
    await mkdir(dirname(opts.reportOutPath), { recursive: true });
    await writeFile(opts.reportOutPath, JSON.stringify(reportOutput, null, 2), 'utf8');
    process.stdout.write(`Report written to ${opts.reportOutPath}\n`);
  }
}

async function runSpendMode(opts: SpendOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  spendNegotiationCapital(state, opts.faction, opts.amount, opts.reason);

  const outPath = opts.outPath ?? opts.savePath;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeState(state), 'utf8');
  process.stdout.write(`Capital spent: ${opts.amount} for faction ${opts.faction} (reason: ${opts.reason})\n`);
  process.stdout.write(`State written to ${outPath}\n`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'view') {
    await runViewMode(opts);
  } else {
    await runSpendMode(opts);
  }
}

main().catch((err) => {
  console.error('sim:negcap failed', err);
  process.exitCode = 1;
});
