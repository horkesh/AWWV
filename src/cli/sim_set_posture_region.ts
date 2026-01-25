import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState, serializeState } from '../state/serialize.js';
import { PostureLevel } from '../state/game_state.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliOptions = {
  savePath: string;
  outPath: string | null;
  faction: string;
  region: string;
  posture: PostureLevel;
  weight: number;
};

function parsePosture(value: string): PostureLevel {
  if (value === 'hold' || value === 'probe' || value === 'push') return value;
  throw new Error(`Invalid --posture: ${value} (expected hold|probe|push)`);
}

function parseArgs(argv: string[]): CliOptions {
  const defaultSavePath = resolve('saves', 'save_0001.json');

  let savePath = defaultSavePath;
  let outPath: string | null = null;
  let faction: string | null = null;
  let region: string | null = null;
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
    if (arg === '--region') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --region');
      region = next;
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
  if (!region) throw new Error('Missing required --region <region_id>');
  if (!posture) throw new Error('Missing required --posture <hold|probe|push>');
  if (weight === null) throw new Error('Missing required --weight <int>');

  if (typeof region !== 'string' || region.trim().length === 0) {
    throw new Error('Invalid --region: must be a non-empty string');
  }
  
  // Canonicalize faction ID
  const canonicalFaction = canonicalizePoliticalSideId(faction);
  if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
    throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
  }

  return { savePath, outPath, faction: canonicalFaction, region, posture, weight };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  if (!state.front_posture_regions || typeof state.front_posture_regions !== 'object') state.front_posture_regions = {};
  if (!state.front_posture_regions[opts.faction]) state.front_posture_regions[opts.faction] = { assignments: {} };
  if (!state.front_posture_regions[opts.faction].assignments) state.front_posture_regions[opts.faction].assignments = {};

  state.front_posture_regions[opts.faction].assignments[opts.region] = {
    posture: opts.posture,
    weight: opts.weight
  };

  const out = opts.outPath ?? opts.savePath;
  await writeFile(out, serializeState(state), 'utf8');
  process.stdout.write(
    `set region posture: faction=${opts.faction} region=${opts.region} posture=${opts.posture} weight=${opts.weight} -> ${out}\n`
  );
}

main().catch((err) => {
  console.error('sim:setpostureregion failed', err);
  process.exitCode = 1;
});

