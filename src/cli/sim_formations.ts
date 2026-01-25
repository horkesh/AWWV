import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState, serializeState } from '../state/serialize.js';
import type { FormationState, GameState } from '../state/game_state.js';
import { validateFormations } from '../validate/formations.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliOptions =
  | { savePath: string; cmd: 'list'; json: boolean; outPath: string | null }
  | {
      savePath: string;
      cmd: 'add';
      id: string | null;
      faction: string;
      name: string;
      tags: string[];
      inactive: boolean;
      outPath: string | null;
    }
  | { savePath: string; cmd: 'remove'; id: string; outPath: string | null }
  | { savePath: string; cmd: 'assign'; id: string; region: string | null; edge: string | null; outPath: string | null }
  | { savePath: string; cmd: 'unassign'; id: string; outPath: string | null };

type FormationsReportFile = {
  schema: 1;
  turn: number;
  formations: Array<FormationState>;
};

function ensureFormations(state: GameState): void {
  if (!state.formations || typeof state.formations !== 'object') state.formations = {};
}

function generateDeterministicFormationId(state: GameState, faction: string): string {
  ensureFormations(state);
  const formations = state.formations;
  const factionFormations = Object.values(formations)
    .filter((f) => f && typeof f === 'object' && (f as any).faction === faction)
    .map((f) => (f as any).id)
    .filter((id): id is string => typeof id === 'string');

  // Extract numeric suffix from existing IDs matching F_<FACTION>_<NNNN> pattern
  const pattern = new RegExp(`^F_${faction.replace(/[^A-Za-z0-9]/g, '_')}_(\\d+)$`);
  let maxNum = 0;
  for (const id of factionFormations) {
    const match = id.match(pattern);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum + 1;
  const padded = String(nextNum).padStart(4, '0');
  return `F_${faction}_${padded}`;
}

function normalizeTags(tagsInput: string | undefined): string[] {
  if (!tagsInput) return [];
  const parts = tagsInput.split(',');
  const trimmed = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  const unique = Array.from(new Set(trimmed));
  unique.sort();
  return unique;
}

export function buildFormationsReport(state: GameState): FormationsReportFile {
  ensureFormations(state);
  const formations = state.formations as Record<string, FormationState>;
  const rows = Object.values(formations)
    .filter((f) => f && typeof f === 'object' && typeof f.id === 'string')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({ ...f }));

  return { schema: 1, turn: state.meta.turn, formations: rows };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error('Usage: npm run sim:formations <save.json> <list|add|remove|assign|unassign> ...');
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

  if (cmd === 'add') {
    let id: string | null = null;
    let faction: string | null = null;
    let name: string | null = null;
    let tags: string | undefined;
    let inactive = false;
    let outPath: string | null = null;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--id') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --id');
        id = next;
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
      if (a === '--name') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --name');
        name = next;
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
      if (a === '--inactive') {
        inactive = true;
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

    if (!faction) throw new Error('Missing required --faction <faction_id>');
    if (!name) throw new Error('Missing required --name "<name>"');
    if (id !== null && id.trim().length === 0) throw new Error('Invalid --id: must be non-empty');
    
    // Canonicalize faction ID
    const canonicalFaction = canonicalizePoliticalSideId(faction);
    if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
      throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
    }

    return { savePath, cmd: 'add', id, faction: canonicalFaction, name, tags: normalizeTags(tags), inactive, outPath };
  }

  if (cmd === 'remove') {
    let id: string | null = null;
    let outPath: string | null = null;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--id') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --id');
        id = next;
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

    if (!id) throw new Error('Missing required --id <formation_id>');
    return { savePath, cmd: 'remove', id, outPath };
  }

  if (cmd === 'assign') {
    let id: string | null = null;
    let region: string | null = null;
    let edge: string | null = null;
    let outPath: string | null = null;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--id') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --id');
        id = next;
        i += 1;
        continue;
      }
      if (a === '--region') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --region');
        region = next;
        i += 1;
        continue;
      }
      if (a === '--edge') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --edge');
        edge = next;
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

    if (!id) throw new Error('Missing required --id <formation_id>');
    if (!region && !edge) throw new Error('Missing required --region <region_id> or --edge <edge_id>');
    if (region && edge) throw new Error('Cannot specify both --region and --edge');

    return { savePath, cmd: 'assign', id, region, edge, outPath };
  }

  if (cmd === 'unassign') {
    let id: string | null = null;
    let outPath: string | null = null;

    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--id') {
        const next = rest[i + 1];
        if (next === undefined) throw new Error('Missing value for --id');
        id = next;
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

    if (!id) throw new Error('Missing required --id <formation_id>');
    return { savePath, cmd: 'unassign', id, outPath };
  }

  throw new Error(`Unknown subcommand: ${cmd} (expected list|add|remove|assign|unassign)`);
}

function printList(report: FormationsReportFile): void {
  process.stdout.write(`formations for turn ${report.turn}\n`);
  if (report.formations.length === 0) {
    process.stdout.write('  (none)\n');
    return;
  }
  for (const f of report.formations) {
    const statusStr = f.status === 'active' ? 'active' : 'inactive';
    const assignmentStr = f.assignment
      ? f.assignment.kind === 'region'
        ? `region=${f.assignment.region_id}`
        : `edge=${f.assignment.edge_id}`
      : 'unassigned';
    const tagsStr = f.tags && f.tags.length > 0 ? ` tags=[${f.tags.join(',')}]` : '';
    const forceLabelStr = f.force_label ? ` force_label=${f.force_label}` : '';
    process.stdout.write(
      `  - ${f.faction}${forceLabelStr} ${f.id} name="${f.name}" status=${statusStr} created_turn=${f.created_turn} assignment=${assignmentStr}${tagsStr}\n`
    );
  }
}

async function validateAndSave(state: GameState, outPath: string): Promise<void> {
  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);
  const issues = validateFormations(state, frontRegions, derivedFrontEdges);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const details = errors.map((i) => `${i.code}${i.path ? ` @ ${i.path}` : ''}: ${i.message}`).join('; ');
    throw new Error(`Formation validation failed: ${details}`);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeState(state), 'utf8');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);
  ensureFormations(state);

  if (opts.cmd === 'list') {
    const report = buildFormationsReport(state);
    printList(report);
    if (opts.json) {
      const outPath = opts.outPath ?? resolve('data', 'derived', 'formations_report.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      process.stdout.write(`  wrote: ${outPath}\n`);
    }
    return;
  }

  if (opts.cmd === 'add') {
    const id = opts.id ?? generateDeterministicFormationId(state, opts.faction);
    if (state.formations[id]) throw new Error(`Formation already exists: ${id}`);

    const formation: FormationState = {
      id,
      faction: opts.faction,
      name: opts.name.trim(),
      created_turn: state.meta.turn,
      status: opts.inactive ? 'inactive' : 'active',
      assignment: null,
      ...(opts.tags.length > 0 ? { tags: opts.tags } : {})
    };

    state.formations[id] = formation;

    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    process.stdout.write(`added formation ${id} faction=${opts.faction} name="${opts.name}" -> ${out}\n`);
    return;
  }

  if (opts.cmd === 'remove') {
    const f = state.formations[opts.id];
    if (!f) throw new Error(`Formation not found: ${opts.id}`);
    delete state.formations[opts.id];
    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    process.stdout.write(`removed formation ${opts.id} -> ${out}\n`);
    return;
  }

  if (opts.cmd === 'assign') {
    const f = state.formations[opts.id];
    if (!f) throw new Error(`Formation not found: ${opts.id}`);
    if (opts.region) {
      f.assignment = { kind: 'region', region_id: opts.region };
    } else if (opts.edge) {
      f.assignment = { kind: 'edge', edge_id: opts.edge };
    }
    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    const target = opts.region ? `region=${opts.region}` : `edge=${opts.edge}`;
    process.stdout.write(`assigned formation ${opts.id} -> ${target} -> ${out}\n`);
    return;
  }

  if (opts.cmd === 'unassign') {
    const f = state.formations[opts.id];
    if (!f) throw new Error(`Formation not found: ${opts.id}`);
    f.assignment = null;
    const out = opts.outPath ?? opts.savePath;
    await validateAndSave(state, out);
    process.stdout.write(`unassigned formation ${opts.id} -> ${out}\n`);
    return;
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:formations failed', err);
    process.exitCode = 1;
  });
}
