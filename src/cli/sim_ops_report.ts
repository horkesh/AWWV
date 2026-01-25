import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { deserializeState } from '../state/serialize.js';
import type { GameState } from '../state/game_state.js';
import { updateFormationFatigue } from '../state/formation_fatigue.js';
import { updateMilitiaFatigue } from '../state/militia_fatigue.js';

/**
 * Operational status report (read-only, deterministic).
 */
export interface OpsReportFile {
  schema: 1;
  turn: number;
  formations: {
    by_formation: Array<{
      formation_id: string;
      faction_id: string;
      supplied: boolean;
      fatigue: number;
      commit_points: number;
    }>;
    by_faction: Array<{
      faction_id: string;
      formations_active: number;
      formations_supplied: number;
      formations_unsupplied: number;
      total_fatigue: number;
      total_commit_points: number;
    }>;
  };
  militia_pools: {
    by_municipality: Array<{
      mun_id: string;
      faction_id: string | null;
      supplied: boolean;
      fatigue: number;
    }>;
    by_faction: Array<{
      faction_id: string | 'null';
      pools_total: number;
      pools_supplied: number;
      pools_unsupplied: number;
      total_fatigue: number;
    }>;
  };
}

function parseArgs(argv: string[]): { savePath: string; outPath: string; json: boolean } {
  let savePath: string | null = null;
  let outPath: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
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

  if (savePath === null) {
    throw new Error('Usage: npm run sim:ops <save.json> [--json] [--out <path>]');
  }

  const defaultOut = resolve('data', 'derived', 'ops_report.json');
  return { savePath, outPath: outPath ?? defaultOut, json };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const graph = await loadSettlementGraph();
  const derivedFrontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, derivedFrontEdges);

  // Compute formation fatigue (read-only, doesn't mutate state)
  const formationFatigueReport = updateFormationFatigue(state, derivedFrontEdges, frontRegions, graph.edges);

  // Compute militia fatigue (needs exhaustion deltas, so we need to run pressure/exhaustion first)
  // For read-only report, we'll compute a simplified version
  const exhaustionDeltas = new Map<string, number>();
  // In a real scenario, we'd run the full pipeline, but for ops report we'll use current state
  // and assume no exhaustion delta for this read-only inspection
  const militiaFatigueReport = updateMilitiaFatigue(state, graph.settlements, graph.edges, exhaustionDeltas);

  // Build report
  const report: OpsReportFile = {
    schema: 1,
    turn: state.meta.turn,
    formations: {
      by_formation: formationFatigueReport.by_formation.map((f) => ({
        formation_id: f.formation_id,
        faction_id: f.faction_id,
        supplied: f.supplied,
        fatigue: f.fatigue_after,
        commit_points: f.commit_points_used
      })),
      by_faction: formationFatigueReport.by_faction.map((f) => ({
        faction_id: f.faction_id,
        formations_active: f.formations_active,
        formations_supplied: f.formations_supplied,
        formations_unsupplied: f.formations_unsupplied,
        total_fatigue: f.total_fatigue,
        total_commit_points: f.total_commit_points
      }))
    },
    militia_pools: {
      by_municipality: militiaFatigueReport.by_municipality.map((m) => ({
        mun_id: m.mun_id,
        faction_id: m.faction_id,
        supplied: m.supplied,
        fatigue: m.fatigue_after
      })),
      by_faction: militiaFatigueReport.by_faction.map((f) => ({
        faction_id: f.faction_id,
        pools_total: f.pools_total,
        pools_supplied: f.pools_supplied,
        pools_unsupplied: f.pools_unsupplied,
        total_fatigue: f.total_fatigue
      }))
    }
  };

  if (opts.json) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`Ops report written to ${opts.outPath}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Operational Status Report (Turn ${report.turn})\n`);
    process.stdout.write(`\nFormations:\n`);
    for (const f of report.formations.by_faction) {
      process.stdout.write(
        `  ${f.faction_id}: ${f.formations_active} active (${f.formations_supplied} supplied, ${f.formations_unsupplied} unsupplied), total fatigue ${f.total_fatigue}, total commit points ${f.total_commit_points}\n`
      );
    }
    process.stdout.write(`\nMilitia Pools:\n`);
    for (const f of report.militia_pools.by_faction) {
      process.stdout.write(
        `  ${f.faction_id}: ${f.pools_total} pools (${f.pools_supplied} supplied, ${f.pools_unsupplied} unsupplied), total fatigue ${f.total_fatigue}\n`
      );
    }
  }
}

main().catch((err) => {
  console.error('sim:ops failed', err);
  process.exitCode = 1;
});
