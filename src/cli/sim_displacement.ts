import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState, serializeState } from '../state/serialize.js';
import type { DisplacementState, GameState } from '../state/game_state.js';
import { getValidMunicipalityIds } from '../map/municipalities.js';

type CliOptions =
  | { savePath: string; cmd: 'list'; json: boolean; outPath: string | null }
  | { savePath: string; cmd: 'inspect'; mun: string; outPath: string | null };

type DisplacementReportFile = {
  schema: 1;
  turn: number;
  displacements: Array<DisplacementState>;
};

function ensureDisplacementState(state: GameState): void {
  if (!state.displacement_state || typeof state.displacement_state !== 'object') {
    state.displacement_state = {};
  }
}

export function buildDisplacementReport(state: GameState): DisplacementReportFile {
  ensureDisplacementState(state);
  const displacements = state.displacement_state as Record<string, DisplacementState>;
  const rows = Object.values(displacements)
    .filter((d) => d && typeof d === 'object' && typeof d.mun_id === 'string')
    .sort((a, b) => a.mun_id.localeCompare(b.mun_id))
    .map((d) => ({ ...d }));

  return { schema: 1, turn: state.meta.turn, displacements: rows };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error('Usage: npm run sim:displacement <save.json> <list|inspect> ...');
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

function printList(report: DisplacementReportFile): void {
  process.stdout.write(`displacement state for turn ${report.turn}\n`);
  if (report.displacements.length === 0) {
    process.stdout.write('  (none)\n');
    return;
  }
  for (const d of report.displacements) {
    const remaining = d.original_population - d.displaced_out - d.lost_population;
    const effectiveCapacity = remaining;
    process.stdout.write(
      `  - ${d.mun_id} original=${d.original_population} ` +
        `displaced_out=${d.displaced_out} displaced_in=${d.displaced_in} ` +
        `lost=${d.lost_population} remaining=${remaining} ` +
        `effective_capacity=${effectiveCapacity} last_updated_turn=${d.last_updated_turn}\n`
    );
  }
}

function printInspect(state: GameState, munId: string): void {
  ensureDisplacementState(state);
  const displacements = state.displacement_state as Record<string, DisplacementState>;
  const disp = displacements[munId];

  if (!disp) {
    process.stdout.write(`No displacement state found for municipality: ${munId}\n`);
    return;
  }

  const remaining = disp.original_population - disp.displaced_out - disp.lost_population;
  const effectiveCapacity = remaining;

  process.stdout.write(`Displacement state for ${munId} (turn ${state.meta.turn}):\n`);
  process.stdout.write(`  Original population: ${disp.original_population}\n`);
  process.stdout.write(`  Displaced out: ${disp.displaced_out}\n`);
  process.stdout.write(`  Displaced in: ${disp.displaced_in}\n`);
  process.stdout.write(`  Lost population: ${disp.lost_population}\n`);
  process.stdout.write(`  Remaining population: ${remaining}\n`);
  process.stdout.write(`  Effective recruitment capacity: ${effectiveCapacity}\n`);
  process.stdout.write(`  Last updated turn: ${disp.last_updated_turn}\n`);

  // Show militia pool if exists
  const militiaPools = (state as any).militia_pools as Record<string, any> | undefined;
  if (militiaPools && typeof militiaPools === 'object') {
    const pool = militiaPools[munId];
    if (pool && typeof pool === 'object') {
      process.stdout.write(`\nMilitia pool:\n`);
      process.stdout.write(`  Faction: ${pool.faction ?? 'null'}\n`);
      process.stdout.write(`  Available: ${pool.available}\n`);
      process.stdout.write(`  Committed: ${pool.committed}\n`);
      process.stdout.write(`  Total: ${pool.available + pool.committed}\n`);
      process.stdout.write(`  Ceiling: ${effectiveCapacity}\n`);
      if (pool.available + pool.committed > effectiveCapacity) {
        process.stdout.write(`  ⚠️  WARNING: Pool exceeds ceiling by ${pool.available + pool.committed - effectiveCapacity}\n`);
      }
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);
  ensureDisplacementState(state);

  if (opts.cmd === 'list') {
    const report = buildDisplacementReport(state);
    printList(report);
    if (opts.json) {
      const outPath = opts.outPath ?? resolve('data', 'derived', 'displacement_report.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      process.stdout.write(`  wrote: ${outPath}\n`);
    }
    return;
  }

  if (opts.cmd === 'inspect') {
    printInspect(state, opts.mun);
    if (opts.outPath) {
      const report = buildDisplacementReport(state);
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
    console.error('sim:displacement failed', err);
    process.exitCode = 1;
  });
}
