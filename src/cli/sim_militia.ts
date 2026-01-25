import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState, serializeState } from '../state/serialize.js';
import type { MilitiaPoolState, GameState } from '../state/game_state.js';
import { validateMilitiaPools } from '../validate/militia_pools.js';
import { getValidMunicipalityIds } from '../map/municipalities.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliOptions =
  | { savePath: string; cmd: 'list'; json: boolean; outPath: string | null }
  | {
      savePath: string;
      cmd: 'set';
      mun: string;
      faction: string | null;
      available: number;
      committed: number | null;
      exhausted: number | null;
      tags: string[];
      outPath: string | null;
    }
  | {
      savePath: string;
      cmd: 'adjust';
      mun: string;
      availableDelta: number | null;
      committedDelta: number | null;
      exhaustedDelta: number | null;
      outPath: string | null;
    }
  | { savePath: string; cmd: 'clear'; mun: string; outPath: string | null };

type MilitiaPoolsReportFile = {
  schema: 1;
  turn: number;
  pools: Array<MilitiaPoolState>;
};

function ensureMilitiaPools(state: GameState): void {
  if (!state.militia_pools || typeof state.militia_pools !== 'object') {
    state.militia_pools = {};
  }
}

function normalizeTags(tagsInput: string | undefined): string[] {
  if (!tagsInput) return [];
  const parts = tagsInput.split(',');
  const trimmed = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  const unique = Array.from(new Set(trimmed));
  unique.sort();
  return unique;
}

export function buildMilitiaPoolsReport(state: GameState): MilitiaPoolsReportFile {
  ensureMilitiaPools(state);
  const pools = state.militia_pools as Record<string, MilitiaPoolState>;
  const rows = Object.values(pools)
    .filter((p) => p && typeof p === 'object' && typeof p.mun_id === 'string')
    .sort((a, b) => a.mun_id.localeCompare(b.mun_id))
    .map((p) => ({ ...p }));

  return { schema: 1, turn: state.meta.turn, pools: rows };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error('Usage: npm run sim:militia <save.json> <list|set|adjust|clear> ...');
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

  if (cmd === 'set') {
    let mun: string | null = null;
    let faction: string | null = null;
    let factionNull = false;
    let available: number | null = null;
    let committed: number | null = null;
    let exhausted: number | null = null;
    let tags: string | undefined;
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
      if (a === '--faction') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --faction');
        faction = next;
        i += 1;
        continue;
      }
      if (a === '--faction-null') {
        factionNull = true;
        continue;
      }
      if (a === '--available') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --available');
        available = Number.parseInt(next, 10);
        if (!Number.isInteger(available)) throw new Error(`Invalid --available: ${next} (expected integer)`);
        i += 1;
        continue;
      }
      if (a === '--committed') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --committed');
        committed = Number.parseInt(next, 10);
        if (!Number.isInteger(committed)) throw new Error(`Invalid --committed: ${next} (expected integer)`);
        i += 1;
        continue;
      }
      if (a === '--exhausted') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --exhausted');
        exhausted = Number.parseInt(next, 10);
        if (!Number.isInteger(exhausted)) throw new Error(`Invalid --exhausted: ${next} (expected integer)`);
        i += 1;
        continue;
      }
      if (a === '--tags') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --tags');
        tags = next;
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
    if (available === null) throw new Error('Missing required --available <int>');
    if (available < 0) throw new Error('--available must be >= 0');
    if (committed !== null && committed < 0) throw new Error('--committed must be >= 0');
    if (exhausted !== null && exhausted < 0) throw new Error('--exhausted must be >= 0');
    if (factionNull && faction !== null) throw new Error('Cannot specify both --faction and --faction-null');
    
    // Canonicalize faction ID if provided
    let canonicalFaction: string | null = null;
    if (!factionNull && faction !== null) {
      canonicalFaction = canonicalizePoliticalSideId(faction);
      if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
        throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
      }
    }

    return {
      savePath,
      cmd: 'set',
      mun,
      faction: canonicalFaction,
      available,
      committed,
      exhausted,
      tags: normalizeTags(tags),
      outPath
    };
  }

  if (cmd === 'adjust') {
    let mun: string | null = null;
    let availableDelta: number | null = null;
    let committedDelta: number | null = null;
    let exhaustedDelta: number | null = null;
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
      if (a === '--available-delta') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --available-delta');
        availableDelta = Number.parseInt(next, 10);
        if (!Number.isInteger(availableDelta)) throw new Error(`Invalid --available-delta: ${next} (expected integer)`);
        i += 1;
        continue;
      }
      if (a === '--committed-delta') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --committed-delta');
        committedDelta = Number.parseInt(next, 10);
        if (!Number.isInteger(committedDelta)) throw new Error(`Invalid --committed-delta: ${next} (expected integer)`);
        i += 1;
        continue;
      }
      if (a === '--exhausted-delta') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --exhausted-delta');
        exhaustedDelta = Number.parseInt(next, 10);
        if (!Number.isInteger(exhaustedDelta)) throw new Error(`Invalid --exhausted-delta: ${next} (expected integer)`);
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
    if (availableDelta === null && committedDelta === null && exhaustedDelta === null) {
      throw new Error('At least one delta flag required: --available-delta, --committed-delta, or --exhausted-delta');
    }

    return { savePath, cmd: 'adjust', mun, availableDelta, committedDelta, exhaustedDelta, outPath };
  }

  if (cmd === 'clear') {
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
    return { savePath, cmd: 'clear', mun, outPath };
  }

  throw new Error(`Unknown subcommand: ${cmd} (expected list|set|adjust|clear)`);
}

function printList(report: MilitiaPoolsReportFile): void {
  process.stdout.write(`militia pools for turn ${report.turn}\n`);
  if (report.pools.length === 0) {
    process.stdout.write('  (none)\n');
    return;
  }
  for (const p of report.pools) {
    const factionStr = p.faction !== null ? p.faction : 'null';
    const tagsStr = p.tags && p.tags.length > 0 ? ` tags=[${p.tags.join(',')}]` : '';
    process.stdout.write(
      `  - ${p.mun_id} faction=${factionStr} available=${p.available} committed=${p.committed} exhausted=${p.exhausted} updated_turn=${p.updated_turn}${tagsStr}\n`
    );
  }
}

async function validateAndSave(state: GameState, outPath: string): Promise<void> {
  const validMunicipalityIds = await getValidMunicipalityIds();
  const issues = validateMilitiaPools(state, validMunicipalityIds);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const details = errors.map((i) => `${i.code}${i.path ? ` @ ${i.path}` : ''}: ${i.message}`).join('; ');
    throw new Error(`Militia pool validation failed: ${details}`);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeState(state), 'utf8');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);
  ensureMilitiaPools(state);

  if (opts.cmd === 'list') {
    const report = buildMilitiaPoolsReport(state);
    printList(report);
    if (opts.json) {
      const outPath = opts.outPath ?? resolve('data', 'derived', 'militia_pools_report.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      process.stdout.write(`  wrote: ${outPath}\n`);
    }
    return;
  }

  if (opts.cmd === 'set') {
    const existing = state.militia_pools[opts.mun];
    const pool: MilitiaPoolState = {
      mun_id: opts.mun,
      faction: opts.faction,
      available: opts.available,
      committed: opts.committed ?? (existing?.committed ?? 0),
      exhausted: opts.exhausted ?? (existing?.exhausted ?? 0),
      updated_turn: state.meta.turn,
      ...(opts.tags.length > 0 ? { tags: opts.tags } : {})
    };

    state.militia_pools[opts.mun] = pool;

    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    const factionStr = opts.faction !== null ? opts.faction : 'null';
    process.stdout.write(
      `set militia pool ${opts.mun} faction=${factionStr} available=${opts.available} committed=${pool.committed} exhausted=${pool.exhausted} -> ${out}\n`
    );
    return;
  }

  if (opts.cmd === 'adjust') {
    const existing = state.militia_pools[opts.mun];
    if (!existing) {
      throw new Error(`Militia pool not found for municipality: ${opts.mun}`);
    }

    let newAvailable = existing.available + (opts.availableDelta ?? 0);
    let newCommitted = existing.committed + (opts.committedDelta ?? 0);
    let newExhausted = existing.exhausted + (opts.exhaustedDelta ?? 0);

    if (newAvailable < 0) throw new Error(`Adjustment would make available negative: ${newAvailable}`);
    if (newCommitted < 0) throw new Error(`Adjustment would make committed negative: ${newCommitted}`);
    if (newExhausted < 0) throw new Error(`Adjustment would make exhausted negative: ${newExhausted}`);

    const pool: MilitiaPoolState = {
      ...existing,
      available: newAvailable,
      committed: newCommitted,
      exhausted: newExhausted,
      updated_turn: state.meta.turn
    };

    state.militia_pools[opts.mun] = pool;

    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    process.stdout.write(
      `adjusted militia pool ${opts.mun} available=${newAvailable} committed=${newCommitted} exhausted=${newExhausted} -> ${out}\n`
    );
    return;
  }

  if (opts.cmd === 'clear') {
    const existing = state.militia_pools[opts.mun];
    if (!existing) {
      throw new Error(`Militia pool not found for municipality: ${opts.mun}`);
    }

    delete state.militia_pools[opts.mun];

    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    process.stdout.write(`cleared militia pool ${opts.mun} -> ${out}\n`);
    return;
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:militia failed', err);
    process.exitCode = 1;
  });
}
