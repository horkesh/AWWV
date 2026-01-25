import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';

type CliOptions = {
  savePath: string;
  topN: number;
  writeJson: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const defaultSavePath = resolve('saves', 'save_0001.json');

  let savePath = defaultSavePath;
  let topN = 10;
  let writeJson = false;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      writeJson = true;
      continue;
    }
    if (arg === '--top') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --top');
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --top value: ${next}`);
      topN = n;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length >= 1) {
    savePath = resolve(positional[0]);
  }

  return { savePath, topN, writeJson };
}

function stableNumber(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const turn = state.meta.turn;

  const segmentsRecord = state.front_segments ?? {};
  const keysSorted = Object.keys(segmentsRecord).sort();

  let totalSegments = 0;
  let activeSegments = 0;
  let inactiveSegments = 0;
  let oldestActiveSinceTurn: number | null = null;
  let longestCurrentStreak = 0;
  let longestEverStreak = 0;
  let highestCurrentFriction = 0;
  let highestEverFriction = 0;
  let highestAbsPressureCurrent = 0;

  type ActiveRow = {
    edge_id: string;
    active_streak: number;
    max_active_streak: number;
    friction: number;
    max_friction: number;
    pressure_value: number;
    pressure_max_abs: number;
    since_turn: number;
    last_active_turn: number;
    age: number;
  };
  const activeRows: ActiveRow[] = [];

  for (const edge_id of keysSorted) {
    const seg = segmentsRecord[edge_id];
    if (!seg || typeof seg !== 'object') continue;
    totalSegments += 1;

    const isActive = (seg as any).active === true;
    if (isActive) activeSegments += 1;
    else inactiveSegments += 1;

    const max_active_streak_all = stableNumber((seg as any).max_active_streak) ?? 0;
    if (max_active_streak_all > longestEverStreak) longestEverStreak = max_active_streak_all;
    const max_friction_all = stableNumber((seg as any).max_friction) ?? 0;
    if (max_friction_all > highestEverFriction) highestEverFriction = max_friction_all;

    if (!isActive) continue;

    const pressureRec = (state as any).front_pressure?.[edge_id] as any;
    const pressure_value = stableNumber(pressureRec?.value) ?? 0;
    const pressure_max_abs = stableNumber(pressureRec?.max_abs) ?? 0;
    const absPressure = Math.abs(pressure_value);
    if (absPressure > highestAbsPressureCurrent) highestAbsPressureCurrent = absPressure;

    const since_turn = stableNumber((seg as any).since_turn);
    const last_active_turn = stableNumber((seg as any).last_active_turn);
    const active_streak = stableNumber((seg as any).active_streak) ?? 0;
    const max_active_streak = max_active_streak_all;
    const friction = stableNumber((seg as any).friction) ?? 0;
    const max_friction = max_friction_all;
    if (since_turn === null || last_active_turn === null) continue;

    if (oldestActiveSinceTurn === null || since_turn < oldestActiveSinceTurn) {
      oldestActiveSinceTurn = since_turn;
    }

    if (active_streak > longestCurrentStreak) longestCurrentStreak = active_streak;
    if (friction > highestCurrentFriction) highestCurrentFriction = friction;

    const age = turn - since_turn + 1;
    activeRows.push({
      edge_id,
      active_streak,
      max_active_streak,
      friction,
      max_friction,
      pressure_value,
      pressure_max_abs,
      since_turn,
      last_active_turn,
      age
    });
  }

  activeRows.sort((a, b) => {
    if (a.active_streak !== b.active_streak) return b.active_streak - a.active_streak;
    return a.edge_id.localeCompare(b.edge_id);
  });

  const topActiveByAge = activeRows.slice(0, opts.topN);

  // Optional grouping by side-pair (only if cheap): compute derived fronts from derived settlement edges.
  // This avoids raw map data and uses existing loader + computeFrontEdges.
  let activeBySidePair: Array<{ side_pair: string; count: number }> | null = null;
  try {
    const graph = await loadSettlementGraph();
    const derived = computeFrontEdges(state, graph.edges);
    const edgeIdToSidePair = new Map<string, string>();
    for (const e of derived) {
      if (!e || typeof e.edge_id !== 'string') continue;
      if (typeof e.side_a !== 'string' || typeof e.side_b !== 'string') continue;
      const a = e.side_a;
      const b = e.side_b;
      const pair = a < b ? `${a}–${b}` : `${b}–${a}`;
      edgeIdToSidePair.set(e.edge_id, pair);
    }

    const pairCounts = new Map<string, number>();
    for (const row of activeRows) {
      const pair = edgeIdToSidePair.get(row.edge_id);
      if (!pair) continue;
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    }

    activeBySidePair = Array.from(pairCounts.entries())
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .map(([side_pair, count]) => ({ side_pair, count }));
  } catch {
    // Intentionally ignore if derived settlement graph is unavailable.
    activeBySidePair = null;
  }

  process.stdout.write(`front_segments for turn ${turn}\n`);
  process.stdout.write(`  total_segments: ${totalSegments}\n`);
  process.stdout.write(`  active_segments: ${activeSegments}\n`);
  process.stdout.write(`  inactive_segments: ${inactiveSegments}\n`);
  process.stdout.write(`  oldest_active_since_turn: ${oldestActiveSinceTurn === null ? 'null' : oldestActiveSinceTurn}\n`);
  process.stdout.write(`  longest_current_streak: ${longestCurrentStreak}\n`);
  process.stdout.write(`  longest_ever_streak: ${longestEverStreak}\n`);
  process.stdout.write(`  highest_current_friction: ${highestCurrentFriction}\n`);
  process.stdout.write(`  highest_ever_friction: ${highestEverFriction}\n`);
  process.stdout.write(`  highest_abs_pressure_current: ${highestAbsPressureCurrent}\n`);

  process.stdout.write(`  top_active_by_streak (top ${opts.topN}):\n`);
  if (topActiveByAge.length === 0) {
    process.stdout.write(`    (none)\n`);
  } else {
    for (const row of topActiveByAge) {
      process.stdout.write(
        `    - ${row.edge_id} active_streak=${row.active_streak} max_active_streak=${row.max_active_streak} friction=${row.friction} max_friction=${row.max_friction} pressure_value=${row.pressure_value} pressure_max_abs=${row.pressure_max_abs} since_turn=${row.since_turn} last_active_turn=${row.last_active_turn}\n`
      );
    }
  }

  if (activeBySidePair && activeBySidePair.length > 0) {
    process.stdout.write(`  active_segments_by_side_pair:\n`);
    for (const entry of activeBySidePair) {
      process.stdout.write(`    - ${entry.side_pair}: ${entry.count}\n`);
    }
  }

  if (opts.writeJson) {
    const outPath = resolve('data', 'derived', 'front_state_report.json');
    const report = {
      schema: 1,
      turn,
      totals: {
        total_segments: totalSegments,
        active_segments: activeSegments,
        inactive_segments: inactiveSegments,
        oldest_active_since_turn: oldestActiveSinceTurn,
        longest_current_streak: longestCurrentStreak,
        longest_ever_streak: longestEverStreak,
        highest_current_friction: highestCurrentFriction,
        highest_ever_friction: highestEverFriction,
        highest_abs_pressure_current: highestAbsPressureCurrent
      },
      top_active_by_age: topActiveByAge,
      ...(activeBySidePair ? { active_segments_by_side_pair: activeBySidePair } : {})
    };

    await mkdir(resolve('data', 'derived'), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`  wrote: ${outPath}\n`);
  }
}

main().catch((err) => {
  console.error('sim:frontstate failed', err);
  process.exitCode = 1;
});

