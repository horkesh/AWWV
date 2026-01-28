/**
 * Phase 3A A/B Harness: Deterministic comparison of simulation runs
 * with Phase 3A pressure eligibility enabled vs disabled.
 * 
 * Runs one calibration scenario twice and produces a deterministic diff report.
 */

import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CURRENT_SCHEMA_VERSION, type GameState } from '../state/game_state.js';
import { runTurn } from '../sim/turn_pipeline.js';
import {
  setEnablePhase3A,
  resetEnablePhase3A,
  PHASE3A_PARAMS,
  loadEnrichedContactGraph,
  buildPressureEligibilityPhase3A,
  buildStateAccessors,
  type Phase3AAuditSummary
} from '../sim/pressure/phase3a_pressure_eligibility.js';
import {
  setEnablePhase3ADiffusion,
  resetEnablePhase3ADiffusion,
  runPhase3APressureDiffusionWithResult,
  type Phase3ADiffusionResult
} from '../sim/pressure/phase3a_pressure_diffusion.js';
import { pathToFileURL } from 'node:url';

// Pressure seed constant
const SEED_TOTAL_PRESSURE = 100;
const SEED_BFS_N = 25;

loadMistakes();
assertNoRepeat('phase3a ab harness weaklink two-cluster seed variant nonzero bottleneck');

// Scenario registry (stable order for deterministic selection)
type ScenarioFactory = () => GameState;

const SCENARIO_REGISTRY: Array<{ id: string; name: string; factory: ScenarioFactory }> = [
  { id: 'prolonged_siege', name: 'Prolonged siege (calibration scenario 1)', factory: createProlongedSiegeState },
  { id: 'temporary_encirclement', name: 'Temporary encirclement (calibration scenario 2)', factory: createTemporaryEncirclementState },
  { id: 'corridor_lifeline', name: 'Corridor lifeline (calibration scenario 3)', factory: createCorridorLifelineState },
  { id: 'multi_pocket_stress', name: 'Multi-pocket stress (calibration scenario 4)', factory: createMultiPocketStressState },
  { id: 'asymmetric_collapse', name: 'Asymmetric collapse (calibration scenario 5)', factory: createAsymmetricCollapseState },
];

// Scenario: Prolonged siege (from calibration.test.ts)
function createProlongedSiegeState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'prolonged-siege-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [], // No supply - will be unsupplied
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };
}

// Scenario 2: Temporary encirclement
function createTemporaryEncirclementState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'temporary-encirclement-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_B_s1'],
        supply_sources: ['MUN_B_s1'],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };
}

// Scenario 3: Corridor lifeline
function createCorridorLifelineState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'corridor-lifeline-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2', 'MUN_B_s1', 'MUN_B_s2'],
        supply_sources: ['MUN_B_s1'],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': {
        mun_id: 'MUN_A',
        faction: 'FACTION_A',
        available: 5000,
        committed: 0,
        exhausted: 0,
        updated_turn: 0
      }
    },
    displacement_state: {
      'MUN_A': {
        mun_id: 'MUN_A',
        original_population: 10000,
        displaced_out: 0,
        displaced_in: 0,
        lost_population: 0,
        last_updated_turn: 0
      }
    }
  };
}

// Scenario 4: Multi-pocket stress
function createMultiPocketStressState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'multi-pocket-stress-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_B_s1', 'MUN_B_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_C',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_C_s1', 'MUN_C_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': { mun_id: 'MUN_A', faction: 'FACTION_A', available: 5000, committed: 0, exhausted: 0, updated_turn: 0 },
      'MUN_B': { mun_id: 'MUN_B', faction: 'FACTION_B', available: 5000, committed: 0, exhausted: 0, updated_turn: 0 },
      'MUN_C': { mun_id: 'MUN_C', faction: 'FACTION_C', available: 5000, committed: 0, exhausted: 0, updated_turn: 0 }
    },
    displacement_state: {
      'MUN_A': { mun_id: 'MUN_A', original_population: 10000, displaced_out: 0, displaced_in: 0, lost_population: 0, last_updated_turn: 0 },
      'MUN_B': { mun_id: 'MUN_B', original_population: 10000, displaced_out: 0, displaced_in: 0, lost_population: 0, last_updated_turn: 0 },
      'MUN_C': { mun_id: 'MUN_C', original_population: 10000, displaced_out: 0, displaced_in: 0, lost_population: 0, last_updated_turn: 0 }
    }
  };
}

// Scenario 5: Asymmetric collapse
function createAsymmetricCollapseState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: 'asymmetric-collapse-seed' },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_A_s1', 'MUN_A_s2'],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: ['MUN_B_s1', 'MUN_B_s2'],
        supply_sources: ['MUN_B_s1'],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {
      'MUN_A': { mun_id: 'MUN_A', faction: 'FACTION_A', available: 5000, committed: 0, exhausted: 0, updated_turn: 0 },
      'MUN_B': { mun_id: 'MUN_B', faction: 'FACTION_B', available: 5000, committed: 0, exhausted: 0, updated_turn: 0 }
    },
    displacement_state: {
      'MUN_A': { mun_id: 'MUN_A', original_population: 10000, displaced_out: 0, displaced_in: 0, lost_population: 0, last_updated_turn: 0 },
      'MUN_B': { mun_id: 'MUN_B', original_population: 10000, displaced_out: 0, displaced_in: 0, lost_population: 0, last_updated_turn: 0 }
    }
  };
}

interface TurnMetrics {
  turn: number;
  pressure_sum: number;
  nonzero_nodes: number;
  top1_pressure: number;
  top5_share: number;
  // Deterministic node-pressure distribution derived from canonical state.front_pressure.
  // Stored as a sorted-key object to support L1 distance computations in the report.
  node_pressure_by_sid: Record<string, number>;
  // Optional half-split-derived node pressure (matches diffusion's internal node derivation).
  // Only populated for weaklink report leakage metrics.
  node_pressure_halfsplit_by_sid?: Record<string, number>;
  // When captured (Run B), measures pre vs post diffusion on the same turn/state.
  diffusion_applied?: boolean;
  diffusion_stats?: Phase3ADiffusionResult['stats'];
  l1_pre_post_diffusion?: number;
  eligible_edges_total: number;
  eligible_edges_by_type: {
    shared_border: number;
    point_touch: number;
    distance_contact: number;
  };
  weight_distribution_by_type: {
    shared_border: { min: number; p50: number; p90: number; p99: number; max: number };
    point_touch: { min: number; p50: number; p90: number; p99: number; max: number };
    distance_contact: { min: number; p50: number; p90: number; p99: number; max: number };
  };
  gate_blocked_counts: {
    exhaustion_collapse: number;
    cohesion_failure: number;
    missing_required_fields: number;
  };
  top_strongest_edges: Array<{ a: string; b: string; type: string; w: number }>;
}

function computePressureSum(state: GameState): number {
  if (!state.front_pressure || typeof state.front_pressure !== 'object') return 0;
  let sum = 0;
  for (const edgeId in state.front_pressure) {
    const pressure = (state.front_pressure as any)[edgeId];
    if (pressure && typeof pressure === 'object' && typeof pressure.value === 'number') {
      sum += Math.abs(pressure.value);
    }
  }
  return sum;
}

function parseEdgeId(edgeId: string): [string, string] | null {
  const idx = edgeId.indexOf('__');
  if (idx <= 0 || idx === edgeId.length - 2) return null;
  const a = edgeId.slice(0, idx);
  const b = edgeId.slice(idx + 2);
  return a && b ? [a, b] : null;
}

interface SeedEdgeAttribution {
  // Fractions that deterministically split abs(edge.value) onto endpoints.
  // Used for tree edges to preserve seeded node pressures exactly at seed time.
  fracA: number;
  fracB: number;
  a: string;
  b: string;
}

interface BfsSeedContext {
  seed_method: 'bfs_connected_nodes_v1' | 'bottleneck_two_cluster_v1' | 'weaklink_two_cluster_v1';
  N: number;
  start_sid: string;
  roots: string[];
  root_first_child_by_root: Record<string, string>;
  nodes_bfs: string[];
  nodes_sorted: string[];
  parent_by_sid: Record<string, string | null>;
  depth_by_sid: Record<string, number>;
  pv_by_sid: Record<string, number>;
  cluster_by_sid: Record<string, 'A' | 'B'>;
  tree_edge_ids: Set<string>;
  tree_edge_attribution: Map<string, SeedEdgeAttribution>;
  initially_nonzero_nodes: number;
  NA?: number;
  NB?: number;
  bottleneck_edge?: { a: string; b: string; type: string; w: number };
  weaklink_edge?: { a: string; b: string; type: string; w: number };
  weaklink_index?: number;
  weaklink_n?: number;
  allocation_total_before_normalize?: number;
  allocation_total_after_normalize?: number;
}

function canonicalEdgeId(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function computeNodePressureMap(state: GameState, seed?: BfsSeedContext): Map<string, number> {
  const m = new Map<string, number>();
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') return m;
  for (const edgeId in fp) {
    const pressure = (fp as any)[edgeId];
    if (!pressure || typeof pressure !== 'object' || typeof pressure.value !== 'number') continue;
    const pair = parseEdgeId(edgeId);
    if (!pair) continue;
    const [a, b] = pair;
    const v = Math.abs(pressure.value);

    const attr = seed?.tree_edge_attribution.get(edgeId);
    if (attr) {
      // Tree-directed attribution with fixed fractions derived from seed contributions.
      // This keeps seed node pressures exact at seed time while remaining deterministic after diffusion.
      m.set(attr.a, (m.get(attr.a) ?? 0) + v * attr.fracA);
      m.set(attr.b, (m.get(attr.b) ?? 0) + v * attr.fracB);
      continue;
    }

    // Default (non-tree) attribution: half-split across endpoints.
    m.set(a, (m.get(a) ?? 0) + v / 2);
    m.set(b, (m.get(b) ?? 0) + v / 2);
  }
  return m;
}

function nodeMapToSortedObject(m: Map<string, number>): Record<string, number> {
  const obj: Record<string, number> = {};
  const keys = [...m.keys()].sort((a, b) => a.localeCompare(b));
  for (const k of keys) obj[k] = m.get(k) ?? 0;
  return obj;
}

function computeDistributionMetricsFromNodeMap(m: Map<string, number>): {
  sum: number;
  nonzero: number;
  top1: number;
  top5_share: number;
} {
  const vals: Array<{ sid: string; v: number }> = [];
  let sum = 0;
  let nonzero = 0;
  let top1 = 0;
  let bestSid = '';

  for (const [sid, v] of m) {
    vals.push({ sid, v });
    sum += v;
    if (v > 0) nonzero += 1;
    if (v > top1 || (v === top1 && (bestSid === '' || sid.localeCompare(bestSid) < 0))) {
      top1 = v;
      bestSid = sid;
    }
  }

  vals.sort((a, b) => {
    if (b.v !== a.v) return b.v - a.v;
    return a.sid.localeCompare(b.sid);
  });
  const top5 = vals.slice(0, 5).reduce((acc, x) => acc + x.v, 0);
  const top5_share = sum > 0 ? top5 / sum : 0;

  return { sum, nonzero, top1, top5_share };
}

function computeL1Distance(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set<string>();
  for (const k of a.keys()) keys.add(k);
  for (const k of b.keys()) keys.add(k);
  const sorted = [...keys].sort((x, y) => x.localeCompare(y));
  let l1 = 0;
  for (const sid of sorted) {
    l1 += Math.abs((a.get(sid) ?? 0) - (b.get(sid) ?? 0));
  }
  return l1;
}

function computeL1DistanceFromObjects(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set<string>();
  for (const k of Object.keys(a)) keys.add(k);
  for (const k of Object.keys(b)) keys.add(k);
  const sorted = [...keys].sort((x, y) => x.localeCompare(y));
  let l1 = 0;
  for (const sid of sorted) {
    l1 += Math.abs((a[sid] ?? 0) - (b[sid] ?? 0));
  }
  return l1;
}

function extractTurnMetrics(
  state: GameState,
  turnReport: any,
  phase3aAudit: Phase3AAuditSummary | undefined,
  extra?: {
    diffusion_applied?: boolean;
    diffusion_stats?: Phase3ADiffusionResult['stats'];
    l1_pre_post_diffusion?: number;
  },
  seed?: BfsSeedContext
): TurnMetrics {
  // Canonical pressure field for Phase 3A diffusion + harness measurement:
  // state.front_pressure (edge-keyed; distribution is computed deterministically at node level).
  const nodeMap = computeNodePressureMap(state, seed);
  const dist = computeDistributionMetricsFromNodeMap(nodeMap);
  const pressureSum = computePressureSum(state);
  const nonzero_nodes = dist.nonzero;
  const top1_pressure = dist.top1;
  const top5_share = dist.top5_share;
  const node_pressure_by_sid = nodeMapToSortedObject(nodeMap);
  const node_pressure_halfsplit_by_sid =
    seed?.seed_method === 'weaklink_two_cluster_v1' ? nodeMapToSortedObject(computeNodePressureMap(state, undefined)) : undefined;

  if (!phase3aAudit) {
    return {
      turn: state.meta.turn,
      pressure_sum: pressureSum,
      nonzero_nodes,
      top1_pressure,
      top5_share,
      node_pressure_by_sid,
      node_pressure_halfsplit_by_sid,
      diffusion_applied: extra?.diffusion_applied,
      diffusion_stats: extra?.diffusion_stats,
      l1_pre_post_diffusion: extra?.l1_pre_post_diffusion,
      eligible_edges_total: 0,
      eligible_edges_by_type: {
        shared_border: 0,
        point_touch: 0,
        distance_contact: 0
      },
      weight_distribution_by_type: {
        shared_border: { min: 0, p50: 0, p90: 0, p99: 0, max: 0 },
        point_touch: { min: 0, p50: 0, p90: 0, p99: 0, max: 0 },
        distance_contact: { min: 0, p50: 0, p90: 0, p99: 0, max: 0 }
      },
      gate_blocked_counts: {
        exhaustion_collapse: 0,
        cohesion_failure: 0,
        missing_required_fields: 0
      },
      top_strongest_edges: []
    };
  }

  return {
    turn: state.meta.turn,
    pressure_sum: pressureSum,
    nonzero_nodes,
    top1_pressure,
    top5_share,
    node_pressure_by_sid,
    node_pressure_halfsplit_by_sid,
    diffusion_applied: extra?.diffusion_applied,
    diffusion_stats: extra?.diffusion_stats,
    l1_pre_post_diffusion: extra?.l1_pre_post_diffusion,
    eligible_edges_total: phase3aAudit.eligible_by_type.shared_border.eligible +
      phase3aAudit.eligible_by_type.point_touch.eligible +
      phase3aAudit.eligible_by_type.distance_contact.eligible,
    eligible_edges_by_type: {
      shared_border: phase3aAudit.eligible_by_type.shared_border.eligible,
      point_touch: phase3aAudit.eligible_by_type.point_touch.eligible,
      distance_contact: phase3aAudit.eligible_by_type.distance_contact.eligible
    },
    weight_distribution_by_type: phase3aAudit.weight_distribution_by_type,
    gate_blocked_counts: phase3aAudit.gate_blocked_counts,
    top_strongest_edges: phase3aAudit.top_strongest.slice(0, 5)
  };
}

async function runScenario(
  initialState: GameState,
  enablePhase3A: boolean,
  enableDiffusion: boolean,
  turns: number,
  settlementEdges: Array<{ a: string; b: string }>,
  seed: BfsSeedContext
): Promise<TurnMetrics[]> {
  setEnablePhase3A(enablePhase3A);
  // IMPORTANT: keep pipeline diffusion OFF so the harness can explicitly apply it
  // and prove pre/post distribution changes deterministically.
  setEnablePhase3ADiffusion(false);
  try {
    const metrics: TurnMetrics[] = [];
    let state = JSON.parse(JSON.stringify(initialState)) as GameState;

    for (let turn = 1; turn <= turns; turn++) {
      const { nextState, report } = await runTurn(state, {
        seed: state.meta.seed,
        settlementEdges: settlementEdges as any,
        applyNegotiation: false
      });
      state = nextState;
      const phase3aAudit = enablePhase3A ? report.phase3a_pressure_eligibility : undefined;

      let extra: {
        diffusion_applied?: boolean;
        diffusion_stats?: Phase3ADiffusionResult['stats'];
        l1_pre_post_diffusion?: number;
      } | undefined;

      if (enablePhase3A && enableDiffusion) {
        const pre = computeNodePressureMap(state, seed);

        const enriched = await loadEnrichedContactGraph();
        const accessors = buildStateAccessors(state);
        const eff = buildPressureEligibilityPhase3A(enriched, state, accessors, false);
        const iterations = seed.seed_method === 'weaklink_two_cluster_v1' ? 5 : 1;
        let result: Phase3ADiffusionResult | null = null;
        for (let k = 0; k < iterations; k++) {
          result = runPhase3APressureDiffusionWithResult(state, eff.edgesEffective, { strict_namespace: true });
        }

        const post = computeNodePressureMap(state, seed);
        const l1 = computeL1Distance(pre, post);

        extra = {
          diffusion_applied: Boolean(result?.applied),
          diffusion_stats: result?.stats,
          l1_pre_post_diffusion: l1
        };
      }

      const turnMetrics = extractTurnMetrics(state, report, phase3aAudit, extra, seed);
      metrics.push(turnMetrics);
    }
    return metrics;
  } finally {
    resetEnablePhase3A();
    resetEnablePhase3ADiffusion();
  }
}

/**
 * Probe a scenario for non-zero pressure (fast, 2 turns). Uses same edges as main runs.
 */
async function probeScenario(
  scenarioFactory: ScenarioFactory,
  edges: Array<{ a: string; b: string }>
): Promise<number> {
  const initialState = scenarioFactory();
  setEnablePhase3A(false);
  setEnablePhase3ADiffusion(false);
  try {
    let state = JSON.parse(JSON.stringify(initialState)) as GameState;
    for (let turn = 1; turn <= 2; turn++) {
      const { nextState } = await runTurn(state, {
        seed: state.meta.seed,
        settlementEdges: edges as any,
        applyNegotiation: false
      });
      state = nextState;
    }
    return computePressureSum(state);
  } finally {
    resetEnablePhase3A();
    resetEnablePhase3ADiffusion();
  }
}

function buildBfsSeedContextFromEffectiveEdges(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number }>,
  N: number
): BfsSeedContext {
  const eligible = effectiveEdges
    .filter((e) => e && e.eligible && e.w > 0 && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b }));

  if (eligible.length === 0) {
    throw new Error('Phase3A harness seed: no eligible effective edges available for BFS seeding');
  }

  let start_sid = '';
  for (const e of eligible) {
    if (start_sid === '' || e.a.localeCompare(start_sid) < 0) start_sid = e.a;
    if (e.b.localeCompare(start_sid) < 0) start_sid = e.b;
  }
  if (start_sid === '') throw new Error('Phase3A harness seed: failed to determine BFS start_sid');

  const adj = new Map<string, Set<string>>();
  const edgeSet = new Set<string>();
  for (const e of eligible) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
    edgeSet.add(canonicalEdgeId(e.a, e.b));
  }

  const parent_by_sid: Record<string, string | null> = {};
  const depth_by_sid: Record<string, number> = {};
  const nodes_bfs: string[] = [];

  const seen = new Set<string>();
  const q: string[] = [];
  seen.add(start_sid);
  parent_by_sid[start_sid] = null;
  depth_by_sid[start_sid] = 0;
  q.push(start_sid);

  while (q.length > 0 && nodes_bfs.length < N) {
    const u = q.shift()!;
    nodes_bfs.push(u);
    const neighbors = [...(adj.get(u) ?? new Set())].sort((a, b) => a.localeCompare(b));
    for (const v of neighbors) {
      if (seen.has(v)) continue;
      seen.add(v);
      parent_by_sid[v] = u;
      depth_by_sid[v] = (depth_by_sid[u] ?? 0) + 1;
      q.push(v);
      if (nodes_bfs.length + q.length >= N && nodes_bfs.length >= N) break;
    }
  }

  if (nodes_bfs.length < N) {
    throw new Error(
      `Phase3A harness seed: BFS produced only ${nodes_bfs.length} nodes (expected N=${N}) from start_sid=${start_sid}`
    );
  }

  const nodes_sorted = [...nodes_bfs].sort((a, b) => a.localeCompare(b));
  const pv_by_sid: Record<string, number> = {};
  for (const sid of nodes_sorted) pv_by_sid[sid] = 0;
  pv_by_sid[nodes_sorted[0]!] = 40;
  for (let i = 1; i <= 10; i++) {
    const sid = nodes_sorted[i];
    if (sid) pv_by_sid[sid] = 6;
  }
  const initially_nonzero_nodes = 11;
  const cluster_by_sid: Record<string, 'A' | 'B'> = {};
  for (const sid of nodes_bfs) cluster_by_sid[sid] = 'A';

  // Determine root-first-child deterministically: smallest child of start_sid in the BFS tree.
  const children = nodes_bfs
    .filter((sid) => parent_by_sid[sid] === start_sid)
    .sort((a, b) => a.localeCompare(b));
  const root_first_child = children[0];
  if (!root_first_child) {
    throw new Error(`Phase3A harness seed: BFS root ${start_sid} has no child; cannot encode root pressure`);
  }

  // Build tree edge set and deterministic attribution fractions derived from seed contributions.
  const tree_edge_ids = new Set<string>();
  const contribA: Record<string, number> = {};
  const contribB: Record<string, number> = {};

  for (const sid of nodes_bfs) {
    if (sid === start_sid) continue;
    const p = parent_by_sid[sid];
    if (!p) continue;
    const eid = canonicalEdgeId(p, sid);
    if (!edgeSet.has(eid)) {
      throw new Error(`Phase3A harness seed: missing effective edge for tree link ${p} <-> ${sid}`);
    }
    tree_edge_ids.add(eid);
    contribA[eid] = contribA[eid] ?? 0;
    contribB[eid] = contribB[eid] ?? 0;
    // We'll fill contributions after we know canonical endpoint ordering.
  }

  // Seed contributions: each non-root node contributes pv to its parent edge.
  // Root contributes pv_root to edge(root, root_first_child).
  const addContribution = (eid: string, sid: string, amount: number) => {
    if (amount <= 0) return;
    const [a, b] = parseEdgeId(eid) ?? (() => {
      const idx = eid.indexOf('__');
      return [eid.slice(0, idx), eid.slice(idx + 2)] as [string, string];
    })();
    if (sid === a) contribA[eid] = (contribA[eid] ?? 0) + amount;
    else if (sid === b) contribB[eid] = (contribB[eid] ?? 0) + amount;
    else throw new Error(`Phase3A harness seed: contribution sid ${sid} not on edge ${eid}`);
  };

  for (const sid of nodes_bfs) {
    const pv = pv_by_sid[sid] ?? 0;
    if (pv <= 0) continue;
    if (sid === start_sid) {
      const eid = canonicalEdgeId(start_sid, root_first_child);
      addContribution(eid, start_sid, pv);
    } else {
      const p = parent_by_sid[sid];
      if (!p) continue;
      const eid = canonicalEdgeId(p, sid);
      addContribution(eid, sid, pv);
    }
  }

  const tree_edge_attribution = new Map<string, SeedEdgeAttribution>();
  for (const eid of tree_edge_ids) {
    const pair = parseEdgeId(eid);
    if (!pair) throw new Error(`Phase3A harness seed: invalid tree edge id ${eid}`);
    const [a, b] = pair;
    const ca = contribA[eid] ?? 0;
    const cb = contribB[eid] ?? 0;
    const tot = ca + cb;
    const fracA = tot > 0 ? ca / tot : 0.5;
    const fracB = tot > 0 ? cb / tot : 0.5;
    tree_edge_attribution.set(eid, { a, b, fracA, fracB });
  }

  return {
    seed_method: 'bfs_connected_nodes_v1',
    N,
    start_sid,
    roots: [start_sid],
    root_first_child_by_root: { [start_sid]: root_first_child },
    nodes_bfs,
    nodes_sorted,
    parent_by_sid,
    depth_by_sid,
    pv_by_sid,
    cluster_by_sid,
    tree_edge_ids,
    tree_edge_attribution,
    initially_nonzero_nodes
  };
}

function applySeedIntoFrontPressure(state: GameState, seed: BfsSeedContext): void {
  // Assign control deterministically by BFS depth parity so tree edges are front edges.
  // For bottleneck_two_cluster_v1, Cluster B is parity-flipped so the bottleneck endpoints
  // land on opposite factions.
  let factionA = state.factions.find((f) => f.id === 'FACTION_A');
  if (!factionA) {
    factionA = {
      id: 'FACTION_A',
      profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
      areasOfResponsibility: [],
      supply_sources: [],
      negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
    };
    state.factions.push(factionA);
  }
  let factionB = state.factions.find((f) => f.id === 'FACTION_B');
  if (!factionB) {
    factionB = {
      id: 'FACTION_B',
      profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
      areasOfResponsibility: [],
      supply_sources: [],
      negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
    };
    state.factions.push(factionB);
  }

  factionA.areasOfResponsibility = [];
  factionB.areasOfResponsibility = [];

  for (const sid of seed.nodes_bfs) {
    const d = seed.depth_by_sid[sid] ?? 0;
    const cluster = seed.cluster_by_sid[sid] ?? 'A';
    const flip = cluster === 'B';
    const inA = flip ? d % 2 !== 0 : d % 2 === 0;
    if (inA) factionA.areasOfResponsibility.push(sid);
    else factionB.areasOfResponsibility.push(sid);
  }

  if (!state.front_segments || typeof state.front_segments !== 'object') state.front_segments = {};
  if (!state.front_pressure || typeof state.front_pressure !== 'object') state.front_pressure = {};

  const edgeValue: Record<string, number> = {};
  for (const sid of seed.nodes_bfs) {
    const pv = seed.pv_by_sid[sid] ?? 0;
    if (pv <= 0) continue;
    const p = seed.parent_by_sid[sid];
    if (p) {
      const eid = canonicalEdgeId(p, sid);
      edgeValue[eid] = (edgeValue[eid] ?? 0) + pv;
      continue;
    }

    // Root node: encode onto deterministic first tree edge for that root.
    const child = seed.root_first_child_by_root[sid];
    if (!child) {
      throw new Error(`Phase3A harness seed: root ${sid} missing root_first_child mapping`);
    }
    const eid = canonicalEdgeId(sid, child);
    edgeValue[eid] = (edgeValue[eid] ?? 0) + pv;
  }

  // Safety: total must be exactly 100.
  let pvTotal = 0;
  for (const sid of seed.nodes_bfs) pvTotal += seed.pv_by_sid[sid] ?? 0;
  let total = 0;
  for (const v of Object.values(edgeValue)) total += v;
  if (total !== SEED_TOTAL_PRESSURE) {
    throw new Error(
      `Phase3A harness seed: expected total ${SEED_TOTAL_PRESSURE}, got ${total} (pv_total_over_nodes_bfs=${pvTotal})`
    );
  }

  // Materialize seeded tree edges as active front segments and pressure records.
  // (Derived front edges will be recomputed in the pipeline based on AoR; we keep segments here for determinism.)
  for (const eid of seed.tree_edge_ids) {
    (state.front_segments as any)[eid] = {
      edge_id: eid,
      active: true,
      created_turn: 0,
      since_turn: 0,
      last_active_turn: 0,
      active_streak: 1,
      max_active_streak: 1,
      friction: 0,
      max_friction: 0
    };
    const v = edgeValue[eid] ?? 0;
    (state.front_pressure as any)[eid] = {
      edge_id: eid,
      value: v,
      max_abs: v,
      last_updated_turn: 0
    };
  }

  // weaklink_two_cluster_v1: explicitly include the weaklink edge as a zero-valued front edge
  // so diffusion across the connector can manifest as an edge pressure instead of being forced
  // to re-quantize only onto intra-cluster tree edges.
  if (seed.seed_method === 'weaklink_two_cluster_v1' && seed.weaklink_edge) {
    const eid = canonicalEdgeId(seed.weaklink_edge.a, seed.weaklink_edge.b);
    if (!((state.front_segments as any)[eid])) {
      (state.front_segments as any)[eid] = {
        edge_id: eid,
        active: true,
        created_turn: 0,
        since_turn: 0,
        last_active_turn: 0,
        active_streak: 1,
        max_active_streak: 1,
        friction: 0,
        max_friction: 0
      };
    } else {
      (state.front_segments as any)[eid].active = true;
    }
    if (!((state.front_pressure as any)[eid])) {
      (state.front_pressure as any)[eid] = { edge_id: eid, value: 0, max_abs: 0, last_updated_turn: 0 };
    }
  }
}

function typePriority(t: string): number {
  // Deterministic type priority for bottleneck tie-breaks.
  if (t === 'shared_border') return 0;
  if (t === 'point_touch') return 1;
  if (t === 'distance_contact') return 2;
  return 3;
}

function buildBottleneckTwoClusterSeedContext(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number; type?: string }>,
  NA: number,
  NB: number
): BfsSeedContext {
  const eligible = effectiveEdges
    .filter((e) => e && e.eligible && e.w > 0 && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, type: (e as any).type ?? 'unknown' }));
  if (eligible.length === 0) throw new Error('Phase3A bottleneck seed: no eligible effective edges found');

  const bottleneck = [...eligible].sort((e1, e2) => {
    if (e1.w !== e2.w) return e1.w - e2.w; // minimum w first
    const p1 = typePriority(e1.type);
    const p2 = typePriority(e2.type);
    if (p1 !== p2) return p1 - p2;
    const a1 = e1.a < e1.b ? e1.a : e1.b;
    const b1 = e1.a < e1.b ? e1.b : e1.a;
    const a2 = e2.a < e2.b ? e2.a : e2.b;
    const b2 = e2.a < e2.b ? e2.b : e2.a;
    if (a1 !== a2) return a1.localeCompare(a2);
    return b1.localeCompare(b2);
  })[0]!;

  const u = bottleneck.a;
  const v = bottleneck.b;

  const adj = new Map<string, Set<string>>();
  const edgeSet = new Set<string>();
  for (const e of eligible) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
    edgeSet.add(canonicalEdgeId(e.a, e.b));
  }

  const bfsNoCross = (start: string): { order: string[]; parent: Record<string, string | null>; depth: Record<string, number> } => {
    const seen = new Set<string>();
    const q: string[] = [];
    const order: string[] = [];
    const parent: Record<string, string | null> = {};
    const depth: Record<string, number> = {};
    seen.add(start);
    parent[start] = null;
    depth[start] = 0;
    q.push(start);
    while (q.length > 0) {
      const x = q.shift()!;
      order.push(x);
      const neighbors = [...(adj.get(x) ?? new Set())].sort((a, b) => a.localeCompare(b));
      for (const y of neighbors) {
        // Exclude traversal across the bottleneck edge (u <-> v) in either direction.
        if ((x === u && y === v) || (x === v && y === u)) continue;
        if (seen.has(y)) continue;
        seen.add(y);
        parent[y] = x;
        depth[y] = (depth[x] ?? 0) + 1;
        q.push(y);
      }
    }
    return { order, parent, depth };
  };

  const clusterAFull = bfsNoCross(u);
  const clusterBFull = bfsNoCross(v);
  // The spec excludes traversal across only the bottleneck edge; this does not guarantee
  // u/v become disconnected if there are alternate paths. To ensure two disjoint clusters,
  // we deterministically select Cluster A first, then select Cluster B from remaining nodes.
  const A_nodes_bfs: string[] = [];
  for (const sid of clusterAFull.order) {
    if (sid === v) continue; // keep the opposite endpoint out of Cluster A
    A_nodes_bfs.push(sid);
    if (A_nodes_bfs.length >= NA) break;
  }
  if (A_nodes_bfs.length < NA) throw new Error(`Phase3A bottleneck seed: Cluster A only ${A_nodes_bfs.length} nodes (need NA=${NA})`);
  const A_set = new Set<string>(A_nodes_bfs);

  const B_nodes_bfs: string[] = [];
  for (const sid of clusterBFull.order) {
    if (sid === u) continue; // keep the opposite endpoint out of Cluster B
    if (A_set.has(sid)) continue; // ensure disjoint clusters
    B_nodes_bfs.push(sid);
    if (B_nodes_bfs.length >= NB) break;
  }
  if (B_nodes_bfs.length < NB) throw new Error(`Phase3A bottleneck seed: Cluster B only ${B_nodes_bfs.length} nodes (need NB=${NB})`);

  const nodes_bfs = [...A_nodes_bfs, ...B_nodes_bfs];
  const nodes_sorted = [...nodes_bfs].sort((a, b) => a.localeCompare(b));

  const cluster_by_sid: Record<string, 'A' | 'B'> = {};
  for (const sid of A_nodes_bfs) cluster_by_sid[sid] = 'A';
  for (const sid of B_nodes_bfs) cluster_by_sid[sid] = 'B';

  const pv_by_sid: Record<string, number> = {};
  for (const sid of nodes_sorted) pv_by_sid[sid] = 0;

  const A_sorted = [...A_nodes_bfs].sort((a, b) => a.localeCompare(b));
  const B_sorted = [...B_nodes_bfs].sort((a, b) => a.localeCompare(b));

  // Cluster A allocation:
  // A_sorted[0]=30; A_sorted[1..6]=5 each; A_sorted[7..14]=1 each.
  pv_by_sid[A_sorted[0]!] += 30;
  for (let i = 1; i <= 6; i++) if (A_sorted[i]) pv_by_sid[A_sorted[i]!] += 5;
  for (let i = 7; i <= 14; i++) if (A_sorted[i]) pv_by_sid[A_sorted[i]!] += 1;

  // Cluster B allocation:
  // B_sorted[0]=15; B_sorted[1..4]=3 each; B_sorted[5..9]=1 each.
  pv_by_sid[B_sorted[0]!] += 15;
  for (let i = 1; i <= 4; i++) if (B_sorted[i]) pv_by_sid[B_sorted[i]!] += 3;
  for (let i = 5; i <= 9; i++) if (B_sorted[i]) pv_by_sid[B_sorted[i]!] += 1;

  let totalBefore = 0;
  for (const sid of nodes_sorted) totalBefore += pv_by_sid[sid] ?? 0;
  let total = totalBefore;

  // Normalize deterministically down to exactly 100 by subtracting 1 from the lexicographically largest seeded SID.
  const seededDesc = nodes_sorted.filter((sid) => (pv_by_sid[sid] ?? 0) > 0).sort((a, b) => b.localeCompare(a));
  if (total < SEED_TOTAL_PRESSURE) {
    throw new Error(`Phase3A bottleneck seed: total ${total} < ${SEED_TOTAL_PRESSURE}; normalization rule only subtracts`);
  }
  let guard = 0;
  while (total > SEED_TOTAL_PRESSURE) {
    const sid = seededDesc.find((s) => (pv_by_sid[s] ?? 0) > 0);
    if (!sid) throw new Error('Phase3A bottleneck seed: cannot normalize (no positive pv remains)');
    pv_by_sid[sid] -= 1;
    total -= 1;
    guard += 1;
    if (guard > 1000) throw new Error('Phase3A bottleneck seed: normalization guard tripped');
  }

  // Safety: allocation must sum to exactly 100 over the selected nodes.
  // (We later encode this deterministically into edge-keyed `front_pressure`.)
  let pvTotalOverNodes = 0;
  for (const sid of nodes_bfs) pvTotalOverNodes += pv_by_sid[sid] ?? 0;
  if (pvTotalOverNodes !== SEED_TOTAL_PRESSURE) {
    throw new Error(
      `Phase3A bottleneck seed: pv_total_over_nodes_bfs=${pvTotalOverNodes} (expected ${SEED_TOTAL_PRESSURE}) ` +
      `NA=${NA} NB=${NB} bottleneck=${u}__${v} total_before=${totalBefore} total_after=${total}`
    );
  }

  const initially_nonzero_nodes = nodes_sorted.reduce((acc, sid) => acc + ((pv_by_sid[sid] ?? 0) > 0 ? 1 : 0), 0);

  // Build spanning trees (BFS parents) restricted to selected nodes per cluster.
  const parent_by_sid: Record<string, string | null> = {};
  const depth_by_sid: Record<string, number> = {};
  for (const sid of A_nodes_bfs) {
    parent_by_sid[sid] = clusterAFull.parent[sid] ?? null;
    depth_by_sid[sid] = clusterAFull.depth[sid] ?? 0;
  }
  for (const sid of B_nodes_bfs) {
    parent_by_sid[sid] = clusterBFull.parent[sid] ?? null;
    depth_by_sid[sid] = clusterBFull.depth[sid] ?? 0;
  }
  parent_by_sid[u] = null;
  parent_by_sid[v] = null;
  depth_by_sid[u] = 0;
  depth_by_sid[v] = 0;

  const rootFirstChild = (root: string, cluster: 'A' | 'B'): string => {
    const kids = nodes_bfs
      .filter((sid) => cluster_by_sid[sid] === cluster && parent_by_sid[sid] === root)
      .sort((a, b) => a.localeCompare(b));
    const c = kids[0];
    if (!c) throw new Error(`Phase3A bottleneck seed: root ${root} has no child in cluster ${cluster}`);
    return c;
  };
  const root_first_child_A = rootFirstChild(u, 'A');
  const root_first_child_B = rootFirstChild(v, 'B');

  const ensureEdge = (a: string, b: string): string => {
    const eid = canonicalEdgeId(a, b);
    if (!edgeSet.has(eid)) throw new Error(`Phase3A bottleneck seed: missing effective edge ${a} <-> ${b}`);
    return eid;
  };

  const tree_edge_ids = new Set<string>();
  const contribA: Record<string, number> = {};
  const contribB: Record<string, number> = {};
  for (const sid of nodes_bfs) {
    const p = parent_by_sid[sid];
    if (!p) continue;
    tree_edge_ids.add(ensureEdge(p, sid));
  }

  const addContribution = (eid: string, sid: string, amount: number) => {
    if (amount <= 0) return;
    const pair = parseEdgeId(eid);
    if (!pair) throw new Error(`Phase3A bottleneck seed: invalid edge id ${eid}`);
    const [a, b] = pair;
    if (sid === a) contribA[eid] = (contribA[eid] ?? 0) + amount;
    else if (sid === b) contribB[eid] = (contribB[eid] ?? 0) + amount;
    else throw new Error(`Phase3A bottleneck seed: contribution sid ${sid} not on edge ${eid}`);
  };

  for (const sid of nodes_bfs) {
    const pv = pv_by_sid[sid] ?? 0;
    if (pv <= 0) continue;
    if (sid === u) addContribution(ensureEdge(u, root_first_child_A), u, pv);
    else if (sid === v) addContribution(ensureEdge(v, root_first_child_B), v, pv);
    else {
      const p = parent_by_sid[sid];
      if (!p) continue;
      addContribution(ensureEdge(p, sid), sid, pv);
    }
  }

  const tree_edge_attribution = new Map<string, SeedEdgeAttribution>();
  for (const eid of tree_edge_ids) {
    const pair = parseEdgeId(eid);
    if (!pair) throw new Error(`Phase3A bottleneck seed: invalid tree edge id ${eid}`);
    const [a, b] = pair;
    const ca = contribA[eid] ?? 0;
    const cb = contribB[eid] ?? 0;
    const tot = ca + cb;
    const fracA = tot > 0 ? ca / tot : 0.5;
    const fracB = tot > 0 ? cb / tot : 0.5;
    tree_edge_attribution.set(eid, { a, b, fracA, fracB });
  }

  return {
    seed_method: 'bottleneck_two_cluster_v1',
    N: NA + NB,
    start_sid: nodes_sorted[0]!,
    roots: [u, v],
    root_first_child_by_root: { [u]: root_first_child_A, [v]: root_first_child_B },
    nodes_bfs,
    nodes_sorted,
    parent_by_sid,
    depth_by_sid,
    pv_by_sid,
    cluster_by_sid,
    tree_edge_ids,
    tree_edge_attribution,
    initially_nonzero_nodes,
    NA,
    NB,
    bottleneck_edge: { a: u, b: v, type: bottleneck.type, w: bottleneck.w },
    allocation_total_before_normalize: totalBefore,
    allocation_total_after_normalize: total
  };
}

function buildWeaklinkTwoClusterSeedContext(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number; type?: string }>,
  NA: number,
  NB: number
): BfsSeedContext {
  // Candidates: eligible edges with strictly positive w.
  const candidates = effectiveEdges
    .filter((e) => e && e.eligible && typeof e.w === 'number' && e.w > 0 && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, type: (e as any).type ?? 'unknown' }));
  if (candidates.length === 0) throw new Error('Phase3A weaklink seed: no eligible edges with w>0 found');

  const sorted = [...candidates].sort((e1, e2) => {
    if (e1.w !== e2.w) return e1.w - e2.w;
    const p1 = typePriority(e1.type);
    const p2 = typePriority(e2.type);
    if (p1 !== p2) return p1 - p2;
    const a1 = e1.a < e1.b ? e1.a : e1.b;
    const b1 = e1.a < e1.b ? e1.b : e1.a;
    const a2 = e2.a < e2.b ? e2.a : e2.b;
    const b2 = e2.a < e2.b ? e2.b : e2.a;
    if (a1 !== a2) return a1.localeCompare(a2);
    return b1.localeCompare(b2);
  });

  const n = sorted.length;
  const idx = Math.floor(0.05 * (n - 1));
  const link = sorted[idx]!;

  // Construct clusters/encoding identically to bottleneck_two_cluster_v1, but using the selected weaklink edge.
  const seed = buildTwoClusterSeedFromLink(effectiveEdges, link.a, link.b, NA, NB);
  return {
    ...seed,
    seed_method: 'weaklink_two_cluster_v1',
    weaklink_edge: { a: link.a, b: link.b, type: link.type, w: link.w },
    weaklink_index: idx,
    weaklink_n: n
  };
}

function buildTwoClusterSeedFromLink(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number; type?: string }>,
  u: string,
  v: string,
  NA: number,
  NB: number
): BfsSeedContext {
  // This matches bottleneck_two_cluster_v1 cluster construction + allocation + encoding,
  // but takes (u,v) as the chosen link.
  const eligible = effectiveEdges
    .filter((e) => e && e.eligible && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, type: (e as any).type ?? 'unknown' }));
  if (eligible.length === 0) throw new Error('Phase3A two-cluster seed: no eligible effective edges found');

  const adj = new Map<string, Set<string>>();
  const edgeSet = new Set<string>();
  for (const e of eligible) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
    edgeSet.add(canonicalEdgeId(e.a, e.b));
  }

  const bfsNoCross = (start: string): { order: string[]; parent: Record<string, string | null>; depth: Record<string, number> } => {
    const seen = new Set<string>();
    const q: string[] = [];
    const order: string[] = [];
    const parent: Record<string, string | null> = {};
    const depth: Record<string, number> = {};
    seen.add(start);
    parent[start] = null;
    depth[start] = 0;
    q.push(start);
    while (q.length > 0) {
      const x = q.shift()!;
      order.push(x);
      const neighbors = [...(adj.get(x) ?? new Set())].sort((a, b) => a.localeCompare(b));
      for (const y of neighbors) {
        if ((x === u && y === v) || (x === v && y === u)) continue;
        if (seen.has(y)) continue;
        seen.add(y);
        parent[y] = x;
        depth[y] = (depth[x] ?? 0) + 1;
        q.push(y);
      }
    }
    return { order, parent, depth };
  };

  const clusterAFull = bfsNoCross(u);
  const clusterBFull = bfsNoCross(v);

  const A_nodes_bfs: string[] = [];
  for (const sid of clusterAFull.order) {
    if (sid === v) continue;
    A_nodes_bfs.push(sid);
    if (A_nodes_bfs.length >= NA) break;
  }
  if (A_nodes_bfs.length < NA) throw new Error(`Phase3A two-cluster seed: Cluster A only ${A_nodes_bfs.length} nodes (need NA=${NA})`);
  const A_set = new Set<string>(A_nodes_bfs);

  const B_nodes_bfs: string[] = [];
  for (const sid of clusterBFull.order) {
    if (sid === u) continue;
    if (A_set.has(sid)) continue;
    B_nodes_bfs.push(sid);
    if (B_nodes_bfs.length >= NB) break;
  }
  if (B_nodes_bfs.length < NB) throw new Error(`Phase3A two-cluster seed: Cluster B only ${B_nodes_bfs.length} nodes (need NB=${NB})`);

  const nodes_bfs = [...A_nodes_bfs, ...B_nodes_bfs];
  const nodes_sorted = [...nodes_bfs].sort((a, b) => a.localeCompare(b));

  const cluster_by_sid: Record<string, 'A' | 'B'> = {};
  for (const sid of A_nodes_bfs) cluster_by_sid[sid] = 'A';
  for (const sid of B_nodes_bfs) cluster_by_sid[sid] = 'B';

  const pv_by_sid: Record<string, number> = {};
  for (const sid of nodes_sorted) pv_by_sid[sid] = 0;
  const A_sorted = [...A_nodes_bfs].sort((a, b) => a.localeCompare(b));
  const B_sorted = [...B_nodes_bfs].sort((a, b) => a.localeCompare(b));

  pv_by_sid[A_sorted[0]!] += 30;
  for (let i = 1; i <= 6; i++) if (A_sorted[i]) pv_by_sid[A_sorted[i]!] += 5;
  for (let i = 7; i <= 14; i++) if (A_sorted[i]) pv_by_sid[A_sorted[i]!] += 1;

  pv_by_sid[B_sorted[0]!] += 15;
  for (let i = 1; i <= 4; i++) if (B_sorted[i]) pv_by_sid[B_sorted[i]!] += 3;
  for (let i = 5; i <= 9; i++) if (B_sorted[i]) pv_by_sid[B_sorted[i]!] += 1;

  let totalBefore = 0;
  for (const sid of nodes_sorted) totalBefore += pv_by_sid[sid] ?? 0;
  let total = totalBefore;

  const seededDesc = nodes_sorted.filter((sid) => (pv_by_sid[sid] ?? 0) > 0).sort((a, b) => b.localeCompare(a));
  if (total < SEED_TOTAL_PRESSURE) throw new Error(`Phase3A two-cluster seed: total ${total} < ${SEED_TOTAL_PRESSURE}`);
  while (total > SEED_TOTAL_PRESSURE) {
    const sid = seededDesc.find((s) => (pv_by_sid[s] ?? 0) > 0);
    if (!sid) throw new Error('Phase3A two-cluster seed: cannot normalize');
    pv_by_sid[sid] -= 1;
    total -= 1;
  }

  let pvTotalOverNodes = 0;
  for (const sid of nodes_bfs) pvTotalOverNodes += pv_by_sid[sid] ?? 0;
  if (pvTotalOverNodes !== SEED_TOTAL_PRESSURE) {
    throw new Error(`Phase3A two-cluster seed: pv_total_over_nodes_bfs=${pvTotalOverNodes} (expected ${SEED_TOTAL_PRESSURE})`);
  }

  const initially_nonzero_nodes = nodes_sorted.reduce((acc, sid) => acc + ((pv_by_sid[sid] ?? 0) > 0 ? 1 : 0), 0);

  const parent_by_sid: Record<string, string | null> = {};
  const depth_by_sid: Record<string, number> = {};
  for (const sid of A_nodes_bfs) {
    parent_by_sid[sid] = clusterAFull.parent[sid] ?? null;
    depth_by_sid[sid] = clusterAFull.depth[sid] ?? 0;
  }
  for (const sid of B_nodes_bfs) {
    parent_by_sid[sid] = clusterBFull.parent[sid] ?? null;
    depth_by_sid[sid] = clusterBFull.depth[sid] ?? 0;
  }
  parent_by_sid[u] = null;
  parent_by_sid[v] = null;
  depth_by_sid[u] = 0;
  depth_by_sid[v] = 0;

  const rootFirstChild = (root: string, cluster: 'A' | 'B'): string => {
    const kids = nodes_bfs
      .filter((sid) => cluster_by_sid[sid] === cluster && parent_by_sid[sid] === root)
      .sort((a, b) => a.localeCompare(b));
    const c = kids[0];
    if (!c) throw new Error(`Phase3A two-cluster seed: root ${root} has no child in cluster ${cluster}`);
    return c;
  };
  const root_first_child_A = rootFirstChild(u, 'A');
  const root_first_child_B = rootFirstChild(v, 'B');

  const ensureEdge = (a: string, b: string): string => {
    const eid = canonicalEdgeId(a, b);
    if (!edgeSet.has(eid)) throw new Error(`Phase3A two-cluster seed: missing effective edge ${a} <-> ${b}`);
    return eid;
  };

  const tree_edge_ids = new Set<string>();
  const contribA: Record<string, number> = {};
  const contribB: Record<string, number> = {};
  for (const sid of nodes_bfs) {
    const p = parent_by_sid[sid];
    if (!p) continue;
    tree_edge_ids.add(ensureEdge(p, sid));
  }

  const addContribution = (eid: string, sid: string, amount: number) => {
    if (amount <= 0) return;
    const pair = parseEdgeId(eid);
    if (!pair) throw new Error(`Phase3A two-cluster seed: invalid edge id ${eid}`);
    const [a, b] = pair;
    if (sid === a) contribA[eid] = (contribA[eid] ?? 0) + amount;
    else if (sid === b) contribB[eid] = (contribB[eid] ?? 0) + amount;
    else throw new Error(`Phase3A two-cluster seed: contribution sid ${sid} not on edge ${eid}`);
  };

  for (const sid of nodes_bfs) {
    const pv = pv_by_sid[sid] ?? 0;
    if (pv <= 0) continue;
    if (sid === u) addContribution(ensureEdge(u, root_first_child_A), u, pv);
    else if (sid === v) addContribution(ensureEdge(v, root_first_child_B), v, pv);
    else {
      const p = parent_by_sid[sid];
      if (!p) continue;
      addContribution(ensureEdge(p, sid), sid, pv);
    }
  }

  const tree_edge_attribution = new Map<string, SeedEdgeAttribution>();
  for (const eid of tree_edge_ids) {
    const pair = parseEdgeId(eid);
    if (!pair) throw new Error(`Phase3A two-cluster seed: invalid tree edge id ${eid}`);
    const [a, b] = pair;
    const ca = contribA[eid] ?? 0;
    const cb = contribB[eid] ?? 0;
    const tot = ca + cb;
    tree_edge_attribution.set(eid, { a, b, fracA: tot > 0 ? ca / tot : 0.5, fracB: tot > 0 ? cb / tot : 0.5 });
  }

  return {
    seed_method: 'bottleneck_two_cluster_v1',
    N: NA + NB,
    start_sid: nodes_sorted[0]!,
    roots: [u, v],
    root_first_child_by_root: { [u]: root_first_child_A, [v]: root_first_child_B },
    nodes_bfs,
    nodes_sorted,
    parent_by_sid,
    depth_by_sid,
    pv_by_sid,
    cluster_by_sid,
    tree_edge_ids,
    tree_edge_attribution,
    initially_nonzero_nodes,
    NA,
    NB,
    allocation_total_before_normalize: totalBefore,
    allocation_total_after_normalize: total
  };
}

function formatReport(
  scenarioName: string,
  scenarioId: string,
  selectionMethod: 'auto_nonzero_fixture' | 'seed_fallback',
  seededSids: string[] | null,
  seedValue: number | null,
  metricsA: TurnMetrics[],
  metricsB: TurnMetrics[],
  params: typeof PHASE3A_PARAMS,
  seed: BfsSeedContext
): string {
  const lines: string[] = [];

  // Header
  lines.push('='.repeat(80));
  lines.push('Phase 3A A/B Comparison Report');
  lines.push('='.repeat(80));
  lines.push('');
  lines.push('report_format_version: phase3a_ab_v2');
  lines.push('');
  lines.push(`Scenario: ${scenarioName}`);
  lines.push(`Scenario ID: ${scenarioId}`);
  lines.push(`Selection method: ${selectionMethod}`);
  lines.push(`Seed applied: true`);
  lines.push(`seed_method: "${seed.seed_method}"`);
  lines.push(`N: ${seed.N}`);
  lines.push(`start_sid: ${seed.start_sid}`);
  if (seed.seed_method === 'bfs_connected_nodes_v1') {
    lines.push(`allocation_pattern: 40 + 10*6 (total=${SEED_TOTAL_PRESSURE})`);
  } else {
    lines.push(`cluster_sizes: NA=${seed.NA}, NB=${seed.NB}`);
    if (seed.seed_method === 'bottleneck_two_cluster_v1' && seed.bottleneck_edge) {
      const a = seed.bottleneck_edge.a;
      const b = seed.bottleneck_edge.b;
      const t = seed.bottleneck_edge.type;
      const w = seed.bottleneck_edge.w;
      lines.push(`bottleneck_edge: "${a} <-> ${b} (${t}, w=${w.toFixed(6)})"`);
    }
    if (seed.seed_method === 'weaklink_two_cluster_v1' && seed.weaklink_edge) {
      const a = seed.weaklink_edge.a;
      const b = seed.weaklink_edge.b;
      const t = seed.weaklink_edge.type;
      const w = seed.weaklink_edge.w;
      const idx = seed.weaklink_index ?? -1;
      const n = seed.weaklink_n ?? -1;
      lines.push(`weaklink_edge: "${a} <-> ${b} (${t}, w=${w.toFixed(6)})"`);
      lines.push(`weaklink_index: ${idx} of n=${n}`);
      lines.push(`weaklink_diffusion_iterations_per_turn: 5`);
    }
  lines.push(`allocation_summary: A(30 + 6*5 + 8*1), B(15 + 4*3 + 5*1), normalize down to total=${SEED_TOTAL_PRESSURE}`);
    lines.push(`allocation_total_before_normalize: ${seed.allocation_total_before_normalize}`);
    lines.push(`allocation_total_after_normalize: ${seed.allocation_total_after_normalize}`);
  }
  lines.push(`initial_nonzero_nodes: ${seed.initially_nonzero_nodes}`);
  lines.push(`node_pressure_derivation: tree_edges_use_seed_fraction_attribution; non_tree_edges_half_split`);
  lines.push(`Total turns: ${metricsA.length}`);
  lines.push('');
  lines.push('Phase 3A Parameters:');
  lines.push(`  E_collapse: ${params.E_collapse}`);
  lines.push(`  C_floor: ${params.C_floor}`);
  lines.push(`  B_sb (shared_border): ${params.B_sb}`);
  lines.push(`  B_pt (point_touch): ${params.B_pt}`);
  lines.push(`  B_dc (distance_contact): ${params.B_dc}`);
  lines.push(`  D_scale: ${params.D_scale}`);
  lines.push(`  O_ref: ${params.O_ref}`);
  lines.push(`  f_shape_min: ${params.f_shape_min}`);
  lines.push(`  f_missing_distance: ${params.f_missing_distance}`);
  lines.push('');
  lines.push('Run Settings:');
  lines.push('  Run A: Phase 3A eligibility OFF, diffusion OFF');
  lines.push('  Run B: Phase 3A eligibility ON, diffusion ON (harness applies diffusion with strict namespace check)');
  lines.push('');
  lines.push('='.repeat(80));
  lines.push('');

  // Per-turn table
  lines.push('Per-Turn Metrics:');
  lines.push('-'.repeat(80));
  const isWeaklink = seed.seed_method === 'weaklink_two_cluster_v1';
  lines.push(
    'Turn'.padEnd(6) +
    'PressureSum_A'.padEnd(14) +
    'PressureSum_B'.padEnd(14) +
    'NonZero_A'.padEnd(11) +
    'NonZero_B'.padEnd(11) +
    'Top1_A'.padEnd(12) +
    'Top1_B'.padEnd(12) +
    'Top5Share_A'.padEnd(13) +
    'Top5Share_B'.padEnd(13) +
    'L1Dist_AB'.padEnd(12) +
    (isWeaklink ? 'ClusterAShare_B'.padEnd(16) + 'ClusterBShare_B'.padEnd(16) : '') +
    'DiffApplied_B'.padEnd(13)
  );
  lines.push('-'.repeat(80));

  const diffusionStatsLines: string[] = [];

  for (let i = 0; i < metricsA.length; i++) {
    const mA = metricsA[i];
    const mB = metricsB[i];
    const l1DistAB = computeL1DistanceFromObjects(mA.node_pressure_by_sid, mB.node_pressure_by_sid);

    let clusterAShareB = 0;
    let clusterBShareB = 0;
    if (isWeaklink) {
      let sumA = 0;
      let sumB = 0;
      const distObj = mB.node_pressure_halfsplit_by_sid ?? mB.node_pressure_by_sid;
      for (const [sid, v] of Object.entries(distObj)) {
        const c = seed.cluster_by_sid[sid];
        if (c === 'A') sumA += v;
        else if (c === 'B') sumB += v;
      }
      clusterAShareB = SEED_TOTAL_PRESSURE > 0 ? sumA / SEED_TOTAL_PRESSURE : 0;
      clusterBShareB = SEED_TOTAL_PRESSURE > 0 ? sumB / SEED_TOTAL_PRESSURE : 0;
    }

    lines.push(
      String(mA.turn).padEnd(6) +
      mA.pressure_sum.toFixed(2).padEnd(14) +
      mB.pressure_sum.toFixed(2).padEnd(14) +
      String(mA.nonzero_nodes).padEnd(11) +
      String(mB.nonzero_nodes).padEnd(11) +
      mA.top1_pressure.toFixed(2).padEnd(12) +
      mB.top1_pressure.toFixed(2).padEnd(12) +
      mA.top5_share.toFixed(4).padEnd(13) +
      mB.top5_share.toFixed(4).padEnd(13) +
      l1DistAB.toFixed(2).padEnd(12) +
      (isWeaklink ? clusterAShareB.toFixed(4).padEnd(16) + clusterBShareB.toFixed(4).padEnd(16) : '') +
      String(Boolean(mB.diffusion_applied)).padEnd(13)
    );

    if (mB.diffusion_stats) {
      diffusionStatsLines.push(
        `Turn ${mB.turn}: diffusion_applied=${Boolean(mB.diffusion_applied)} ` +
        `nodes_with_outflow=${mB.diffusion_stats.nodes_with_outflow} ` +
        `total_outflow=${mB.diffusion_stats.total_outflow.toFixed(6)} ` +
        `total_inflow=${mB.diffusion_stats.total_inflow.toFixed(6)} ` +
        `conserved_error_fix_applied=${mB.diffusion_stats.conserved_error_fix_applied} ` +
        `l1_pre_post=${(mB.l1_pre_post_diffusion ?? 0).toFixed(2)}`
      );
    } else {
      diffusionStatsLines.push(`Turn ${mB.turn}: diffusion_applied=${Boolean(mB.diffusion_applied)}`);
    }
  }

  lines.push('');
  lines.push('='.repeat(80));
  lines.push('');

  const finalA = metricsA[metricsA.length - 1];
  const finalB = metricsB[metricsB.length - 1];
  const nonZeroDelta = finalB.nonzero_nodes - finalA.nonzero_nodes;
  const top1Delta = finalB.top1_pressure - finalA.top1_pressure;

  lines.push('Summary:');
  lines.push('-'.repeat(80));
  lines.push(`Final pressure_sum A: ${finalA.pressure_sum.toFixed(2)}`);
  lines.push(`Final pressure_sum B: ${finalB.pressure_sum.toFixed(2)}`);
  lines.push(`Final NonZero A: ${finalA.nonzero_nodes}, B: ${finalB.nonzero_nodes}, delta: ${nonZeroDelta}`);
  lines.push(`Final Top1 A: ${finalA.top1_pressure.toFixed(2)}, B: ${finalB.top1_pressure.toFixed(2)}, delta: ${top1Delta.toFixed(2)}`);
  lines.push('');

  lines.push('Diffusion proof (Run B):');
  lines.push('-'.repeat(80));
  lines.push('Per-turn diffusion stats (compact):');
  for (const s of diffusionStatsLines) lines.push(`  ${s}`);
  lines.push('');

  // Edge spotlight (top 5 from final turn of B)
  if (finalB.top_strongest_edges.length > 0) {
    lines.push('='.repeat(80));
    lines.push('Edge Spotlight (Top 5 Strongest Eligible Edges - Run B, Final Turn):');
    lines.push('-'.repeat(80));
    for (const edge of finalB.top_strongest_edges) {
      const typeStr = edge.type || 'unknown';
      lines.push(`  ${edge.a} <-> ${edge.b} (${typeStr}): w=${edge.w.toFixed(4)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const turns = 18;

  const enriched = await loadEnrichedContactGraph();
  const raw = enriched.edges.map((e) => ({ a: e.a, b: e.b }));
  const settlementEdges = raw.sort((x, y) => {
    if (x.a !== y.a) return x.a.localeCompare(y.a);
    return x.b.localeCompare(y.b);
  });

  let selectedScenario: { id: string; name: string; factory: ScenarioFactory } | null = null;
  for (const scenario of SCENARIO_REGISTRY) {
    const pressureSum = await probeScenario(scenario.factory, settlementEdges);
    if (pressureSum > 0) {
      selectedScenario = scenario;
      break;
    }
  }

  let initialState: GameState;
  let scenarioName: string;
  let scenarioId: string;
  let selectionMethod: 'auto_nonzero_fixture' | 'seed_fallback';
  let seededSids: string[] | null = null;
  let seedValue: number | null = null;

  if (selectedScenario) {
    // Use selected scenario
    initialState = selectedScenario.factory();
    scenarioName = selectedScenario.name;
    scenarioId = selectedScenario.id;
    selectionMethod = 'auto_nonzero_fixture';
  } else {
    // Fallback: use prolonged siege with seed
    initialState = createProlongedSiegeState();
    scenarioName = 'Prolonged siege (calibration scenario 1)';
    scenarioId = 'prolonged_siege';
    selectionMethod = 'seed_fallback';
    
    // Legacy fields retained for backward compatibility in report selection line.
    seededSids = null;
    seedValue = null;
  }

  await mkdir(resolve('data/derived/_debug'), { recursive: true });

  // Build Phase 3A effective edges once (neutral builder; current state accessors are conservative).
  const accessors0 = buildStateAccessors(initialState);
  const eff0 = buildPressureEligibilityPhase3A(enriched, initialState, accessors0, false);

  const variants: Array<{ seed: BfsSeedContext; reportPath: string }> = [
    {
      seed: buildBfsSeedContextFromEffectiveEdges(eff0.edgesEffective, SEED_BFS_N),
      reportPath: resolve('data/derived/_debug/phase3a_pressure_ab_report_bfs.txt')
    },
    {
      seed: buildBottleneckTwoClusterSeedContext(eff0.edgesEffective as any, 15, 10),
      reportPath: resolve('data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt')
    },
    {
      seed: buildWeaklinkTwoClusterSeedContext(eff0.edgesEffective as any, 15, 10),
      reportPath: resolve('data/derived/_debug/phase3a_pressure_ab_report_weaklink.txt')
    }
  ];

  for (const variant of variants) {
    const seededState = JSON.parse(JSON.stringify(initialState)) as GameState;
    applySeedIntoFrontPressure(seededState, variant.seed);

    // IMPORTANT: For deterministic proof, Run B uses the same pipeline as A but applies
    // Phase 3A diffusion explicitly (with strict namespace mismatch errors) on the
    // canonical pressure field `state.front_pressure` after each turn.
    const metricsA = await runScenario(seededState, false, false, turns, settlementEdges, variant.seed);
    const metricsB = await runScenario(seededState, true, true, turns, settlementEdges, variant.seed);

    const reportText = formatReport(
      scenarioName,
      scenarioId,
      selectionMethod,
      seededSids,
      seedValue,
      metricsA,
      metricsB,
      PHASE3A_PARAMS,
      variant.seed
    );

    await writeFile(variant.reportPath, reportText, 'utf8');

    process.stdout.write(`Phase 3A A/B harness complete\n`);
    process.stdout.write(`  Scenario: ${scenarioName} (${scenarioId})\n`);
    process.stdout.write(`  Selection: ${selectionMethod}\n`);
    process.stdout.write(
      `  Seed: ${variant.seed.seed_method} N=${variant.seed.N} start_sid=${variant.seed.start_sid} total=${SEED_TOTAL_PRESSURE}\n`
    );
    process.stdout.write(`  Report: ${variant.reportPath}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
