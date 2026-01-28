/**
 * Phase 3A–3C Audit Harness (deterministic)
 *
 * Runs 4 deterministic scenarios (A–D) for 40 turns and writes per-turn reports to:
 *   data/derived/_debug/phase3abc_audit_report_*.txt
 *
 * Notes:
 * - Deterministic: no randomness, no timestamps, stable ordering everywhere.
 * - Mechanics are not changed. This is audit tooling only.
 * - Phase 3B / 3C are not implemented in code (as of this harness); the harness detects this
 *   and prints "not implemented" notes while still reporting Phase 3A metrics.
 */
 
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameState } from '../state/game_state.js';
import { CURRENT_SCHEMA_VERSION } from '../state/game_state.js';
import { runTurn } from '../sim/turn_pipeline.js';
import {
  setEnablePhase3A,
  resetEnablePhase3A,
  loadEnrichedContactGraph,
  buildPressureEligibilityPhase3A,
  buildStateAccessors,
  PHASE3A_PARAMS,
  type Phase3AAuditSummary
} from '../sim/pressure/phase3a_pressure_eligibility.js';
import {
  setEnablePhase3ADiffusion,
  resetEnablePhase3ADiffusion,
  runPhase3APressureDiffusionWithResult,
  type Phase3ADiffusionResult
} from '../sim/pressure/phase3a_pressure_diffusion.js';
 
loadMistakes();
assertNoRepeat('phase3abc audit harness must not print fake exhaustion columns when phase3b is not implemented');
assertNoRepeat('phase3abc audit harness file must be tracked and scripts must not diverge between ts-node and tsx');
assertNoRepeat('verify staged diff is limited to audit harness hygiene and does not reintroduce fake phase3b metrics');
 
const TURNS = 40;
const REPORT_DIR = resolve('data/derived/_debug');
const EPS = 1e-6;
const SEED_TOTAL_PRESSURE = 100;
 
function canonicalEdgeId(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}
 
function parseEdgeId(edgeId: string): [string, string] | null {
  const idx = edgeId.indexOf('__');
  if (idx <= 0 || idx === edgeId.length - 2) return null;
  const a = edgeId.slice(0, idx);
  const b = edgeId.slice(idx + 2);
  return a && b ? [a, b] : null;
}
 
type EdgePair = { a: string; b: string };
 
interface SeedEdgeAttribution {
  fracA: number;
  fracB: number;
  a: string;
  b: string;
}
 
interface BfsSeedContext {
  seed_method: 'bfs_connected_nodes_v1' | 'weaklink_two_cluster_v1';
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
  weaklink_edge?: { a: string; b: string; type: string; w: number };
  weaklink_index?: number;
  weaklink_n?: number;
  allocation_total_before_normalize?: number;
  allocation_total_after_normalize?: number;
}
 
function computeEdgePressureSumAbs(state: GameState): number {
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') return 0;
  const keys = Object.keys(fp).sort((a, b) => a.localeCompare(b));
  let sum = 0;
  for (const k of keys) {
    const rec = (fp as any)[k];
    if (rec && typeof rec === 'object' && typeof rec.value === 'number') {
      sum += Math.abs(rec.value);
    }
  }
  return sum;
}
 
function computeNonZeroEdges(state: GameState): number {
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') return 0;
  const keys = Object.keys(fp).sort((a, b) => a.localeCompare(b));
  let c = 0;
  for (const k of keys) {
    const rec = (fp as any)[k];
    if (rec && typeof rec === 'object' && typeof rec.value === 'number') {
      if (Math.abs(rec.value) > 0) c += 1;
    }
  }
  return c;
}
 
function computeTop1AndTop5Share(state: GameState): { top1: number; top5Share: number } {
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') return { top1: 0, top5Share: 0 };
  const vals: number[] = [];
  for (const k of Object.keys(fp)) {
    const rec = (fp as any)[k];
    if (rec && typeof rec === 'object' && typeof rec.value === 'number') {
      vals.push(Math.abs(rec.value));
    }
  }
  vals.sort((a, b) => b - a);
  const sum = vals.reduce((acc, v) => acc + v, 0);
  const top1 = vals[0] ?? 0;
  const top5 = vals.slice(0, 5).reduce((acc, v) => acc + v, 0);
  const top5Share = sum > 0 ? top5 / sum : 0;
  return { top1, top5Share };
}
 
function computeDiffAppliedFlagAndInvariant(
  state: GameState,
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number }>,
  iterations: number
): { applied: boolean; stats?: Phase3ADiffusionResult['stats']; sum_before: number; sum_after: number } {
  const before = computeEdgePressureSumAbs(state);
  let last: Phase3ADiffusionResult | null = null;
  for (let k = 0; k < iterations; k++) {
    last = runPhase3APressureDiffusionWithResult(state, effectiveEdges as any, { strict_namespace: true });
  }
  const after = computeEdgePressureSumAbs(state);
  if (Math.abs(after - before) > EPS) {
    throw new Error(`Invariant fail: Pressure conservation violated (|after-before|=${Math.abs(after - before)})`);
  }
  return { applied: Boolean(last?.applied), stats: last?.stats, sum_before: before, sum_after: after };
}
 
function buildBfsSeedContextFromEffectiveEdges(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number }>,
  N: number
): BfsSeedContext {
  const eligible = effectiveEdges
    .filter((e) => e && e.eligible && e.w > 0 && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b }));
  if (eligible.length === 0) throw new Error('phase3abc seed: no eligible effective edges available for BFS seeding');
 
  let start_sid = '';
  for (const e of eligible) {
    if (start_sid === '' || e.a.localeCompare(start_sid) < 0) start_sid = e.a;
    if (e.b.localeCompare(start_sid) < 0) start_sid = e.b;
  }
  if (start_sid === '') throw new Error('phase3abc seed: failed to determine BFS start_sid');
 
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
    }
  }
  if (nodes_bfs.length < N) throw new Error(`phase3abc seed: BFS produced only ${nodes_bfs.length} nodes (expected N=${N})`);
 
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
 
  const children = nodes_bfs
    .filter((sid) => parent_by_sid[sid] === start_sid)
    .sort((a, b) => a.localeCompare(b));
  const root_first_child = children[0];
  if (!root_first_child) throw new Error(`phase3abc seed: BFS root ${start_sid} has no child`);
 
  const tree_edge_ids = new Set<string>();
  const contribA: Record<string, number> = {};
  const contribB: Record<string, number> = {};
  for (const sid of nodes_bfs) {
    if (sid === start_sid) continue;
    const p = parent_by_sid[sid];
    if (!p) continue;
    const eid = canonicalEdgeId(p, sid);
    if (!edgeSet.has(eid)) throw new Error(`phase3abc seed: missing effective edge for tree link ${p} <-> ${sid}`);
    tree_edge_ids.add(eid);
    contribA[eid] = contribA[eid] ?? 0;
    contribB[eid] = contribB[eid] ?? 0;
  }
 
  const addContribution = (eid: string, sid: string, amount: number) => {
    if (amount <= 0) return;
    const pair = parseEdgeId(eid) ?? (() => {
      const idx = eid.indexOf('__');
      return [eid.slice(0, idx), eid.slice(idx + 2)] as [string, string];
    })();
    const [a, b] = pair;
    if (sid === a) contribA[eid] = (contribA[eid] ?? 0) + amount;
    else if (sid === b) contribB[eid] = (contribB[eid] ?? 0) + amount;
    else throw new Error(`phase3abc seed: contribution sid ${sid} not on edge ${eid}`);
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
    if (!pair) throw new Error(`phase3abc seed: invalid tree edge id ${eid}`);
    const [a, b] = pair;
    const ca = contribA[eid] ?? 0;
    const cb = contribB[eid] ?? 0;
    const tot = ca + cb;
    tree_edge_attribution.set(eid, { a, b, fracA: tot > 0 ? ca / tot : 0.5, fracB: tot > 0 ? cb / tot : 0.5 });
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
 
function typePriority(t: string): number {
  if (t === 'shared_border') return 0;
  if (t === 'point_touch') return 1;
  if (t === 'distance_contact') return 2;
  return 3;
}
 
function buildWeaklinkTwoClusterSeedContext(
  effectiveEdges: Array<{ a: string; b: string; eligible: boolean; w: number; type?: string }>,
  NA: number,
  NB: number
): BfsSeedContext {
  const candidates = effectiveEdges
    .filter((e) => e && e.eligible && typeof e.w === 'number' && e.w > 0 && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, type: (e as any).type ?? 'unknown' }));
  if (candidates.length === 0) throw new Error('phase3abc weaklink seed: no eligible edges with w>0 found');
 
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
  const eligible = effectiveEdges
    .filter((e) => e && e.eligible && typeof e.a === 'string' && typeof e.b === 'string' && e.a !== e.b)
    .map((e) => ({ a: e.a, b: e.b, w: e.w, type: (e as any).type ?? 'unknown' }));
  if (eligible.length === 0) throw new Error('phase3abc two-cluster seed: no eligible effective edges found');
 
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
  if (A_nodes_bfs.length < NA) throw new Error(`phase3abc two-cluster seed: Cluster A only ${A_nodes_bfs.length} nodes (need NA=${NA})`);
  const A_set = new Set<string>(A_nodes_bfs);
 
  const B_nodes_bfs: string[] = [];
  for (const sid of clusterBFull.order) {
    if (sid === u) continue;
    if (A_set.has(sid)) continue;
    B_nodes_bfs.push(sid);
    if (B_nodes_bfs.length >= NB) break;
  }
  if (B_nodes_bfs.length < NB) throw new Error(`phase3abc two-cluster seed: Cluster B only ${B_nodes_bfs.length} nodes (need NB=${NB})`);
 
  const nodes_bfs = [...A_nodes_bfs, ...B_nodes_bfs];
  const nodes_sorted = [...nodes_bfs].sort((a, b) => a.localeCompare(b));
 
  const cluster_by_sid: Record<string, 'A' | 'B'> = {};
  for (const sid of A_nodes_bfs) cluster_by_sid[sid] = 'A';
  for (const sid of B_nodes_bfs) cluster_by_sid[sid] = 'B';
 
  const pv_by_sid: Record<string, number> = {};
  for (const sid of nodes_sorted) pv_by_sid[sid] = 0;
  const A_sorted = [...A_nodes_bfs].sort((a, b) => a.localeCompare(b));
  const B_sorted = [...B_nodes_bfs].sort((a, b) => a.localeCompare(b));
 
  // Allocation: A(30 + 6*5 + 8*1), B(15 + 4*3 + 5*1), then normalize down to total=100.
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
  if (total < SEED_TOTAL_PRESSURE) throw new Error(`phase3abc two-cluster seed: total ${total} < ${SEED_TOTAL_PRESSURE}`);
  let guard = 0;
  while (total > SEED_TOTAL_PRESSURE) {
    const sid = seededDesc.find((s) => (pv_by_sid[s] ?? 0) > 0);
    if (!sid) throw new Error('phase3abc two-cluster seed: cannot normalize');
    pv_by_sid[sid] -= 1;
    total -= 1;
    guard += 1;
    if (guard > 1000) throw new Error('phase3abc two-cluster seed: normalization guard tripped');
  }
 
  let pvTotalOverNodes = 0;
  for (const sid of nodes_bfs) pvTotalOverNodes += pv_by_sid[sid] ?? 0;
  if (pvTotalOverNodes !== SEED_TOTAL_PRESSURE) throw new Error(`phase3abc two-cluster seed: pv_total_over_nodes_bfs=${pvTotalOverNodes} (expected ${SEED_TOTAL_PRESSURE})`);
 
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
    if (!c) throw new Error(`phase3abc two-cluster seed: root ${root} has no child in cluster ${cluster}`);
    return c;
  };
  const root_first_child_A = rootFirstChild(u, 'A');
  const root_first_child_B = rootFirstChild(v, 'B');
 
  const ensureEdge = (a: string, b: string): string => {
    const eid = canonicalEdgeId(a, b);
    if (!edgeSet.has(eid)) throw new Error(`phase3abc two-cluster seed: missing effective edge ${a} <-> ${b}`);
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
    if (!pair) throw new Error(`phase3abc two-cluster seed: invalid edge id ${eid}`);
    const [a, b] = pair;
    if (sid === a) contribA[eid] = (contribA[eid] ?? 0) + amount;
    else if (sid === b) contribB[eid] = (contribB[eid] ?? 0) + amount;
    else throw new Error(`phase3abc two-cluster seed: contribution sid ${sid} not on edge ${eid}`);
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
    if (!pair) throw new Error(`phase3abc two-cluster seed: invalid tree edge id ${eid}`);
    const [a, b] = pair;
    const ca = contribA[eid] ?? 0;
    const cb = contribB[eid] ?? 0;
    const tot = ca + cb;
    tree_edge_attribution.set(eid, { a, b, fracA: tot > 0 ? ca / tot : 0.5, fracB: tot > 0 ? cb / tot : 0.5 });
  }
 
  return {
    seed_method: 'bottleneck_two_cluster_v1' as any, // overwritten by caller for weaklink; kept for structure compatibility
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
    allocation_total_before_normalize: totalBefore,
    allocation_total_after_normalize: total
  };
}
 
function applySeedIntoFrontPressure(state: GameState, seed: BfsSeedContext): void {
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
    const child = seed.root_first_child_by_root[sid];
    if (!child) throw new Error(`phase3abc seed: root ${sid} missing root_first_child mapping`);
    const eid = canonicalEdgeId(sid, child);
    edgeValue[eid] = (edgeValue[eid] ?? 0) + pv;
  }
 
  let total = 0;
  for (const v of Object.values(edgeValue)) total += v;
  if (total !== SEED_TOTAL_PRESSURE) throw new Error(`phase3abc seed: expected total ${SEED_TOTAL_PRESSURE}, got ${total}`);
 
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
 
type ScenarioId = 'A' | 'B' | 'C' | 'D';
type ScenarioSpec = { id: ScenarioId; name: string; filename: string; build: (ctx: ScenarioBuildContext) => Promise<ScenarioBuilt> };
type ScenarioBuilt = { initialState: GameState; seed: BfsSeedContext; postureProgram?: (state: GameState, turn: number, seed: BfsSeedContext) => void };
type ScenarioBuildContext = {
  enrichedEdges: Array<{ a: string; b: string }>;
  effectiveEdgesForSeed: Array<{ a: string; b: string; eligible: boolean; w: number; type?: string }>;
};
 
function createBaseState(seedName: string): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: { turn: 0, seed: seedName },
    factions: [
      {
        id: 'FACTION_A',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: [],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      },
      {
        id: 'FACTION_B',
        profile: { authority: 50, legitimacy: 50, control: 50, logistics: 50, exhaustion: 0 },
        areasOfResponsibility: [],
        supply_sources: [],
        negotiation: { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null }
      }
    ],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {},
    displacement_state: {}
  };
}
 
function setAllSeedEdgesPosture(
  state: GameState,
  seed: BfsSeedContext,
  factionId: 'FACTION_A' | 'FACTION_B',
  posture: 'hold' | 'probe' | 'push',
  weight: number
): void {
  if (!state.front_posture || typeof state.front_posture !== 'object') state.front_posture = {};
  if (!(state.front_posture as any)[factionId]) (state.front_posture as any)[factionId] = { assignments: {} };
  if (!((state.front_posture as any)[factionId].assignments)) (state.front_posture as any)[factionId].assignments = {};
  const assignments = (state.front_posture as any)[factionId].assignments as Record<string, { posture: string; weight: number }>;
 
  const edgeIds = [...seed.tree_edge_ids].sort((a, b) => a.localeCompare(b));
  for (const eid of edgeIds) {
    assignments[eid] = { posture, weight };
  }
  // Include weaklink connector if present (even if it was zero-valued initially).
  if (seed.seed_method === 'weaklink_two_cluster_v1' && seed.weaklink_edge) {
    const eid = canonicalEdgeId(seed.weaklink_edge.a, seed.weaklink_edge.b);
    assignments[eid] = { posture, weight };
  }
}
 
const SCENARIOS: ScenarioSpec[] = [
  {
    id: 'A',
    name: 'static_symmetric',
    filename: 'phase3abc_audit_report_A_static_symmetric.txt',
    build: async (ctx) => {
      const seed = buildBfsSeedContextFromEffectiveEdges(ctx.effectiveEdgesForSeed, 25);
      const state = createBaseState('phase3abc-A-static-symmetric');
      applySeedIntoFrontPressure(state, seed);
 
      // Supply present for both sides (avoid supply penalties); no posture intent => static pressure except diffusion.
      const a = state.factions.find((f) => f.id === 'FACTION_A')!;
      const b = state.factions.find((f) => f.id === 'FACTION_B')!;
      const aSrc = [...a.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      const bSrc = [...b.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      a.supply_sources = aSrc ? [aSrc] : [];
      b.supply_sources = bSrc ? [bSrc] : [];
      // Keep posture empty => intent 0.
      return { initialState: state, seed };
    }
  },
  {
    id: 'B',
    name: 'static_brittle_supply',
    filename: 'phase3abc_audit_report_B_static_brittle_supply.txt',
    build: async (ctx) => {
      const seed = buildBfsSeedContextFromEffectiveEdges(ctx.effectiveEdgesForSeed, 25);
      const state = createBaseState('phase3abc-B-static-brittle-supply');
      applySeedIntoFrontPressure(state, seed);
 
      // Brittle supply: FACTION_A unsupplied and pushing; FACTION_B supplied and holding.
      const a = state.factions.find((f) => f.id === 'FACTION_A')!;
      const b = state.factions.find((f) => f.id === 'FACTION_B')!;
      a.supply_sources = [];
      const bSrc = [...b.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      b.supply_sources = bSrc ? [bSrc] : [];
 
      setAllSeedEdgesPosture(state, seed, 'FACTION_A', 'push', 1);
      setAllSeedEdgesPosture(state, seed, 'FACTION_B', 'hold', 0);
      return { initialState: state, seed };
    }
  },
  {
    id: 'C',
    name: 'weaklink_clusters',
    filename: 'phase3abc_audit_report_C_weaklink_clusters.txt',
    build: async (ctx) => {
      const seed = buildWeaklinkTwoClusterSeedContext(ctx.effectiveEdgesForSeed, 15, 10);
      const state = createBaseState('phase3abc-C-weaklink-clusters');
      applySeedIntoFrontPressure(state, seed);
 
      // No additional pressure generation; diffusion should gradually leak across weaklink (if nonzero after rounding).
      const a = state.factions.find((f) => f.id === 'FACTION_A')!;
      const b = state.factions.find((f) => f.id === 'FACTION_B')!;
      const aSrc = [...a.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      const bSrc = [...b.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      a.supply_sources = aSrc ? [aSrc] : [];
      b.supply_sources = bSrc ? [bSrc] : [];
      return { initialState: state, seed };
    }
  },
  {
    id: 'D',
    name: 'spike_then_relief',
    filename: 'phase3abc_audit_report_D_spike_then_relief.txt',
    build: async (ctx) => {
      const seed = buildBfsSeedContextFromEffectiveEdges(ctx.effectiveEdgesForSeed, 25);
      const state = createBaseState('phase3abc-D-spike-then-relief');
      applySeedIntoFrontPressure(state, seed);
 
      // Both sides supplied. FACTION_A pushes for first 10 turns, then holds (relief).
      const a = state.factions.find((f) => f.id === 'FACTION_A')!;
      const b = state.factions.find((f) => f.id === 'FACTION_B')!;
      const aSrc = [...a.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      const bSrc = [...b.areasOfResponsibility].sort((x, y) => x.localeCompare(y))[0];
      a.supply_sources = aSrc ? [aSrc] : [];
      b.supply_sources = bSrc ? [bSrc] : [];
 
      const postureProgram = (s: GameState, turn: number, sd: BfsSeedContext) => {
        if (turn <= 10) {
          setAllSeedEdgesPosture(s, sd, 'FACTION_A', 'push', 1);
          setAllSeedEdgesPosture(s, sd, 'FACTION_B', 'hold', 0);
        } else {
          setAllSeedEdgesPosture(s, sd, 'FACTION_A', 'hold', 0);
          setAllSeedEdgesPosture(s, sd, 'FACTION_B', 'hold', 0);
        }
      };
 
      postureProgram(state, 0, seed);
      return { initialState: state, seed, postureProgram };
    }
  }
];
 
function hasPhase3BImplementation(): boolean {
  // As of now, there are no Phase 3B modules in src/ (spec exists in docs only).
  return false;
}
 
function hasPhase3CImplementation(): boolean {
  // As of now, there are no Phase 3C modules in src/ (spec exists in docs only).
  return false;
}
 
function formatEligibleDomainLine(label: string): string {
  return `  ${label}: not implemented`;
}
 
function formatPerTurnRow(
  turn: number,
  pressureSum: number,
  nonZeroEdges: number,
  top1: number,
  top5Share: number,
  diffApplied: boolean,
  includeExhaustion: boolean,
  exhaustionDeltaByFaction: Array<{ faction_id: string; delta: number }>,
  exhaustionDeltaMaxEdge: number,
  edgesGeneratingExhaustionCount: number,
  phase3aAudit?: Phase3AAuditSummary
): string {
  const parts: string[] = [];
  parts.push(String(turn).padEnd(6));
  parts.push(pressureSum.toFixed(2).padEnd(14));
  parts.push(String(nonZeroEdges).padEnd(13));
  parts.push(top1.toFixed(2).padEnd(10));
  parts.push(top5Share.toFixed(4).padEnd(12));
  parts.push(String(diffApplied).padEnd(12));
 
  if (includeExhaustion) {
    // Exhaustion deltas: stable order by faction_id
    const ex = [...exhaustionDeltaByFaction].sort((a, b) => a.faction_id.localeCompare(b.faction_id));
    const exStr = ex.map((x) => `${x.faction_id}:${x.delta}`).join(',');
    parts.push(exStr.padEnd(28));
    parts.push(String(exhaustionDeltaMaxEdge).padEnd(22));
    parts.push(String(edgesGeneratingExhaustionCount).padEnd(28));
  }
 
  if (phase3aAudit) {
    const sb = phase3aAudit.eligible_by_type.shared_border.eligible;
    const pt = phase3aAudit.eligible_by_type.point_touch.eligible;
    const dc = phase3aAudit.eligible_by_type.distance_contact.eligible;
    parts.push(String(sb).padEnd(10));
    parts.push(String(pt).padEnd(10));
    parts.push(String(dc).padEnd(10));
  } else {
    parts.push('0'.padEnd(10));
    parts.push('0'.padEnd(10));
    parts.push('0'.padEnd(10));
  }
 
  return parts.join('');
}
 
async function runScenarioAndWriteReport(s: ScenarioSpec): Promise<void> {
  // Phase 3A is required for this harness.
  setEnablePhase3A(true);
  // Keep pipeline diffusion OFF; harness applies diffusion explicitly and checks conservation.
  setEnablePhase3ADiffusion(false);
 
  try {
    const enriched = await loadEnrichedContactGraph();
    const edges = enriched.edges
      .map((e) => ({ a: e.a, b: e.b }))
      .sort((x, y) => (x.a !== y.a ? x.a.localeCompare(y.a) : x.b.localeCompare(y.b)));
 
    // Build effective edges for seeding (auditEnabled true for stable per-turn eligibility counts).
    const stubState = createBaseState('phase3abc-seed-builder');
    const accessors0 = buildStateAccessors(stubState);
    const eff0 = buildPressureEligibilityPhase3A(enriched, stubState, accessors0, true);
 
    const built = await s.build({ enrichedEdges: edges, effectiveEdgesForSeed: eff0.edgesEffective as any });
    let state = JSON.parse(JSON.stringify(built.initialState)) as GameState;
 
    const lines: string[] = [];
    lines.push('='.repeat(80));
    lines.push('Phase 3A–3C Audit Harness Report');
    lines.push('='.repeat(80));
    lines.push('');
    lines.push('report_format_version: phase3abc_v1');
    lines.push(`scenario_id: ${s.id}`);
    lines.push(`scenario_name: ${s.name}`);
    lines.push(`turns: ${TURNS}`);
    lines.push('');
    lines.push('Phase 3A Parameters:');
    lines.push(`  E_collapse: ${PHASE3A_PARAMS.E_collapse}`);
    lines.push(`  C_floor: ${PHASE3A_PARAMS.C_floor}`);
    lines.push(`  B_sb: ${PHASE3A_PARAMS.B_sb}`);
    lines.push(`  B_pt: ${PHASE3A_PARAMS.B_pt}`);
    lines.push(`  B_dc: ${PHASE3A_PARAMS.B_dc}`);
    lines.push(`  D_scale: ${PHASE3A_PARAMS.D_scale}`);
    lines.push(`  O_ref: ${PHASE3A_PARAMS.O_ref}`);
    lines.push(`  f_shape_min: ${PHASE3A_PARAMS.f_shape_min}`);
    lines.push(`  f_missing_distance: ${PHASE3A_PARAMS.f_missing_distance}`);
    lines.push('');
    lines.push('Seed:');
    lines.push(`  seed_method: ${built.seed.seed_method}`);
    lines.push(`  N: ${built.seed.N}`);
    lines.push(`  start_sid: ${built.seed.start_sid}`);
    lines.push(`  initial_nonzero_nodes: ${built.seed.initially_nonzero_nodes}`);
    if (built.seed.seed_method === 'weaklink_two_cluster_v1' && built.seed.weaklink_edge) {
      lines.push(`  weaklink_edge: ${built.seed.weaklink_edge.a}__${built.seed.weaklink_edge.b} (${built.seed.weaklink_edge.type}, w=${built.seed.weaklink_edge.w.toFixed(6)})`);
      lines.push(`  weaklink_index: ${built.seed.weaklink_index} of n=${built.seed.weaklink_n}`);
    }
    if (built.seed.allocation_total_before_normalize !== undefined) {
      lines.push(`  allocation_total_before_normalize: ${built.seed.allocation_total_before_normalize}`);
      lines.push(`  allocation_total_after_normalize: ${built.seed.allocation_total_after_normalize}`);
    }
    lines.push('');
 
    const phase3bImpl = hasPhase3BImplementation();
    const phase3cImpl = hasPhase3CImplementation();
    lines.push('Phase 3B status: ' + (phase3bImpl ? 'implemented' : 'not implemented'));
    lines.push('Phase 3C status: ' + (phase3cImpl ? 'implemented' : 'not implemented'));
    lines.push('NOTE: Only Phase 3A is executed unless Phase 3B/3C implementations are detected.');
    lines.push('');
 
    lines.push('Per-turn columns:');
    if (phase3bImpl) {
      lines.push(
        '  Turn, PressureSum, NonZeroEdges, Top1, Top5Share, DiffApplied, ExhaustionDeltaTotal(per faction), ExhaustionDeltaMaxEdge, EdgesGeneratingExhaustionCount, Eligible(shared_border), Eligible(point_touch), Eligible(distance_contact)'
      );
    } else {
      lines.push('  Turn, PressureSum, NonZeroEdges, Top1, Top5Share, DiffApplied, Eligible(shared_border), Eligible(point_touch), Eligible(distance_contact)');
    }
    lines.push('');
    lines.push('-'.repeat(80));
    if (phase3bImpl) {
      lines.push(
        'Turn'.padEnd(6) +
        'PressureSum'.padEnd(14) +
        'NonZeroEdges'.padEnd(13) +
        'Top1'.padEnd(10) +
        'Top5Share'.padEnd(12) +
        'DiffApplied'.padEnd(12) +
        'ExhaustionDeltaTotal'.padEnd(28) +
        'ExhaustionDeltaMaxEdge'.padEnd(22) +
        'EdgesGeneratingExhaustionCount'.padEnd(28) +
        'EligSB'.padEnd(10) +
        'EligPT'.padEnd(10) +
        'EligDC'.padEnd(10)
      );
    } else {
      lines.push(
        'Turn'.padEnd(6) +
        'PressureSum'.padEnd(14) +
        'NonZeroEdges'.padEnd(13) +
        'Top1'.padEnd(10) +
        'Top5Share'.padEnd(12) +
        'DiffApplied'.padEnd(12) +
        'EligSB'.padEnd(10) +
        'EligPT'.padEnd(10) +
        'EligDC'.padEnd(10)
      );
    }
    lines.push('-'.repeat(80));
    if (!phase3bImpl) {
      lines.push('EXHAUSTION METRICS: NOT IMPLEMENTED (Phase 3B not detected)');
    }
 
    const exhaustionPrev = new Map<string, number>();
    if (phase3bImpl) {
      for (const f of (state.factions ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
        const ex = Number.isFinite(f.profile?.exhaustion) ? f.profile.exhaustion : 0;
        exhaustionPrev.set(f.id, ex);
      }
    }
 
    for (let t = 1; t <= TURNS; t++) {
      built.postureProgram?.(state, t, built.seed);
 
      const { nextState, report } = await runTurn(state, {
        seed: state.meta.seed,
        settlementEdges: edges as any,
        applyNegotiation: false
      });
      state = nextState;
 
      // Phase 3A effective edges for diffusion/metrics (rebuilt per turn to match current state).
      const accessors = buildStateAccessors(state);
      const eff = buildPressureEligibilityPhase3A(enriched, state, accessors, true);
      const phase3aAudit = report.phase3a_pressure_eligibility ?? eff.audit;
 
      // Apply diffusion explicitly and enforce pressure conservation.
      const iters = built.seed.seed_method === 'weaklink_two_cluster_v1' ? 5 : 1;
      const diffusion = computeDiffAppliedFlagAndInvariant(state, eff.edgesEffective as any, iters);
 
      const pressureSum = computeEdgePressureSumAbs(state);
      const nonZeroEdges = computeNonZeroEdges(state);
      const { top1, top5Share } = computeTop1AndTop5Share(state);
 
      // Exhaustion metrics (Phase 3B only)
      const exhaustionDeltaByFaction: Array<{ faction_id: string; delta: number }> = [];
      let exhaustionDeltaMaxEdge = 0;
      let edgesGeneratingExhaustionCount = 0;
      if (phase3bImpl) {
        if (report.exhaustion?.per_faction) {
          for (const x of [...report.exhaustion.per_faction].sort((a, b) => a.faction_id.localeCompare(b.faction_id))) {
            exhaustionDeltaByFaction.push({ faction_id: x.faction_id, delta: x.delta });
          }
        } else {
          // Deterministic default when report missing.
          for (const f of (state.factions ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
            exhaustionDeltaByFaction.push({ faction_id: f.id, delta: 0 });
          }
        }

        // Invariant: exhaustion monotonicity (implemented in accumulateExhaustion).
        for (const f of (state.factions ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
          const prev = exhaustionPrev.get(f.id) ?? 0;
          const cur = Number.isFinite(f.profile?.exhaustion) ? f.profile.exhaustion : 0;
          if (cur + EPS < prev) {
            throw new Error(`Invariant fail: Exhaustion decreased for ${f.id} (prev=${prev} cur=${cur})`);
          }
          exhaustionPrev.set(f.id, cur);
        }

        const deltas = report.front_pressure?.pressure_deltas;
        if (deltas && typeof deltas === 'object') {
          const keys = Object.keys(deltas).sort((a, b) => a.localeCompare(b));
          for (const k of keys) {
            const v = (deltas as any)[k];
            if (!Number.isInteger(v)) continue;
            const av = Math.abs(v);
            if (av > 0) edgesGeneratingExhaustionCount += 1;
            if (av > exhaustionDeltaMaxEdge) exhaustionDeltaMaxEdge = av;
          }
        }
      }
 
      const row = formatPerTurnRow(
        state.meta.turn,
        pressureSum,
        nonZeroEdges,
        top1,
        top5Share,
        Boolean(diffusion.applied),
        phase3bImpl,
        exhaustionDeltaByFaction,
        exhaustionDeltaMaxEdge,
        edgesGeneratingExhaustionCount,
        phase3aAudit
      );
      lines.push(row);
    }
 
    lines.push('');
    lines.push('Phase 3B / 3C eligibility metrics:');
    if (!phase3bImpl) {
      lines.push(formatEligibleDomainLine('EligibleCount/NewlyEligibleCount authority'));
      lines.push(formatEligibleDomainLine('EligibleCount/NewlyEligibleCount cohesion'));
      lines.push(formatEligibleDomainLine('EligibleCount/NewlyEligibleCount spatial'));
    }
    if (!phase3cImpl) {
      lines.push(formatEligibleDomainLine('suppression/immunity counts'));
      lines.push(formatEligibleDomainLine('eligibility persistence >= N and degradation reasons'));
      lines.push('eligibility persistence >= N and degradation reasons: skipped (Phase 3C not detected)');
    } else {
      // Phase 3C could be implemented without reasons wired into the audit report output contract yet.
      // Keep this deterministic and explicit; do not guess reasons.
      const reasonsAvailable = false;
      if (!reasonsAvailable) {
        lines.push('eligibility persistence >= N and degradation reasons: skipped (reasons unavailable)');
      }
    }
    lines.push('');
    lines.push('Invariants enforced:');
    lines.push(`  - Pressure conservation when diffusion applied (EPS=${EPS})`);
    lines.push(phase3bImpl ? '- Exhaustion monotonicity: enforced' : '- Exhaustion monotonicity: skipped (Phase 3B not detected)');
    lines.push('  - Eligibility persistence/reasons (only if Phase 3C implemented and reasons available)');
    lines.push('');
 
    await mkdir(REPORT_DIR, { recursive: true });
    const outPath = resolve(REPORT_DIR, s.filename);
    await writeFile(outPath, lines.join('\n'), 'utf8');
 
    process.stdout.write(`Phase 3A–3C audit scenario ${s.id} complete: ${outPath}\n`);
  } finally {
    resetEnablePhase3A();
    resetEnablePhase3ADiffusion();
  }
}
 
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  for (const s of SCENARIOS) {
    await runScenarioAndWriteReport(s);
  }
  for (const s of SCENARIOS) {
    const p = resolve(REPORT_DIR, s.filename);
    const raw = await readFile(p, 'utf8');
    const h = sha256Hex(raw);
    process.stdout.write(`SHA256 ${s.id}: ${h}\n`);
  }
}
 
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
