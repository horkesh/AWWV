/**
 * Phase 12D.0: CLI inspector for end_state
 * 
 * Usage: npm run sim:endstate <save.json> [--json] [--out <path>]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState } from '../state/serialize.js';
import type { GameState } from '../state/game_state.js';

function parseArgs(argv: string[]): { savePath: string; json: boolean; outPath: string | null } {
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
    throw new Error('Usage: npm run sim:endstate <save.json> [--json] [--out <path>]');
  }

  return {
    savePath: resolve(positional[0]),
    json,
    outPath
  };
}

function formatEndState(state: GameState): string {
  const endState = state.end_state;
  
  if (!endState) {
    return 'war';
  }

  const parts: string[] = [];
  parts.push(`kind: ${endState.kind}`);
  parts.push(`treaty_id: ${endState.treaty_id}`);
  parts.push(`since_turn: ${endState.since_turn}`);
  if (endState.note) {
    parts.push(`note: ${endState.note}`);
  }
  
  // Phase 12D.1: Add snapshot info if present
  if (endState.snapshot) {
    parts.push(`outcome_hash: ${endState.snapshot.outcome_hash}`);
    parts.push('settlements_by_controller:');
    for (const [controller, count] of endState.snapshot.settlements_by_controller) {
      parts.push(`  ${controller}: ${count}`);
    }
    
    // Phase 13A.0: Add competences if present
    if (endState.snapshot.competences && endState.snapshot.competences.length > 0) {
      parts.push('competences:');
      for (const comp of endState.snapshot.competences) {
        parts.push(`  ${comp.competence}: ${comp.holder}`);
      }
    }
  }

  return parts.join('\n');
}

function formatEndStateJson(state: GameState): object {
  const endState = state.end_state;
  
  if (!endState) {
    return { status: 'war' };
  }

  const result: any = {
    status: 'peace',
    kind: endState.kind,
    treaty_id: endState.treaty_id,
    since_turn: endState.since_turn
  };

  if (endState.note) {
    result.note = endState.note;
  }
  
  // Phase 12D.1: Include snapshot if present
  // Phase 13A.0: Include competences in snapshot
  if (endState.snapshot) {
    result.outcome_hash = endState.snapshot.outcome_hash;
    result.settlements_by_controller = Object.fromEntries(endState.snapshot.settlements_by_controller);
    if (endState.snapshot.competences && endState.snapshot.competences.length > 0) {
      result.competences = endState.snapshot.competences;
    }
    result.snapshot = endState.snapshot;
  }

  return result;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  if (opts.json) {
    const output = formatEndStateJson(state);
    const jsonText = JSON.stringify(output, null, 2);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, jsonText, 'utf8');
      process.stdout.write(`End state written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
  } else {
    const output = formatEndState(state);
    
    if (opts.outPath) {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, output, 'utf8');
      process.stdout.write(`End state written to: ${opts.outPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

// Only run the CLI when invoked directly
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:endstate failed', err);
    process.exitCode = 1;
  });
}
