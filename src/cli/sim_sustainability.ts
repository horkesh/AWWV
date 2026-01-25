import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState, serializeState } from '../state/serialize.js';
import type { SustainabilityState, GameState } from '../state/game_state.js';

type CliOptions =
  | { savePath: string; cmd: 'list'; json: boolean; outPath: string | null }
  | { savePath: string; cmd: 'inspect'; mun: string; outPath: string | null };

type SustainabilityReportFile = {
  schema: 1;
  turn: number;
  sustainability: Array<SustainabilityState>;
};

function ensureSustainabilityState(state: GameState): void {
  if (!state.sustainability_state || typeof state.sustainability_state !== 'object') {
    state.sustainability_state = {};
  }
}

export function buildSustainabilityReport(state: GameState): SustainabilityReportFile {
  ensureSustainabilityState(state);
  const sustainability = state.sustainability_state as Record<string, SustainabilityState>;
  const rows = Object.values(sustainability)
    .filter((s) => s && typeof s === 'object' && typeof s.mun_id === 'string')
    .sort((a, b) => a.mun_id.localeCompare(b.mun_id))
    .map((s) => ({ ...s }));

  return { schema: 1, turn: state.meta.turn, sustainability: rows };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error('Usage: npm run sim:sustainability <save.json> <list|inspect> ...');
  }

  const savePath = resolve(argv[0]);
  const cmd = argv[1];
  const rest = argv.slice(2);

  if (cmd === 'list') {
    let json = false;
    let outPath: string | null = null;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--out') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --out');
        outPath = resolve(next);
        i += 1;
        continue;
      }
      if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
      throw new Error(`Unexpected arg: ${a}`);
    }
    return { savePath, cmd: 'list', json, outPath };
  }

  if (cmd === 'inspect') {
    let mun: string | null = null;
    let outPath: string | null = null;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--mun') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --mun');
        mun = next;
        i += 1;
        continue;
      }
      if (a === '--out') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --out');
        outPath = resolve(next);
        i += 1;
        continue;
      }
      if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
      throw new Error(`Unexpected arg: ${a}`);
    }

    if (!mun) throw new Error('Missing required --mun <mun_id>');
    return { savePath, cmd: 'inspect', mun, outPath };
  }

  throw new Error(`Unknown subcommand: ${cmd} (expected list|inspect)`);
}

function printList(report: SustainabilityReportFile): void {
  process.stdout.write(`sustainability state for turn ${report.turn}\n`);
  if (report.sustainability.length === 0) {
    process.stdout.write('  (none)\n');
    return;
  }
  for (const s of report.sustainability) {
    const status = s.collapsed ? 'COLLAPSED' : s.sustainability_score < 50 ? 'DEGRADED' : 'OK';
    process.stdout.write(
      `  - ${s.mun_id} score=${s.sustainability_score} ` +
        `surrounded=${s.is_surrounded} unsupplied_turns=${s.unsupplied_turns} ` +
        `collapsed=${s.collapsed} status=${status} last_updated_turn=${s.last_updated_turn}\n`
    );
  }
}

function printInspect(state: GameState, munId: string): void {
  ensureSustainabilityState(state);
  const sustainability = state.sustainability_state as Record<string, SustainabilityState>;
  const sust = sustainability[munId];

  if (!sust) {
    process.stdout.write(`No sustainability state found for municipality: ${munId}\n`);
    return;
  }

  const status = sust.collapsed ? 'COLLAPSED' : sust.sustainability_score < 50 ? 'DEGRADED' : 'OK';

  process.stdout.write(`Sustainability state for ${munId} (turn ${state.meta.turn}):\n`);
  process.stdout.write(`  Sustainability score: ${sust.sustainability_score}/100\n`);
  process.stdout.write(`  Is surrounded: ${sust.is_surrounded}\n`);
  process.stdout.write(`  Unsupplied turns: ${sust.unsupplied_turns}\n`);
  process.stdout.write(`  Collapsed: ${sust.collapsed}\n`);
  process.stdout.write(`  Authority degraded: ${sust.sustainability_score < 50}\n`);
  process.stdout.write(`  Status: ${status}\n`);
  process.stdout.write(`  Last updated turn: ${sust.last_updated_turn}\n`);

  // Show militia pool if exists
  const militiaPools = (state as any).militia_pools as Record<string, any> | undefined;
  if (militiaPools && typeof militiaPools === 'object') {
    const pool = militiaPools[munId];
    if (pool && typeof pool === 'object') {
      process.stdout.write(`\nMilitia pool:\n`);
      process.stdout.write(`  Faction: ${pool.faction ?? 'null'}\n`);
      process.stdout.write(`  Available: ${pool.available}\n`);
      process.stdout.write(`  Committed: ${pool.committed}\n`);
    }
  }

  // Show displacement state if exists
  const displacement = state.displacement_state?.[munId];
  if (displacement) {
    process.stdout.write(`\nDisplacement state:\n`);
    process.stdout.write(`  Original population: ${displacement.original_population}\n`);
    process.stdout.write(`  Displaced out: ${displacement.displaced_out}\n`);
    process.stdout.write(`  Lost population: ${displacement.lost_population}\n`);
    const displacementRatio = displacement.original_population > 0
      ? displacement.displaced_out / displacement.original_population
      : 0;
    process.stdout.write(`  Displacement ratio: ${Math.floor(displacementRatio * 100)}%\n`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);
  ensureSustainabilityState(state);

  if (opts.cmd === 'list') {
    const report = buildSustainabilityReport(state);
    printList(report);
    if (opts.json) {
      const outPath = opts.outPath ?? resolve('data', 'derived', 'sustainability_report.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      process.stdout.write(`  wrote: ${outPath}\n`);
    }
    return;
  }

  if (opts.cmd === 'inspect') {
    printInspect(state, opts.mun);
    if (opts.outPath) {
      const report = buildSustainabilityReport(state);
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, JSON.stringify(report, null, 2), 'utf8');
      process.stdout.write(`  wrote: ${opts.outPath}\n`);
    }
    return;
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:sustainability failed', err);
    process.exitCode = 1;
  });
}
