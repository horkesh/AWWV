/**
 * Phase 14/15: CLI inspector for institutional competences
 * 
 * Usage: npm run sim:competences catalog [--json] [--out <path>]
 *        npm run sim:competences treaty <treaty_draft.json> [--json] [--out <path>]
 *        npm run sim:competences endstate <save.json> [--json] [--out <path>]
 *        npm run sim:competences valuations [--json] [--out <path>] (Phase 15)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState } from '../state/serialize.js';
import type { GameState } from '../state/game_state.js';
import { ALL_COMPETENCES } from '../state/competences.js';
import type { TreatyDraft } from '../state/treaty.js';
import { COMPETENCE_VALUATIONS } from '../state/competence_valuations.js';
import { POLITICAL_SIDES } from '../state/identity.js';
// Import validator to trigger validation at module load time (fatal if incomplete)
import '../validate/competence_valuations.js';

type Command = 'catalog' | 'treaty' | 'endstate' | 'valuations';

interface CatalogOptions {
  command: 'catalog';
  json: boolean;
  outPath: string | null;
}

interface TreatyOptions {
  command: 'treaty';
  treatyPath: string;
  json: boolean;
  outPath: string | null;
}

interface EndStateOptions {
  command: 'endstate';
  savePath: string;
  json: boolean;
  outPath: string | null;
}

interface ValuationsOptions {
  command: 'valuations';
  json: boolean;
  outPath: string | null;
}

type CliOptions = CatalogOptions | TreatyOptions | EndStateOptions | ValuationsOptions;

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
    throw new Error('Usage: npm run sim:competences <catalog|treaty|endstate|valuations> [args...]');
  }

  const command = positional[0] as Command;
  if (command !== 'catalog' && command !== 'treaty' && command !== 'endstate' && command !== 'valuations') {
    throw new Error(`Unknown command: ${command} (expected catalog, treaty, endstate, or valuations)`);
  }

  if (command === 'catalog') {
    return { command, json, outPath };
  }

  if (command === 'treaty') {
    if (positional.length < 2) {
      throw new Error('Usage: npm run sim:competences treaty <treaty_draft.json> [--json] [--out <path>]');
    }
    return { command, treatyPath: resolve(positional[1]), json, outPath };
  }

  if (command === 'endstate') {
    if (positional.length < 2) {
      throw new Error('Usage: npm run sim:competences endstate <save.json> [--json] [--out <path>]');
    }
    return { command, savePath: resolve(positional[1]), json, outPath };
  }

  if (command === 'valuations') {
    return { command, json, outPath };
  }

  throw new Error('Unreachable');
}

function formatCatalog(): string {
  const lines: string[] = [];
  lines.push('Competence Catalog (sorted by id ascending):');
  lines.push('');
  for (const comp of ALL_COMPETENCES) {
    lines.push(`  ${comp}`);
  }
  return lines.join('\n');
}

function formatCatalogJson(): object {
  return {
    schema: 1,
    competences: ALL_COMPETENCES
  };
}

function formatTreaty(treatyDraft: TreatyDraft): string {
  const lines: string[] = [];
  lines.push(`Treaty: ${treatyDraft.treaty_id}`);
  lines.push(`Turn: ${treatyDraft.turn}`);
  lines.push('');

  const competenceClauses = treatyDraft.clauses.filter((c) => c.kind === 'allocate_competence');
  
  if (competenceClauses.length === 0) {
    lines.push('No competence allocations in this treaty.');
    return lines.join('\n');
  }

  lines.push('Competence Allocations (sorted by competence_id, then holder_id):');
  lines.push('');

  // Sort allocations by competence_id asc, then holder_id asc
  const allocations = competenceClauses
    .map((c) => ({ competence: c.competence || '', holder: c.holder || '' }))
    .filter((a) => a.competence && a.holder)
    .sort((a, b) => {
      const compCmp = a.competence.localeCompare(b.competence);
      if (compCmp !== 0) return compCmp;
      return a.holder.localeCompare(b.holder);
    });

  for (const alloc of allocations) {
    lines.push(`  ${alloc.competence} -> ${alloc.holder}`);
  }

  return lines.join('\n');
}

function formatTreatyJson(treatyDraft: TreatyDraft): object {
  const competenceClauses = treatyDraft.clauses.filter((c) => c.kind === 'allocate_competence');
  
  const allocations = competenceClauses
    .map((c) => ({ competence: c.competence || '', holder: c.holder || '' }))
    .filter((a) => a.competence && a.holder)
    .sort((a, b) => {
      const compCmp = a.competence.localeCompare(b.competence);
      if (compCmp !== 0) return compCmp;
      return a.holder.localeCompare(b.holder);
    });

  return {
    schema: 1,
    treaty_id: treatyDraft.treaty_id,
    turn: treatyDraft.turn,
    allocations
  };
}

function formatEndState(state: GameState): string {
  const endState = state.end_state;
  
  if (!endState) {
    return 'No end_state (war active).';
  }

  const lines: string[] = [];
  lines.push(`End State: ${endState.kind}`);
  lines.push(`Treaty ID: ${endState.treaty_id}`);
  lines.push(`Since Turn: ${endState.since_turn}`);
  lines.push('');

  if (!endState.snapshot || !endState.snapshot.competences || endState.snapshot.competences.length === 0) {
    lines.push('No competence allocations in end_state snapshot.');
    return lines.join('\n');
  }

  lines.push('Competence Allocations (sorted by competence_id):');
  lines.push('');

  // Competences are already sorted by competence_id in snapshot
  for (const comp of endState.snapshot.competences) {
    lines.push(`  ${comp.competence} -> ${comp.holder}`);
  }

  return lines.join('\n');
}

function formatEndStateJson(state: GameState): object {
  const endState = state.end_state;
  
  if (!endState) {
    return { status: 'war', competences: null };
  }

  const result: any = {
    status: 'peace',
    kind: endState.kind,
    treaty_id: endState.treaty_id,
    since_turn: endState.since_turn
  };

  if (endState.snapshot && endState.snapshot.competences && endState.snapshot.competences.length > 0) {
    result.competences = endState.snapshot.competences;
  } else {
    result.competences = null;
  }

  return result;
}

function formatValuations(): string {
  const lines: string[] = [];
  lines.push('Competence Valuations (sorted by faction_id, then competence_id):');
  lines.push('');

  // Sort factions deterministically
  const sortedFactions = [...POLITICAL_SIDES].sort();

  for (const factionId of sortedFactions) {
    lines.push(`${factionId}:`);
    const factionVals = COMPETENCE_VALUATIONS[factionId];
    if (!factionVals) {
      lines.push('  (missing valuation table)');
      continue;
    }

    // Sort competences deterministically
    const sortedCompetences = [...ALL_COMPETENCES].sort();

    for (const competenceId of sortedCompetences) {
      const value = factionVals[competenceId];
      if (value === undefined) {
        lines.push(`  ${competenceId}: (missing)`);
      } else {
        lines.push(`  ${competenceId}: ${value}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatValuationsJson(): object {
  const result: Record<string, Record<string, number>> = {};

  // Sort factions deterministically
  const sortedFactions = [...POLITICAL_SIDES].sort();

  for (const factionId of sortedFactions) {
    const factionVals = COMPETENCE_VALUATIONS[factionId];
    if (!factionVals) {
      result[factionId] = {};
      continue;
    }

    const competenceVals: Record<string, number> = {};
    // Sort competences deterministically
    const sortedCompetences = [...ALL_COMPETENCES].sort();

    for (const competenceId of sortedCompetences) {
      const value = factionVals[competenceId];
      if (value !== undefined) {
        competenceVals[competenceId] = value;
      }
    }

    result[factionId] = competenceVals;
  }

  return {
    schema: 1,
    valuations: result
  };
}

async function runCatalogMode(opts: CatalogOptions): Promise<void> {
  if (opts.json) {
    const output = formatCatalogJson();
    const jsonText = JSON.stringify(output, null, 2);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, jsonText, 'utf8');
      process.stdout.write(`Competence catalog written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
  } else {
    const output = formatCatalog();
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`Competence catalog written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

async function runTreatyMode(opts: TreatyOptions): Promise<void> {
  const payload = await readFile(opts.treatyPath, 'utf8');
  const treatyDraft: TreatyDraft = JSON.parse(payload);

  if (opts.json) {
    const output = formatTreatyJson(treatyDraft);
    const jsonText = JSON.stringify(output, null, 2);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, jsonText, 'utf8');
      process.stdout.write(`Treaty competence allocations written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
  } else {
    const output = formatTreaty(treatyDraft);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`Treaty competence allocations written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

async function runEndStateMode(opts: EndStateOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  if (opts.json) {
    const output = formatEndStateJson(state);
    const jsonText = JSON.stringify(output, null, 2);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, jsonText, 'utf8');
      process.stdout.write(`End state competences written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
  } else {
    const output = formatEndState(state);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`End state competences written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

async function runValuationsMode(opts: ValuationsOptions): Promise<void> {
  if (opts.json) {
    const output = formatValuationsJson();
    const jsonText = JSON.stringify(output, null, 2);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, jsonText, 'utf8');
      process.stdout.write(`Competence valuations written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
  } else {
    const output = formatValuations();
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`Competence valuations written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === 'catalog') {
    await runCatalogMode(opts);
  } else if (opts.command === 'treaty') {
    await runTreatyMode(opts);
  } else if (opts.command === 'endstate') {
    await runEndStateMode(opts);
  } else if (opts.command === 'valuations') {
    await runValuationsMode(opts);
  }
}

// Only run the CLI when invoked directly
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:competences failed', err);
    process.exitCode = 1;
  });
}
