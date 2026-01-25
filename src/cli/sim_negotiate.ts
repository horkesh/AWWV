import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { deserializeState, serializeState } from '../state/serialize.js';
import { runTurn } from '../sim/turn_pipeline.js';
import { applyEnforcementPackage, type EnforcementPackage } from '../state/negotiation_offers.js';
import type { GameState } from '../state/game_state.js';

type Command = 'propose' | 'apply';

function parseArgs(argv: string[]): {
  command: Command;
  savePath: string;
  offerId?: string;
  outPath?: string;
  reportOutPath?: string;
  json: boolean;
} {
  let command: Command | null = null;
  let savePath: string | null = null;
  let offerId: string | null = null;
  let outPath: string | null = null;
  let reportOutPath: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'propose' || arg === 'apply') {
      if (command !== null) throw new Error(`Duplicate command: ${arg}`);
      command = arg;
      continue;
    }
    if (arg === '--offer-id') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --offer-id');
      offerId = next;
      i += 1;
      continue;
    }
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

  if (command === null) {
    throw new Error('Usage: npm run sim:negotiate <propose|apply> <save.json> [--offer-id <id>] [--out <path>] [--report-out <path>] [--json]');
  }
  if (savePath === null) {
    throw new Error('Missing save file path');
  }
  if (command === 'apply' && !offerId) {
    throw new Error('--offer-id required for apply command');
  }

  return {
    command,
    savePath,
    offerId: offerId !== null ? offerId : undefined,
    outPath: outPath !== null ? outPath : undefined,
    reportOutPath: reportOutPath !== null ? reportOutPath : undefined,
    json
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();

  if (opts.command === 'propose') {
    // Run one turn compute-only to generate offers + acceptance report
    const { report } = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });

    const offerReport = report.negotiation_offer;
    const acceptanceReport = report.negotiation_acceptance;

    if (opts.json || opts.reportOutPath) {
      const reportData = {
        schema: 1,
        turn: state.meta.turn + 1,
        offer: offerReport,
        acceptance: acceptanceReport
      };
      const reportPath = opts.reportOutPath ?? resolve('data', 'derived', 'negotiation_offer_report.json');
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
      process.stdout.write(`Negotiation offer report written to ${reportPath}\n`);
    } else {
      // Human-readable output
      process.stdout.write(`Negotiation Offer Report (Turn ${state.meta.turn + 1})\n`);
      process.stdout.write(`\n`);
      if (offerReport?.offer) {
        process.stdout.write(`Offer Generated: ${offerReport.offer.id}\n`);
        process.stdout.write(`  Kind: ${offerReport.offer.kind}\n`);
        process.stdout.write(`  Scope: ${JSON.stringify(offerReport.offer.scope)}\n`);
        process.stdout.write(`  Freeze Edges: ${offerReport.offer.terms.freeze_edges.length}\n`);
        process.stdout.write(`  Duration: ${offerReport.offer.terms.duration_turns}\n`);
        process.stdout.write(`\n`);
        if (acceptanceReport) {
          process.stdout.write(`Acceptance: ${acceptanceReport.accepted ? 'ACCEPTED' : 'REJECTED'}\n`);
          if (acceptanceReport.reasons.length > 0) {
            process.stdout.write(`  Reasons:\n`);
            for (const reason of acceptanceReport.reasons) {
              process.stdout.write(`    - ${reason}\n`);
            }
          }
        }
      } else {
        process.stdout.write(`No offer generated\n`);
        if (offerReport?.scoring_inputs) {
          process.stdout.write(`  Max Pressure: ${offerReport.scoring_inputs.max_pressure}\n`);
        }
      }
    }
  } else if (opts.command === 'apply') {
    // Apply enforcement package if offer exists and is accepted
    const { report } = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });

    const offerReport = report.negotiation_offer;
    const acceptanceReport = report.negotiation_acceptance;

    if (!offerReport?.offer) {
      throw new Error('No offer generated for this turn');
    }

    if (offerReport.offer.id !== opts.offerId) {
      throw new Error(`Offer ID mismatch: expected ${opts.offerId}, got ${offerReport.offer.id}`);
    }

    if (!acceptanceReport?.accepted || !acceptanceReport.enforcement_package) {
      throw new Error(`Offer ${opts.offerId} was not accepted. Reasons: ${acceptanceReport?.reasons.join(', ') ?? 'unknown'}`);
    }

    // Apply the enforcement package
    const workingState = deserializeState(payload); // Fresh copy
    applyEnforcementPackage(workingState, acceptanceReport.enforcement_package);

    // Write updated state
    const outPath = opts.outPath ?? opts.savePath;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, serializeState(workingState), 'utf8');
    process.stdout.write(`Applied enforcement package for offer ${opts.offerId}\n`);
    process.stdout.write(`  Freeze edges: ${acceptanceReport.enforcement_package.freeze_edges.length}\n`);
    process.stdout.write(`  Duration: ${acceptanceReport.enforcement_package.duration_turns}\n`);
    process.stdout.write(`  Updated save: ${outPath}\n`);

    if (opts.reportOutPath) {
      const reportData = {
        schema: 1,
        turn: workingState.meta.turn,
        offer_id: opts.offerId,
        applied: true,
        enforcement_package: acceptanceReport.enforcement_package
      };
      await mkdir(dirname(opts.reportOutPath), { recursive: true });
      await writeFile(opts.reportOutPath, JSON.stringify(reportData, null, 2), 'utf8');
      process.stdout.write(`  Report: ${opts.reportOutPath}\n`);
    }
  }
}

main().catch((err) => {
  console.error('sim:negotiate failed', err);
  process.exitCode = 1;
});
