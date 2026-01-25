import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState, serializeState } from '../state/serialize.js';
import { PostureLevel } from '../state/game_state.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliOptions = {
  savePath: string;
  outPath: string | null;
  faction: string;
  edge: string;
  posture: PostureLevel;
  weight: number;
};

function parsePosture(value: string): PostureLevel {
  if (value === 'hold' || value === 'probe' || value === 'push') return value;
  throw new Error(`Invalid --posture: ${value} (expected hold|probe|push)`);
}

function validateEdgeId(edge: string): void {
  if (typeof edge !== 'string' || !edge.includes('__')) throw new Error(`Invalid --edge: ${edge} (expected a__b)`);
  const parts = edge.split('__');
  if (parts.length !== 2) throw new Error(`Invalid --edge: ${edge} (expected a__b)`);
  const [a, b] = parts;
  if (!a || !b) throw new Error(`Invalid --edge: ${edge} (expected a__b)`);
  if (!(a < b)) throw new Error(`Invalid --edge: ${edge} (expected canonical a__b with a < b)`);
}

function parseArgs(argv: string[]): CliOptions {
  const defaultSavePath = resolve('saves', 'save_0001.json');

  let savePath = defaultSavePath;
  let outPath: string | null = null;
  let faction: string | null = null;
  let edge: string | null = null;
  let posture: PostureLevel | null = null;
  let weight: number | null = null;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--faction') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --faction');
      faction = next;
      i += 1;
      continue;
    }
    if (arg === '--edge') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --edge');
      edge = next;
      i += 1;
      continue;
    }
    if (arg === '--posture') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --posture');
      posture = parsePosture(next);
      i += 1;
      continue;
    }
    if (arg === '--weight') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --weight');
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n)) throw new Error(`Invalid --weight: ${next}`);
      weight = n;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length >= 1) savePath = resolve(positional[0]);
  if (!faction) throw new Error('Missing required --faction <id>');
  if (!edge) throw new Error('Missing required --edge <edge_id>');
  if (!posture) throw new Error('Missing required --posture <hold|probe|push>');
  if (weight === null) throw new Error('Missing required --weight <int>');

  validateEdgeId(edge);
  
  // Canonicalize faction ID
  const canonicalFaction = canonicalizePoliticalSideId(faction);
  if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
    throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
  }

  return { savePath, outPath, faction: canonicalFaction, edge, posture, weight };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  if (!state.front_posture || typeof state.front_posture !== 'object') state.front_posture = {};
  if (!state.front_posture[opts.faction]) state.front_posture[opts.faction] = { assignments: {} };
  if (!state.front_posture[opts.faction].assignments) state.front_posture[opts.faction].assignments = {};

  state.front_posture[opts.faction].assignments[opts.edge] = {
    edge_id: opts.edge,
    posture: opts.posture,
    weight: opts.weight
  };

  const out = opts.outPath ?? opts.savePath;
  await writeFile(out, serializeState(state), 'utf8');
  process.stdout.write(
    `set posture: faction=${opts.faction} edge=${opts.edge} posture=${opts.posture} weight=${opts.weight} -> ${out}\n`
  );
}

main().catch((err) => {
  console.error('sim:setposture failed', err);
  process.exitCode = 1;
});

