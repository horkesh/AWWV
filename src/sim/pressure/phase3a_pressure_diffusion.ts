/**
 * Phase 3A: Bounded negative-sum pressure diffusion using effective edge weights.
 *
 * Feature-gated: ENABLE_PHASE3A_PRESSURE_DIFFUSION (default: false).
 * Diffusion runs only when BOTH eligibility and diffusion are enabled.
 *
 * Moves pressure along Phase 3A effective edges. Deterministic, conservative.
 */

import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import type { GameState } from '../../state/game_state.js';
import type { EffectivePressureEdge } from './phase3a_pressure_eligibility.js';

loadMistakes();
assertNoRepeat('phase3a diffusion harness uses canonical pressure field and proves nontrivial deltas');

const DIFFUSE_FRACTION = 0.05;
const DIFFUSE_MAX_OUTFLOW = 2.0;
const DIFFUSE_EPS = 1e-9;
const CONSERVATION_TOL = 1e-6;

let _enablePhase3ADiffusionOverride: boolean | null = null;

export function getEnablePhase3ADiffusion(): boolean {
  return _enablePhase3ADiffusionOverride !== null ? _enablePhase3ADiffusionOverride : false;
}

export function setEnablePhase3ADiffusion(enable: boolean): void {
  _enablePhase3ADiffusionOverride = enable;
}

export function resetEnablePhase3ADiffusion(): void {
  _enablePhase3ADiffusionOverride = null;
}

function parseEdgeId(edgeId: string): [string, string] | null {
  const idx = edgeId.indexOf('__');
  if (idx <= 0 || idx === edgeId.length - 2) return null;
  const a = edgeId.slice(0, idx);
  const b = edgeId.slice(idx + 2);
  return a && b ? [a, b] : null;
}

export interface Phase3ADiffusionResult {
  applied: boolean;
  reason_if_not_applied: string;
  stats: {
    nodes_with_outflow: number;
    total_outflow: number;
    total_inflow: number;
    conserved_error_fix_applied: boolean;
  };
}

/**
 * Deterministic wrapper that returns whether diffusion actually applied and compact stats.
 * Does NOT change diffusion behavior; it only exposes instrumentation.
 *
 * If strict_namespace is true, namespace mismatches throw (useful for harnesses/tests).
 * If strict_namespace is false, namespace mismatches return applied=false with reason.
 */
export function runPhase3APressureDiffusionWithResult(
  state: GameState,
  effectiveEdges: EffectivePressureEdge[],
  opts?: { strict_namespace?: boolean }
): Phase3ADiffusionResult {
  const strict = opts?.strict_namespace === true;

  try {
    return runPhase3APressureDiffusionInternal(state, effectiveEdges, strict);
  } catch (err) {
    // Preserve existing behavior when strict is requested.
    if (strict) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    const reason = msg.includes('not in Phase3A settlement namespace') ? 'namespace_mismatch' : 'error';
    return {
      applied: false,
      reason_if_not_applied: reason,
      stats: {
        nodes_with_outflow: 0,
        total_outflow: 0,
        total_inflow: 0,
        conserved_error_fix_applied: false
      }
    };
  }
}

/**
 * Run bounded diffusion on node-level pressure derived from front_pressure,
 * then map back to edges. Updates state.front_pressure in place.
 */
export function runPhase3APressureDiffusion(
  state: GameState,
  effectiveEdges: EffectivePressureEdge[]
): void {
  // Preserve existing production behavior (void-return, throws on hard errors).
  runPhase3APressureDiffusionInternal(state, effectiveEdges, true);
}

function runPhase3APressureDiffusionInternal(
  state: GameState,
  effectiveEdges: EffectivePressureEdge[],
  strictNamespace: boolean
): Phase3ADiffusionResult {
  const fp = state.front_pressure;
  if (!fp || typeof fp !== 'object') {
    return {
      applied: false,
      reason_if_not_applied: 'no_pressure_field',
      stats: { nodes_with_outflow: 0, total_outflow: 0, total_inflow: 0, conserved_error_fix_applied: false }
    };
  }

  const edgeIds = Object.keys(fp).filter((k) => {
    const v = (fp as Record<string, { value?: unknown }>)[k];
    return v && typeof v === 'object' && typeof (v as { value: number }).value === 'number';
  });
  edgeIds.sort((a, b) => a.localeCompare(b));

  if (edgeIds.length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_pressure',
      stats: { nodes_with_outflow: 0, total_outflow: 0, total_inflow: 0, conserved_error_fix_applied: false }
    };
  }

  const frontNodes = new Set<string>();
  for (const eid of edgeIds) {
    const pair = parseEdgeId(eid);
    if (pair) {
      frontNodes.add(pair[0]);
      frontNodes.add(pair[1]);
    }
  }

  const phase3aNodes = new Set<string>();
  for (const e of effectiveEdges) {
    phase3aNodes.add(e.a);
    phase3aNodes.add(e.b);
  }

  const firstKey = edgeIds[0];
  const firstPair = parseEdgeId(firstKey);
  if (!firstPair) {
    throw new Error(`Phase3A diffusion: invalid pressure key "${firstKey}"`);
  }
  if (!phase3aNodes.has(firstPair[0]) || !phase3aNodes.has(firstPair[1])) {
    if (strictNamespace) {
      throw new Error(
        `Phase3A diffusion: pressure key "${firstKey}" (sids ${firstPair[0]}, ${firstPair[1]}) not in Phase3A settlement namespace`
      );
    }
    return {
      applied: false,
      reason_if_not_applied: 'namespace_mismatch',
      stats: { nodes_with_outflow: 0, total_outflow: 0, total_inflow: 0, conserved_error_fix_applied: false }
    };
  }

  const eligible = effectiveEdges.filter(
    (e) => e.eligible && frontNodes.has(e.a) && frontNodes.has(e.b) && e.w >= 0 && e.w <= 1
  );
  if (eligible.length === 0) {
    return {
      applied: false,
      reason_if_not_applied: 'no_effective_edges',
      stats: { nodes_with_outflow: 0, total_outflow: 0, total_inflow: 0, conserved_error_fix_applied: false }
    };
  }

  const neighborWeights = new Map<string, Array<{ b: string; w: number }>>();
  for (const e of eligible) {
    const w = Math.max(0, Math.min(1, e.w));
    if (w < DIFFUSE_EPS) continue;
    if (!neighborWeights.has(e.a)) neighborWeights.set(e.a, []);
    neighborWeights.get(e.a)!.push({ b: e.b, w });
    if (!neighborWeights.has(e.b)) neighborWeights.set(e.b, []);
    neighborWeights.get(e.b)!.push({ b: e.a, w });
  }

  const nodes = [...frontNodes].sort((a, b) => a.localeCompare(b));
  const p: Record<string, number> = {};
  const pOld: Record<string, number> = {};
  const alloc: Record<string, Record<string, number>> = {};

  const incidentEdges: Record<string, string[]> = {};
  for (const a of nodes) {
    p[a] = 0;
    pOld[a] = 0;
    alloc[a] = {};
    incidentEdges[a] = [];
  }

  for (const eid of edgeIds) {
    const pair = parseEdgeId(eid);
    if (!pair) continue;
    const [a, b] = pair;
    const rec = (fp as Record<string, { value: number }>)[eid];
    const v = Math.abs(rec?.value ?? 0);
    const half = v / 2;
    p[a] += half;
    p[b] += half;
    pOld[a] += half;
    pOld[b] += half;
    incidentEdges[a].push(eid);
    incidentEdges[b].push(eid);
  }

  for (const a of nodes) {
    const tot = pOld[a];
    const inc = incidentEdges[a];
    if (tot <= 0 || inc.length === 0) continue;
    for (const eid of inc) {
      const pair = parseEdgeId(eid);
      if (!pair) continue;
      const rec = (fp as Record<string, { value: number }>)[eid];
      const v = Math.abs(rec?.value ?? 0);
      const half = v / 2;
      alloc[a][eid] = half / tot;
    }
  }

  const W: Record<string, number> = {};
  for (const a of nodes) {
    const list = neighborWeights.get(a) ?? [];
    let s = 0;
    for (const x of list) s += x.w;
    W[a] = s;
  }

  const outflow: Record<string, number> = {};
  const flow: Record<string, Record<string, number>> = {};
  for (const a of nodes) {
    outflow[a] = 0;
    flow[a] = {};
  }

  for (const a of nodes) {
    if (W[a] <= DIFFUSE_EPS) continue;
    const out = Math.min(DIFFUSE_MAX_OUTFLOW, DIFFUSE_FRACTION * p[a]);
    outflow[a] = out;
    const list = neighborWeights.get(a) ?? [];
    for (const { b, w } of list) {
      flow[a][b] = out * (w / W[a]);
    }
  }

  const inflow: Record<string, number> = {};
  for (const a of nodes) inflow[a] = 0;
  for (const a of nodes) {
    for (const b of Object.keys(flow[a])) {
      inflow[b] = (inflow[b] ?? 0) + flow[a][b];
    }
  }

  let nodesWithOutflow = 0;
  let totalOutflow = 0;
  let totalInflow = 0;
  for (const a of nodes) {
    const o = outflow[a] ?? 0;
    if (o > 0) nodesWithOutflow += 1;
    totalOutflow += o;
    totalInflow += inflow[a] ?? 0;
  }

  const pNext: Record<string, number> = {};
  for (const a of nodes) {
    const next = p[a] - outflow[a] + (inflow[a] ?? 0);
    pNext[a] = Math.max(0, next);
  }

  let sumBefore = 0;
  let sumAfter = 0;
  for (const a of nodes) {
    sumBefore += p[a];
    sumAfter += pNext[a];
  }
  const err = Math.abs(sumAfter - sumBefore);
  let conservationFixApplied = false;
  if (err > CONSERVATION_TOL) {
    console.warn(
      `Phase3A diffusion: conservation check failed (|sum_next - sum_before| = ${err.toExponential(2)}); renormalizing deterministically.`
    );
    const rem = sumBefore - sumAfter;
    const first = nodes[0];
    if (first !== undefined) {
      pNext[first] = Math.max(0, pNext[first] + rem);
      conservationFixApplied = true;
    }
  }

  const turn = state.meta?.turn ?? 0;
  type FpRec = { edge_id: string; value: number; max_abs: number; last_updated_turn: number };
  const roundedMap = new Map<string, number>();

  for (const eid of edgeIds) {
    const pair = parseEdgeId(eid);
    if (!pair) continue;
    const [a, b] = pair;
    const pa = pNext[a] ?? 0;
    const pb = pNext[b] ?? 0;
    const incA = incidentEdges[a] ?? [];
    const incB = incidentEdges[b] ?? [];
    const fa = alloc[a]?.[eid];
    const fb = alloc[b]?.[eid];
    const contribA = (pOld[a] ?? 0) > 0 && fa !== undefined ? fa * pa : (incA.length > 0 ? pa / incA.length : 0);
    const contribB = (pOld[b] ?? 0) > 0 && fb !== undefined ? fb * pb : (incB.length > 0 ? pb / incB.length : 0);
    const vNew = Math.max(0, contribA + contribB);
    roundedMap.set(eid, vNew);
  }

  let sumExact = 0;
  for (const v of roundedMap.values()) sumExact += v;
  const roundedArr = edgeIds.map((eid) => {
    const v = roundedMap.get(eid) ?? 0;
    return { eid, r: Math.round(v) };
  });
  let sumRounded = 0;
  for (const x of roundedArr) sumRounded += x.r;
  const diff = Math.round(sumExact) - sumRounded;
  if (diff !== 0 && roundedArr.length > 0) {
    const fix = roundedArr[0]!;
    roundedArr[0] = { eid: fix.eid, r: Math.max(0, fix.r + diff) };
    conservationFixApplied = true;
  }

  for (const { eid, r } of roundedArr) {
    const rec = (fp as Record<string, FpRec>)[eid];
    const prevMax = Math.abs(rec?.max_abs ?? 0);
    (fp as Record<string, FpRec>)[eid] = {
      edge_id: eid,
      value: r,
      max_abs: Math.max(prevMax, Math.abs(r)),
      last_updated_turn: turn,
    };
  }

  return {
    applied: nodesWithOutflow > 0 && totalOutflow > 0,
    reason_if_not_applied: nodesWithOutflow > 0 && totalOutflow > 0 ? '' : 'no_outflow',
    stats: {
      nodes_with_outflow: nodesWithOutflow,
      total_outflow: totalOutflow,
      total_inflow: totalInflow,
      conserved_error_fix_applied: conservationFixApplied
    }
  };
}
