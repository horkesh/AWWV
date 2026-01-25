import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deserializeState, serializeState } from '../state/serialize.js';
import type { FormationState, GameState, MilitiaPoolState } from '../state/game_state.js';
import { validateFormations } from '../validate/formations.js';
import { validateMilitiaPools } from '../validate/militia_pools.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { getValidMunicipalityIds } from '../map/municipalities.js';
import { canonicalizePoliticalSideId, POLITICAL_SIDES } from '../state/identity.js';

type CliOptions = {
  savePath: string;
  batchSize: number;
  faction: string | null;
  mun: string | null;
  maxPerMun: number | null;
  tags: string[];
  dryRun: boolean;
  outPath: string | null;
  reportOutPath: string | null;
};

type GenerationReportFile = {
  schema: 1;
  turn: number;
  batch_size: number;
  filters: {
    faction?: string;
    mun?: string;
    max_per_mun?: number;
  };
  totals: {
    formations_created: number;
    manpower_moved_available_to_committed: number;
    municipalities_touched: number;
  };
  per_municipality: Array<{
    mun_id: string;
    faction: string;
    before: { available: number; committed: number; exhausted: number };
    after: { available: number; committed: number; exhausted: number };
    created: Array<{ formation_id: string; name: string; tags: string[] }>;
  }>;
};

function ensureFormations(state: GameState): void {
  if (!state.formations || typeof state.formations !== 'object') state.formations = {};
}

function ensureMilitiaPools(state: GameState): void {
  if (!state.militia_pools || typeof state.militia_pools !== 'object') {
    state.militia_pools = {};
  }
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

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 1) {
    throw new Error('Usage: npm run sim:genformations <save.json> --batch-size <int> [options...]');
  }

  const savePath = resolve(argv[0]);
  const rest = argv.slice(1);

  let batchSize: number | null = null;
  let faction: string | null = null;
  let mun: string | null = null;
  let maxPerMun: number | null = null;
  let tags: string | undefined;
  let dryRun = false;
  let outPath: string | null = null;
  let reportOutPath: string | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--batch-size') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('Missing value for --batch-size');
      batchSize = Number.parseInt(next, 10);
      if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error(`Invalid --batch-size: ${next} (expected positive integer)`);
      }
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
    if (a === '--mun') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('Missing value for --mun');
      mun = next;
      i += 1;
      continue;
    }
    if (a === '--max-per-mun') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('Missing value for --max-per-mun');
      maxPerMun = Number.parseInt(next, 10);
      if (!Number.isInteger(maxPerMun) || maxPerMun <= 0) {
        throw new Error(`Invalid --max-per-mun: ${next} (expected positive integer)`);
      }
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
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--out') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
      continue;
    }
    if (a === '--report-out') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('Missing value for --report-out');
      reportOutPath = resolve(next);
      i += 1;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    throw new Error(`Unexpected arg: ${a}`);
  }

  if (batchSize === null) {
    throw new Error('Missing required --batch-size <int>');
  }
  
  // Canonicalize faction ID if provided
  let canonicalFaction: string | null = null;
  if (faction !== null) {
    canonicalFaction = canonicalizePoliticalSideId(faction);
    if (!POLITICAL_SIDES.includes(canonicalFaction as any)) {
      throw new Error(`Invalid faction: "${faction}" (canonicalized to "${canonicalFaction}"). Must be one of: ${POLITICAL_SIDES.join(', ')}`);
    }
  }

  return {
    savePath,
    batchSize,
    faction: canonicalFaction,
    mun,
    maxPerMun,
    tags: normalizeTags(tags),
    dryRun,
    outPath,
    reportOutPath
  };
}

export function generateFormationsFromPools(
  state: GameState,
  batchSize: number,
  factionFilter: string | null,
  munFilter: string | null,
  maxPerMun: number | null,
  customTags: string[],
  applyChanges: boolean
): GenerationReportFile {
  ensureFormations(state);
  ensureMilitiaPools(state);

  const pools = state.militia_pools as Record<string, MilitiaPoolState>;
  const currentTurn = state.meta.turn;

  // Get eligible pools: must have non-null faction, match filters
  const eligiblePools: Array<{ mun_id: string; pool: MilitiaPoolState }> = [];
  for (const [mun_id, pool] of Object.entries(pools)) {
    if (!pool || typeof pool !== 'object') continue;
    if (pool.faction === null || pool.faction === undefined) continue;
    if (factionFilter !== null && pool.faction !== factionFilter) continue;
    if (munFilter !== null && mun_id !== munFilter) continue;
    if (pool.available < batchSize) continue; // Must have at least batchSize available
    eligiblePools.push({ mun_id, pool });
  }

  // Sort deterministically by mun_id for stable processing order
  eligiblePools.sort((a, b) => a.mun_id.localeCompare(b.mun_id));

  const report: GenerationReportFile = {
    schema: 1,
    turn: currentTurn,
    batch_size: batchSize,
    filters: {
      ...(factionFilter !== null ? { faction: factionFilter } : {}),
      ...(munFilter !== null ? { mun: munFilter } : {}),
      ...(maxPerMun !== null ? { max_per_mun: maxPerMun } : {})
    },
    totals: {
      formations_created: 0,
      manpower_moved_available_to_committed: 0,
      municipalities_touched: 0
    },
    per_municipality: []
  };

  // Process each eligible pool
  for (const { mun_id, pool } of eligiblePools) {
    const before = {
      available: pool.available,
      committed: pool.committed,
      exhausted: pool.exhausted
    };

    // Calculate how many formations to generate
    let count = Math.floor(pool.available / batchSize);
    if (maxPerMun !== null && count > maxPerMun) {
      count = maxPerMun;
    }

    if (count === 0) continue;

    const created: Array<{ formation_id: string; name: string; tags: string[] }> = [];

    for (let k = 1; k <= count; k += 1) {
      const formationId = generateDeterministicFormationId(state, pool.faction!);
      const formationName = `Militia Detachment ${mun_id} ${k}`;

      // Build tags: generated_phase8, mun:<mun_id>, plus custom tags
      const baseTags = [`generated_phase8`, `mun:${mun_id}`];
      const allTags = Array.from(new Set([...baseTags, ...customTags]));
      allTags.sort();

      const formation: FormationState = {
        id: formationId,
        faction: pool.faction!,
        name: formationName,
        created_turn: currentTurn,
        status: 'active',
        assignment: null,
        tags: allTags.length > 0 ? allTags : undefined
      };

      created.push({
        formation_id: formationId,
        name: formationName,
        tags: allTags
      });

      // Only add to state if applying changes
      if (applyChanges) {
        state.formations[formationId] = formation;
      }

      // Update pool (only if applying changes)
      if (applyChanges) {
        pool.available -= batchSize;
        pool.committed += batchSize;
        pool.updated_turn = currentTurn;
      }
    }

    if (created.length > 0) {
      // Sort created formations by formation_id for deterministic report
      created.sort((a, b) => a.formation_id.localeCompare(b.formation_id));

      const after = applyChanges
        ? {
            available: pool.available,
            committed: pool.committed,
            exhausted: pool.exhausted
          }
        : {
            available: before.available - created.length * batchSize,
            committed: before.committed + created.length * batchSize,
            exhausted: before.exhausted
          };

      report.per_municipality.push({
        mun_id,
        faction: pool.faction!,
        before,
        after,
        created
      });

      report.totals.formations_created += created.length;
      report.totals.manpower_moved_available_to_committed += created.length * batchSize;
      report.totals.municipalities_touched += 1;
    }
  }

  // Sort per_municipality by mun_id for deterministic report
  report.per_municipality.sort((a, b) => a.mun_id.localeCompare(b.mun_id));

  return report;
}

async function validateState(state: GameState): Promise<void> {
  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);
  const validMunicipalityIds = await getValidMunicipalityIds();

  const formationIssues = validateFormations(state, frontRegions, derivedFrontEdges);
  const formationErrors = formationIssues.filter((i) => i.severity === 'error');
  if (formationErrors.length > 0) {
    const details = formationErrors.map((i) => `${i.code}${i.path ? ` @ ${i.path}` : ''}: ${i.message}`).join('; ');
    throw new Error(`Formation validation failed: ${details}`);
  }

  const militiaIssues = validateMilitiaPools(state, validMunicipalityIds);
  const militiaErrors = militiaIssues.filter((i) => i.severity === 'error');
  if (militiaErrors.length > 0) {
    const details = militiaErrors.map((i) => `${i.code}${i.path ? ` @ ${i.path}` : ''}: ${i.message}`).join('; ');
    throw new Error(`Militia pool validation failed: ${details}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  // Generate report (only apply changes if not dry-run)
  const report = generateFormationsFromPools(
    state,
    opts.batchSize,
    opts.faction,
    opts.mun,
    opts.maxPerMun,
    opts.tags,
    !opts.dryRun
  );

  // Validate (even in dry-run to catch logic errors)
  await validateState(state);

  // Write report if requested
  if (opts.reportOutPath) {
    await mkdir(dirname(opts.reportOutPath), { recursive: true });
    await writeFile(opts.reportOutPath, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`  wrote report: ${opts.reportOutPath}\n`);
  }

  // Write save if not dry-run
  if (!opts.dryRun) {
    const outPath = opts.outPath ?? opts.savePath;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, serializeState(state), 'utf8');
    process.stdout.write(
      `generated ${report.totals.formations_created} formations from ${report.totals.municipalities_touched} municipalities -> ${outPath}\n`
    );
  } else {
    process.stdout.write(
      `[DRY RUN] would generate ${report.totals.formations_created} formations from ${report.totals.municipalities_touched} municipalities\n`
    );
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:genformations failed', err);
    process.exitCode = 1;
  });
}
