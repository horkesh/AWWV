import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSettlementGraph } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { computeFrontBreaches } from '../state/front_breaches.js';
import {
  applyControlFlipProposals,
  buildAdjacencyMap,
  computeControlFlipProposals,
  type ControlFlipProposalFile
} from '../state/control_flip_proposals.js';
import { computeSupplyReachability } from '../state/supply_reachability.js';
import { deserializeState, serializeState } from '../state/serialize.js';
import { runTurn } from '../sim/turn_pipeline.js';
import type { GameState, PostureLevel } from '../state/game_state.js';

type ScenarioScriptEntry = {
  faction: string;
  edge_id: string;
  posture: PostureLevel;
  weight: number;
};

type ScenarioScriptFile = {
  schema: 1;
  turns: Record<string, ScenarioScriptEntry[]>;
};

export type ScenarioTurnSummary = {
  turn: number;
  front_edges_total: number;
  active_front_segments: number;
  front_regions: {
    total: number;
    by_side_pair: Array<{ side_pair: string; regions: number; active_edges: number }>;
  };
  formations: {
    total: number;
    by_faction: Array<{ faction_id: string; formations: number }>;
    by_force_label: Array<{ force_label: string; formations: number }>;
    assigned_region_count: number;
    assigned_edge_count: number;
    unassigned_count: number;
    formations_unsupplied_count: number; // Phase 10
    formations_avg_fatigue: number; // Phase 10: integer floor
  };
  commitment: {
    by_faction: Array<{
      faction_id: string;
      total_commit_points: number;
      total_demand_weight: number;
      total_effective_weight: number;
      capacity_applied: boolean;
    }>;
  };
  militia_pools: {
    total_muns: number;
    total_available: number;
    total_committed: number;
    total_exhausted: number;
    by_faction: Record<string, { muns: number; available: number; committed: number; exhausted: number }>;
    militia_pools_unsupplied_count: number; // Phase 10
    militia_pools_avg_fatigue: number; // Phase 10: integer floor
  };
  region_posture_expansion: { expanded_edges_count: number };
  breach_candidates: number;
  flip_targets_proposed: number;
  flip_targets_applied: number;
  highest_abs_pressure_current: number;
  top_pressures: Array<{ edge_id: string; value: number; abs: number }>;
  pressure_supply_modifiers: {
    edges_considered: number;
    edges_with_any_unsupplied_side: number;
  };
  exhaustion: {
    per_faction: Array<{ faction_id: string; before: number; after: number; delta: number; work_supplied: number; work_unsupplied: number }>;
    total_delta: number;
  };
  supply: {
    by_faction: Array<{ faction_id: string; controlled: number; reachable: number; isolated: number }>;
    total_isolated_controlled: number;
  };
  negotiation_pressure: {
    by_faction: Record<string, number>; // Phase 11A: negotiation pressure per faction
    delta_last_turn?: Record<string, number>; // Phase 11A: delta from previous turn (only if multiple turns)
  };
  negotiation_capital: {
    by_faction: Array<{ faction_id: string; capital: number; spent_total: number }>; // Phase 12A
    ledger_entries_total: number; // Phase 12A
  };
  negotiation: {
    ceasefire_active: boolean; // Phase 11B
    frozen_edges_count: number; // Phase 11B
    offers_count: number; // Phase 11B: total offers generated this turn
    acceptances_count: number; // Phase 11B: total acceptances this turn
  };
};

export type ScenarioSummaryFile = {
  schema: 1 | 2;
  turns: ScenarioTurnSummary[];
  end_state?: null | { kind: string; treaty_id: string; since_turn: number; outcome_hash?: string }; // Phase 12D.0/12D.1
  end_state_totals?: null | { settlements_by_controller: Record<string, number> }; // Phase 12D.1: deterministically ordered
  end_state_competences?: null | Array<{ competence: string; holder: string }>; // Phase 13A.0: competence allocations
  war_active_turns?: number; // Phase 12D.0: turns until end_state (inclusive) or total turns if no end_state
};

type CliOptions = {
  saveInPath: string;
  turns: number;
  applyBreaches: boolean;
  applyNegotiation: boolean; // Phase 11B
  scriptPath: string;
  outPath: string;
  summaryPath: string;
};

function parsePosture(value: unknown): PostureLevel {
  if (value === 'hold' || value === 'probe' || value === 'push') return value;
  throw new Error(`Invalid posture: ${String(value)} (expected hold|probe|push)`);
}

function validateCanonicalEdgeId(edge: unknown): void {
  if (typeof edge !== 'string' || !edge.includes('__')) throw new Error(`Invalid edge_id: ${String(edge)} (expected a__b)`);
  const parts = edge.split('__');
  if (parts.length !== 2) throw new Error(`Invalid edge_id: ${edge} (expected a__b)`);
  const [a, b] = parts;
  if (!a || !b) throw new Error(`Invalid edge_id: ${edge} (expected a__b)`);
  if (!(a < b)) throw new Error(`Invalid edge_id: ${edge} (expected canonical a__b with a < b)`);
}

function parseTurns(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --turns: ${value} (expected positive int)`);
  return n;
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let turns: number | null = null;
  let applyBreaches = false;
  let applyNegotiation = false; // Phase 11B
  let scriptPath: string | null = null;
  let outPath: string | null = null;
  let summaryPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--turns') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --turns');
      turns = parseTurns(next);
      i += 1;
      continue;
    }
    if (arg === '--apply-breaches') {
      applyBreaches = true;
      continue;
    }
    if (arg === '--apply-negotiation') {
      applyNegotiation = true;
      continue;
    }
    if (arg === '--script') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --script');
      scriptPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--summary') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --summary');
      summaryPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 1) {
    throw new Error('Usage: npm run sim:scenario <save_in.json> --turns N [--apply-breaches] [--apply-negotiation] --script <path.json> [--out <save_out.json>] [--summary <path.json>]');
  }
  const saveInPath = resolve(positional[0]);
  if (turns === null) throw new Error('Missing required --turns N');
  if (!scriptPath) throw new Error('Missing required --script <path.json>');

  const outDefault = resolve(`${saveInPath}.out.json`);
  const summaryDefault = resolve('data', 'derived', 'scenario_summary.json');

  return {
    saveInPath,
    turns,
    applyBreaches,
    applyNegotiation,
    scriptPath,
    outPath: outPath ?? outDefault,
    summaryPath: summaryPath ?? summaryDefault
  };
}

function parseScenarioScriptFile(jsonText: string): ScenarioScriptFile {
  const data = JSON.parse(jsonText) as unknown;
  if (!data || typeof data !== 'object') throw new Error('Invalid script: expected JSON object');
  const schema = (data as any).schema;
  if (schema !== 1) throw new Error(`Invalid script schema: ${(data as any).schema} (expected 1)`);
  const turns = (data as any).turns;
  if (!turns || typeof turns !== 'object') throw new Error('Invalid script: missing turns object');

  const outTurns: Record<string, ScenarioScriptEntry[]> = {};
  for (const k of Object.keys(turns)) {
    const v = (turns as any)[k];
    if (!Array.isArray(v)) throw new Error(`Invalid script: turns["${k}"] must be an array`);
    const entries: ScenarioScriptEntry[] = v.map((raw: any) => {
      const faction = raw?.faction;
      const edge_id = raw?.edge_id;
      const posture = parsePosture(raw?.posture);
      const weight = Number.isInteger(raw?.weight) ? (raw.weight as number) : 0;
      validateCanonicalEdgeId(edge_id);
      if (typeof faction !== 'string' || faction.length === 0) throw new Error(`Invalid script entry faction for turn ${k}`);
      return { faction, edge_id, posture, weight };
    });

    // Deterministic application order regardless of input array order.
    entries.sort((a, b) => {
      const fc = a.faction.localeCompare(b.faction);
      if (fc !== 0) return fc;
      return a.edge_id.localeCompare(b.edge_id);
    });
    outTurns[k] = entries;
  }

  return { schema: 1, turns: outTurns };
}

function applyScriptedPostureUpdates(state: GameState, entries: ScenarioScriptEntry[]): void {
  if (!state.front_posture || typeof state.front_posture !== 'object') state.front_posture = {};

  for (const e of entries) {
    if (!state.front_posture[e.faction]) state.front_posture[e.faction] = { assignments: {} };
    if (!state.front_posture[e.faction].assignments) state.front_posture[e.faction].assignments = {};
    state.front_posture[e.faction].assignments[e.edge_id] = {
      edge_id: e.edge_id,
      posture: e.posture,
      weight: e.weight
    };
  }
}

function countActiveFrontSegments(state: GameState): number {
  const segs = state.front_segments;
  if (!segs || typeof segs !== 'object') return 0;
  let count = 0;
  const keysSorted = Object.keys(segs).sort();
  for (const k of keysSorted) {
    const seg = (segs as any)[k];
    if (seg && typeof seg === 'object' && seg.active === true) count += 1;
  }
  return count;
}

function computePressureSummary(state: GameState, activeEdgeIds: string[]): { highestAbs: number; top: Array<{ edge_id: string; value: number; abs: number }> } {
  const pressure = state.front_pressure as any;
  const out: Array<{ edge_id: string; value: number; abs: number }> = [];

  for (const edge_id of activeEdgeIds) {
    const value = Number.isInteger(pressure?.[edge_id]?.value) ? (pressure[edge_id].value as number) : 0;
    out.push({ edge_id, value, abs: Math.abs(value) });
  }

  out.sort((a, b) => {
    if (a.abs !== b.abs) return b.abs - a.abs;
    return a.edge_id.localeCompare(b.edge_id);
  });

  const highestAbs = out.length > 0 ? out[0].abs : 0;
  return { highestAbs, top: out.slice(0, 5) };
}

function countFlipTargetsProposed(file: ControlFlipProposalFile): number {
  let total = 0;
  for (const p of file.proposals ?? []) {
    total += Array.isArray(p.targets) ? p.targets.length : 0;
  }
  return total;
}

export async function runScenarioDeterministic(
  initialState: GameState,
  options: { turns: number; applyBreaches: boolean; applyNegotiation: boolean; script: ScenarioScriptFile; settlementEdges: Array<{ a: string; b: string }> }
): Promise<{ finalState: GameState; summary: ScenarioSummaryFile }> {
  const adjacencyMap = buildAdjacencyMap(options.settlementEdges);
  let state: GameState = initialState;
  const turns: ScenarioTurnSummary[] = [];

  for (let i = 1; i <= options.turns; i += 1) {
    const scripted = options.script.turns[String(i)] ?? [];
    if (scripted.length > 0) applyScriptedPostureUpdates(state, scripted);

    const { nextState, report: turnReport } = await runTurn(state, {
      seed: state.meta.seed,
      settlementEdges: options.settlementEdges as any,
      applyNegotiation: options.applyNegotiation
    });
    state = nextState;

    const derivedFrontEdges = computeFrontEdges(state, options.settlementEdges as any);
    const breaches = computeFrontBreaches(state, derivedFrontEdges);
    const proposalsFile = computeControlFlipProposals(state, derivedFrontEdges, breaches, adjacencyMap);
    const flip_targets_proposed = countFlipTargetsProposed(proposalsFile);

    let flip_targets_applied = 0;
    if (options.applyBreaches) {
      const applied = applyControlFlipProposals(state, proposalsFile);
      flip_targets_applied = applied.applied;
    }

    const activeEdgeIdsSorted = derivedFrontEdges
      .map((e) => e.edge_id)
      .filter((edge_id) => {
        const seg = (state.front_segments as any)?.[edge_id];
        return seg && typeof seg === 'object' && seg.active === true;
      })
      .sort();

    const pressureSummary = computePressureSummary(state, activeEdgeIdsSorted);

    // Formation roster summary (scaffolding only; no effects yet)
    const formationRec = (state as any).formations as Record<string, any> | undefined;
    const formationsArr = formationRec && typeof formationRec === 'object' ? Object.values(formationRec) : [];
    const totalFormations = formationsArr.length;
    const byFactionMap = new Map<string, number>();
    const byForceLabelMap = new Map<string, number>();
    const byRegionMap = new Map<string, number>();
    const byEdgeMap = new Map<string, number>();
    let unassignedCount = 0;
    // Phase 10: fatigue counts
    let formationsUnsuppliedCount = 0;
    let totalFormationFatigue = 0;
    let activeFormationsCount = 0;
    for (const f of formationsArr) {
      if (!f || typeof f !== 'object') continue;
      const faction = typeof (f as any).faction === 'string' ? ((f as any).faction as string) : '';
      const forceLabel = typeof (f as any).force_label === 'string' ? ((f as any).force_label as string) : null;
      const assignment = (f as any).assignment;
      const status = (f as any).status;
      const ops = (f as any).ops;
      const currentTurn = state.meta.turn;

      if (faction) {
        const cur = byFactionMap.get(faction) ?? 0;
        byFactionMap.set(faction, cur + 1);
      }
      
      if (forceLabel) {
        const cur = byForceLabelMap.get(forceLabel) ?? 0;
        byForceLabelMap.set(forceLabel, cur + 1);
      }

      if (assignment && typeof assignment === 'object') {
        if (assignment.kind === 'region' && typeof assignment.region_id === 'string') {
          const curR = byRegionMap.get(assignment.region_id) ?? 0;
          byRegionMap.set(assignment.region_id, curR + 1);
        } else if (assignment.kind === 'edge' && typeof assignment.edge_id === 'string') {
          const curE = byEdgeMap.get(assignment.edge_id) ?? 0;
          byEdgeMap.set(assignment.edge_id, curE + 1);
        }
      } else {
        unassignedCount += 1;
      }

      // Phase 10: compute fatigue stats for active formations
      if (status === 'active') {
        activeFormationsCount += 1;
        const fatigue = ops && typeof ops === 'object' && Number.isInteger(ops.fatigue) ? ops.fatigue : 0;
        totalFormationFatigue += fatigue;
        const lastSuppliedTurn = ops && typeof ops === 'object' ? ops.last_supplied_turn : null;
        if (lastSuppliedTurn !== currentTurn) {
          formationsUnsuppliedCount += 1;
        }
      }
    }
    const formationsByFaction = Array.from(byFactionMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([faction_id, count]) => ({ faction_id, formations: count }));
    const formationsByForceLabel = Array.from(byForceLabelMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([force_label, count]) => ({ force_label, formations: count }));
    const formationsByRegion = Array.from(byRegionMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([region_id, count]) => ({ region_id, formations: count }));
    const formationsAvgFatigue = activeFormationsCount > 0 ? Math.floor(totalFormationFatigue / activeFormationsCount) : 0;

    // Militia pools summary (scaffolding only; no effects yet)
    const militiaPoolsRec = (state as any).militia_pools as Record<string, any> | undefined;
    const militiaPoolsArr = militiaPoolsRec && typeof militiaPoolsRec === 'object' ? Object.values(militiaPoolsRec) : [];
    let totalAvailable = 0;
    let totalCommitted = 0;
    let totalExhausted = 0;
    // Phase 10: fatigue counts
    let militiaPoolsUnsuppliedCount = 0;
    let totalMilitiaFatigue = 0;
    let poolsWithFactionCount = 0;
    const militiaByFactionMap = new Map<string, { muns: number; available: number; committed: number; exhausted: number }>();
    for (const p of militiaPoolsArr) {
      if (!p || typeof p !== 'object') continue;
      const faction = (p as any).faction;
      const available = Number.isInteger((p as any).available) ? ((p as any).available as number) : 0;
      const committed = Number.isInteger((p as any).committed) ? ((p as any).committed as number) : 0;
      const exhausted = Number.isInteger((p as any).exhausted) ? ((p as any).exhausted as number) : 0;
      const fatigue = Number.isInteger((p as any).fatigue) ? ((p as any).fatigue as number) : 0;

      totalAvailable += available;
      totalCommitted += committed;
      totalExhausted += exhausted;

      // Phase 10: compute fatigue stats for pools with faction
      if (faction !== null && typeof faction === 'string') {
        poolsWithFactionCount += 1;
        totalMilitiaFatigue += fatigue;
        // Determine if unsupplied from militia_fatigue report
        const militiaFatigueReport = turnReport.militia_fatigue;
        if (militiaFatigueReport) {
          const poolRecord = militiaFatigueReport.by_municipality.find((r) => r.mun_id === (p as any).mun_id && r.faction_id === faction);
          if (poolRecord && !poolRecord.supplied) {
            militiaPoolsUnsuppliedCount += 1;
          }
        }
      }

      const factionKey = faction !== null && typeof faction === 'string' ? faction : 'null';
      const cur = militiaByFactionMap.get(factionKey) ?? { muns: 0, available: 0, committed: 0, exhausted: 0 };
      cur.muns += 1;
      cur.available += available;
      cur.committed += committed;
      cur.exhausted += exhausted;
      militiaByFactionMap.set(factionKey, cur);
    }
    const militiaPoolsAvgFatigue = poolsWithFactionCount > 0 ? Math.floor(totalMilitiaFatigue / poolsWithFactionCount) : 0;

    const militiaByFaction: Record<string, { muns: number; available: number; committed: number; exhausted: number }> = {};
    const factionKeysSorted = Array.from(militiaByFactionMap.keys()).sort();
    for (const key of factionKeysSorted) {
      militiaByFaction[key] = militiaByFactionMap.get(key)!;
    }

    const regionsFile = computeFrontRegions(state, derivedFrontEdges);
    const bySidePairMap = new Map<string, { regions: number; active_edges: number }>();
    for (const r of regionsFile.regions) {
      const cur = bySidePairMap.get(r.side_pair) ?? { regions: 0, active_edges: 0 };
      cur.regions += 1;
      cur.active_edges += r.active_edge_count;
      bySidePairMap.set(r.side_pair, cur);
    }
    const bySidePair = Array.from(bySidePairMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([side_pair, v]) => ({ side_pair, regions: v.regions, active_edges: v.active_edges }));

    // Compute supply reachability
    const supplyReport = computeSupplyReachability(state, adjacencyMap);
    const supplyByFaction = supplyReport.factions.map((f) => ({
      faction_id: f.faction_id,
      controlled: f.controlled.length,
      reachable: f.reachable_controlled.length,
      isolated: f.isolated_controlled.length
    }));
    const totalIsolated = supplyReport.factions.reduce((sum, f) => sum + f.isolated_controlled.length, 0);

    // Commitment summary (Phase 9)
    const commitmentReport = turnReport.commitment;
    const commitmentByFaction = commitmentReport
      ? commitmentReport.by_faction.map((f) => ({
          faction_id: f.faction_id,
          total_commit_points: f.total_commit_points,
          total_demand_weight: f.total_demand_weight,
          total_effective_weight: f.total_effective_weight,
          capacity_applied: f.capacity_applied
        }))
      : [];

    turns.push({
      turn: state.meta.turn,
      front_edges_total: derivedFrontEdges.length,
      active_front_segments: countActiveFrontSegments(state),
      front_regions: {
        total: regionsFile.regions.length,
        by_side_pair: bySidePair
      },
      formations: {
        total: totalFormations,
        by_faction: formationsByFaction,
        by_force_label: formationsByForceLabel,
        assigned_region_count: byRegionMap.size,
        assigned_edge_count: byEdgeMap.size,
        unassigned_count: unassignedCount,
        formations_unsupplied_count: formationsUnsuppliedCount,
        formations_avg_fatigue: formationsAvgFatigue
      },
      militia_pools: {
        total_muns: militiaPoolsArr.length,
        total_available: totalAvailable,
        total_committed: totalCommitted,
        total_exhausted: totalExhausted,
        by_faction: militiaByFaction,
        militia_pools_unsupplied_count: militiaPoolsUnsuppliedCount,
        militia_pools_avg_fatigue: militiaPoolsAvgFatigue
      },
      region_posture_expansion: {
        expanded_edges_count: turnReport.region_posture_expansion?.expanded_edges_count ?? 0
      },
      breach_candidates: breaches.length,
      flip_targets_proposed,
      flip_targets_applied: options.applyBreaches ? flip_targets_applied : 0,
      highest_abs_pressure_current: pressureSummary.highestAbs,
      top_pressures: pressureSummary.top,
      pressure_supply_modifiers: {
        edges_considered: turnReport.front_pressure?.edges_considered ?? 0,
        edges_with_any_unsupplied_side: turnReport.front_pressure?.edges_with_any_unsupplied_side ?? 0
      },
      exhaustion: {
        per_faction:
          (turnReport.exhaustion?.per_faction ?? [])
            .map((f) => ({
              faction_id: f.faction_id,
              before: f.exhaustion_before,
              after: f.exhaustion_after,
              delta: f.delta,
              work_supplied: f.work_supplied,
              work_unsupplied: f.work_unsupplied
            }))
            .sort((a, b) => a.faction_id.localeCompare(b.faction_id)),
        total_delta: (turnReport.exhaustion?.per_faction ?? []).reduce((sum, f) => sum + (f.delta ?? 0), 0)
      },
      supply: {
        by_faction: supplyByFaction,
        total_isolated_controlled: totalIsolated
      },
      commitment: {
        by_faction: commitmentByFaction
      },
      negotiation_pressure: (() => {
        // Phase 11A: Extract negotiation pressure from state
        const negotiationByFaction: Record<string, number> = {};
        const negotiationDeltaByFaction: Record<string, number> = {};
        for (const f of state.factions) {
          const negotiation = f.negotiation;
          if (negotiation && typeof negotiation === 'object') {
            negotiationByFaction[f.id] = negotiation.pressure;
            // Get delta from turn report if available
            const negotiationReport = turnReport.negotiation_pressure;
            if (negotiationReport) {
              const factionReport = negotiationReport.per_faction.find((r) => r.faction_id === f.id);
              if (factionReport) {
                negotiationDeltaByFaction[f.id] = factionReport.delta;
              }
            }
          } else {
            negotiationByFaction[f.id] = 0;
          }
        }
        // Only include delta_last_turn if we have multiple turns and it's not the first turn
        const result: { by_faction: Record<string, number>; delta_last_turn?: Record<string, number> } = {
          by_faction: negotiationByFaction
        };
        if (options.turns > 1 && i > 1 && Object.keys(negotiationDeltaByFaction).length > 0) {
          result.delta_last_turn = negotiationDeltaByFaction;
        }
        return result;
      })(),
      negotiation_capital: (() => {
        // Phase 12A: Extract negotiation capital from state
        const capitalByFaction: Array<{ faction_id: string; capital: number; spent_total: number }> = [];
        for (const f of state.factions) {
          const negotiation = f.negotiation;
          if (negotiation && typeof negotiation === 'object') {
            capitalByFaction.push({
              faction_id: f.id,
              capital: Number.isInteger(negotiation.capital) && negotiation.capital >= 0 ? negotiation.capital : 0,
              spent_total: Number.isInteger(negotiation.spent_total) && negotiation.spent_total >= 0 ? negotiation.spent_total : 0
            });
          } else {
            capitalByFaction.push({
              faction_id: f.id,
              capital: 0,
              spent_total: 0
            });
          }
        }
        // Sort by faction_id asc
        capitalByFaction.sort((a, b) => a.faction_id.localeCompare(b.faction_id));
        const ledgerEntriesTotal = state.negotiation_ledger && Array.isArray(state.negotiation_ledger) ? state.negotiation_ledger.length : 0;
        return {
          by_faction: capitalByFaction,
          ledger_entries_total: ledgerEntriesTotal
        };
      })(),
      negotiation: (() => {
        // Phase 11B: Extract negotiation status
        const negotiationStatus = state.negotiation_status;
        const ceasefire = state.ceasefire;
        const ceasefireActive = negotiationStatus?.ceasefire_active ?? false;
        const frozenEdgesCount = ceasefire && typeof ceasefire === 'object' ? Object.keys(ceasefire).length : 0;
        const offersCount = turnReport.negotiation_offer?.offer ? 1 : 0;
        const acceptancesCount = turnReport.negotiation_acceptance?.accepted ? 1 : 0;
        return {
          ceasefire_active: ceasefireActive,
          frozen_edges_count: frozenEdgesCount,
          offers_count: offersCount,
          acceptances_count: acceptancesCount
        };
      })()
    });
  }

  // Phase 12D.0: Extract end_state and calculate war_active_turns
  const endState = state.end_state;
  let warActiveTurns = options.turns; // Default: all turns if no end_state
  
  if (endState) {
    // Find the turn when end_state was set
    const endStateTurn = endState.since_turn;
    const initialTurn = initialState.meta.turn;
    // Count turns from initial turn (inclusive) to end_state turn (inclusive)
    warActiveTurns = endStateTurn - initialTurn + 1;
  }

  // Phase 12D.1: Extract snapshot info if present
  let endStateTotals: { settlements_by_controller: Record<string, number> } | null = null;
  // Phase 13A.0: Extract competences if present
  let endStateCompetences: Array<{ competence: string; holder: string }> | null = null;
  if (endState?.snapshot) {
    endStateTotals = {
      settlements_by_controller: Object.fromEntries(endState.snapshot.settlements_by_controller)
    };
    if (endState.snapshot.competences && endState.snapshot.competences.length > 0) {
      endStateCompetences = endState.snapshot.competences;
    }
  }

  // Deterministic ordering: turns are already in ascending order.
  return {
    finalState: state,
    summary: {
      schema: 2,
      turns,
      end_state: endState
        ? {
            kind: endState.kind,
            treaty_id: endState.treaty_id,
            since_turn: endState.since_turn,
            outcome_hash: endState.snapshot?.outcome_hash
          }
        : null,
      end_state_totals: endStateTotals,
      end_state_competences: endStateCompetences,
      war_active_turns: warActiveTurns
    }
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const [savePayload, scriptPayload] = await Promise.all([
    readFile(opts.saveInPath, 'utf8'),
    readFile(opts.scriptPath, 'utf8')
  ]);

  const state = deserializeState(savePayload);
  const script = parseScenarioScriptFile(scriptPayload);
  const graph = await loadSettlementGraph();

  const { finalState, summary } = await runScenarioDeterministic(state, {
    turns: opts.turns,
    applyBreaches: opts.applyBreaches,
    applyNegotiation: opts.applyNegotiation,
    script,
    settlementEdges: graph.edges
  });

  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, serializeState(finalState), 'utf8');

  await mkdir(dirname(opts.summaryPath), { recursive: true });
  await writeFile(opts.summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  process.stdout.write(`sim:scenario complete: turns=${opts.turns} applyBreaches=${opts.applyBreaches ? 'yes' : 'no'}\n`);
  process.stdout.write(`  save_out: ${opts.outPath}\n`);
  process.stdout.write(`  summary: ${opts.summaryPath}\n`);
}

// Only run the CLI when invoked directly (tests import runScenarioDeterministic).
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('sim:scenario failed', err);
    process.exitCode = 1;
  });
}

