/**
 * Phase 3A: Pressure Propagation Eligibility Builder
 * 
 * Determines which edges in the Phase 2 enriched contact graph are eligible
 * for pressure propagation each turn, and computes coupling weights.
 * 
 * Feature-gated: ENABLE_PHASE3A_PRESSURE_ELIGIBILITY (default: false)
 */

import { loadMistakes, assertNoRepeat } from '../../../tools/assistant/mistake_guard.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GameState, FactionId } from '../../state/game_state.js';

loadMistakes();
assertNoRepeat('phase3a pressure eligibility weights builder and deterministic audit scaffolding');

// Feature flag (OFF by default)
// Can be overridden at runtime for testing/harness purposes
let _enablePhase3AOverride: boolean | null = null;

export function getEnablePhase3A(): boolean {
  return _enablePhase3AOverride !== null ? _enablePhase3AOverride : false;
}

export function setEnablePhase3A(enable: boolean): void {
  _enablePhase3AOverride = enable;
}

export function resetEnablePhase3A(): void {
  _enablePhase3AOverride = null;
}

// Legacy const export for backward compatibility (uses getter)
export const ENABLE_PHASE3A_PRESSURE_ELIGIBILITY = false; // Default, but use getEnablePhase3A() for runtime value

// Phase 3A parameters (from spec)
export const PHASE3A_PARAMS = {
  // Exhaustion collapse threshold
  E_collapse: 100,
  // Cohesion floor threshold
  C_floor: 0.1,
  // Base weights by contact type
  B_sb: 1.0,  // shared_border
  B_pt: 0.7,  // point_touch
  B_dc: 0.4,  // distance_contact
  // Distance attenuation scale
  D_scale: 20.0,
  // Shape dampener parameters
  O_ref: 0.1,
  f_shape_min: 0.1,
  // Missing distance fallback
  f_missing_distance: 0.5,
} as const;

// Enriched contact graph types
export interface EnrichedContactNode {
  sid: string;
  degree: number;
  area_svg2?: number;
  perimeter_svg?: number;
  centroid_svg?: [number, number];
  bbox_svg?: [number, number, number, number];
  comp_count?: number;
}

export interface EnrichedContactEdge {
  a: string;
  b: string;
  type: 'shared_border' | 'point_touch' | 'distance_contact';
  min_dist?: number;
  centroid_distance_svg?: number;
  contact_span_svg?: number;
  bbox_overlap_ratio?: number;
  area_ratio?: number;
  perimeter_ratio?: number;
  overlap_len?: number;
}

export interface EnrichedContactGraph {
  schema_version: number;
  parameters: {
    D0?: number;
    phase?: number;
  };
  nodes: EnrichedContactNode[];
  edges: EnrichedContactEdge[];
}

// Effective edge output
export interface EffectivePressureEdge {
  a: string;
  b: string;
  type: 'shared_border' | 'point_touch' | 'distance_contact';
  eligible: boolean;
  w: number; // clamped to [0,1]
  reasons: string[];
  terms?: {
    base?: number;
    f_distance?: number;
    f_shape?: number;
    f_state?: number;
    f_posture?: number;
  };
}

// State accessor functions (handle missing state gracefully)
export interface StateAccessors {
  getExhaustion?: (sid: string) => number | undefined;
  getCohesion?: (sid: string) => number | undefined;
  getPosture?: (sid: string) => number | undefined;
  getPressure?: (sid: string) => number | undefined;
}

// Audit summary
export interface Phase3AAuditSummary {
  turn: number;
  total_edges: number;
  eligible_by_type: {
    shared_border: { total: number; eligible: number };
    point_touch: { total: number; eligible: number };
    distance_contact: { total: number; eligible: number };
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
  top_strongest: Array<{ a: string; b: string; type: string; w: number }>;
  top_weakest: Array<{ a: string; b: string; type: string; w: number }>;
}

export interface Phase3ABuildResult {
  edgesEffective: EffectivePressureEdge[];
  audit?: Phase3AAuditSummary;
}

/**
 * Load enriched contact graph from disk
 */
export async function loadEnrichedContactGraph(
  path?: string
): Promise<EnrichedContactGraph> {
  const graphPath = resolve(path ?? 'data/derived/settlement_contact_graph_enriched.json');
  const content = await readFile(graphPath, 'utf8');
  const json = JSON.parse(content) as unknown;
  
  if (!isEnrichedContactGraph(json)) {
    throw new Error('Invalid enriched contact graph format');
  }
  
  return json;
}

function isEnrichedContactGraph(obj: unknown): obj is EnrichedContactGraph {
  if (!obj || typeof obj !== 'object') return false;
  const g = obj as Record<string, unknown>;
  return (
    Array.isArray(g.nodes) &&
    Array.isArray(g.edges) &&
    typeof g.schema_version === 'number'
  );
}

/**
 * Build state accessors from GameState
 */
export function buildStateAccessors(state: GameState): StateAccessors {
  const accessors: StateAccessors = {};
  
  // Exhaustion: per-faction, stored in faction.profile.exhaustion
  accessors.getExhaustion = (sid: string) => {
    // Exhaustion is per-faction, not per-settlement
    // For Phase 3A, we'd need to map settlement to faction
    // For now, return undefined (conservative: no gating)
    return undefined;
  };
  
  // Cohesion: not yet implemented in state
  accessors.getCohesion = () => undefined;
  
  // Posture: per-front-edge, not per-settlement
  // For Phase 3A, we'd need to aggregate or use a different approach
  accessors.getPosture = () => undefined;
  
  // Pressure: per-front-edge, not per-settlement
  // For Phase 3A, we'd need to aggregate or use a different approach
  accessors.getPressure = () => undefined;
  
  return accessors;
}

/**
 * Compute base weight by contact type
 */
function getBaseWeight(type: EnrichedContactEdge['type']): number {
  switch (type) {
    case 'shared_border':
      return PHASE3A_PARAMS.B_sb;
    case 'point_touch':
      return PHASE3A_PARAMS.B_pt;
    case 'distance_contact':
      return PHASE3A_PARAMS.B_dc;
    default:
      return PHASE3A_PARAMS.B_dc; // conservative default
  }
}

/**
 * Compute distance attenuation factor
 */
function computeDistanceFactor(edge: EnrichedContactEdge): { factor: number; reason?: string } {
  // Prefer centroid_distance_svg
  if (typeof edge.centroid_distance_svg === 'number' && edge.centroid_distance_svg >= 0) {
    return { factor: Math.exp(-edge.centroid_distance_svg / PHASE3A_PARAMS.D_scale) };
  }
  
  // Fallback to min_dist
  if (typeof edge.min_dist === 'number' && edge.min_dist >= 0) {
    return { factor: Math.exp(-edge.min_dist / PHASE3A_PARAMS.D_scale) };
  }
  
  // Missing distance: use conservative constant
  return {
    factor: PHASE3A_PARAMS.f_missing_distance,
    reason: 'missing_distance_metric'
  };
}

/**
 * Compute shape dampener factor
 */
function computeShapeFactor(edge: EnrichedContactEdge): { factor: number; reason?: string } {
  if (typeof edge.bbox_overlap_ratio === 'number' && edge.bbox_overlap_ratio >= 0) {
    const ratio = edge.bbox_overlap_ratio / PHASE3A_PARAMS.O_ref;
    const clamped = Math.max(PHASE3A_PARAMS.f_shape_min, Math.min(1, ratio));
    return { factor: clamped };
  }
  
  // Missing: neutral
  return { factor: 1.0, reason: 'missing_bbox_overlap' };
}

/**
 * Compute state coupling factor (only reduces, never amplifies)
 */
function computeStateFactor(
  edge: EnrichedContactEdge,
  accessors: StateAccessors
): { factor: number; reasons: string[] } {
  const reasons: string[] = [];
  let factor = 1.0;
  
  // Exhaustion gate (if available)
  const exhaustionA = accessors.getExhaustion?.(edge.a);
  const exhaustionB = accessors.getExhaustion?.(edge.b);
  
  if (exhaustionA !== undefined && exhaustionB !== undefined) {
    // Exhaustion reduces coupling (higher exhaustion = lower factor)
    // Simple linear reduction: factor = 1 - min(exhaustionA, exhaustionB) / E_collapse
    const minExhaustion = Math.min(exhaustionA, exhaustionB);
    const exhaustionPenalty = Math.max(0, Math.min(1, minExhaustion / PHASE3A_PARAMS.E_collapse));
    factor *= (1 - exhaustionPenalty * 0.5); // Max 50% reduction
  } else {
    reasons.push('exhaustion_not_available');
  }
  
  // Cohesion gate (if available)
  const cohesionA = accessors.getCohesion?.(edge.a);
  const cohesionB = accessors.getCohesion?.(edge.b);
  
  if (cohesionA !== undefined && cohesionB !== undefined) {
    // Lower cohesion reduces coupling
    const minCohesion = Math.min(cohesionA, cohesionB);
    const cohesionPenalty = Math.max(0, Math.min(1, (PHASE3A_PARAMS.C_floor - minCohesion) / PHASE3A_PARAMS.C_floor));
    factor *= (1 - cohesionPenalty * 0.3); // Max 30% reduction
  } else {
    reasons.push('cohesion_not_available');
  }
  
  return { factor: Math.max(0, Math.min(1, factor)), reasons };
}

/**
 * Compute posture factor (bounded, symmetric)
 */
function computePostureFactor(
  edge: EnrichedContactEdge,
  accessors: StateAccessors
): { factor: number; reason?: string } {
  const postureA = accessors.getPosture?.(edge.a);
  const postureB = accessors.getPosture?.(edge.b);
  
  if (postureA !== undefined && postureB !== undefined) {
    // Posture modulates coupling (bounded range)
    // Simple average with bounds [0.5, 1.5]
    const avgPosture = (postureA + postureB) / 2;
    const bounded = Math.max(0.5, Math.min(1.5, avgPosture));
    return { factor: bounded };
  }
  
  return { factor: 1.0, reason: 'posture_not_available' };
}

/**
 * Check hard gates for eligibility
 */
function checkHardGates(
  edge: EnrichedContactEdge,
  accessors: StateAccessors
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  // Data integrity: check required fields
  if (!edge.a || !edge.b || !edge.type) {
    reasons.push('missing_required_fields');
    return { eligible: false, reasons };
  }
  
  // Exhaustion collapse gate (only if exhaustion exists)
  const exhaustionA = accessors.getExhaustion?.(edge.a);
  const exhaustionB = accessors.getExhaustion?.(edge.b);
  
  if (exhaustionA !== undefined && exhaustionB !== undefined) {
    if (exhaustionA >= PHASE3A_PARAMS.E_collapse || exhaustionB >= PHASE3A_PARAMS.E_collapse) {
      reasons.push('exhaustion_collapse');
      return { eligible: false, reasons };
    }
  }
  
  // Cohesion failure gate (only if cohesion exists)
  const cohesionA = accessors.getCohesion?.(edge.a);
  const cohesionB = accessors.getCohesion?.(edge.b);
  
  if (cohesionA !== undefined && cohesionB !== undefined) {
    if (cohesionA <= PHASE3A_PARAMS.C_floor || cohesionB <= PHASE3A_PARAMS.C_floor) {
      reasons.push('cohesion_failure');
      return { eligible: false, reasons };
    }
  }
  
  return { eligible: true, reasons };
}

/**
 * Build effective pressure edges from enriched contact graph
 */
export function buildPressureEligibilityPhase3A(
  graph: EnrichedContactGraph,
  state: GameState,
  accessors: StateAccessors,
  auditEnabled: boolean = false
): Phase3ABuildResult {
  const accessorsWithDefaults = buildStateAccessors(state);
  // Merge provided accessors with defaults
  const mergedAccessors: StateAccessors = {
    getExhaustion: accessors.getExhaustion ?? accessorsWithDefaults.getExhaustion,
    getCohesion: accessors.getCohesion ?? accessorsWithDefaults.getCohesion,
    getPosture: accessors.getPosture ?? accessorsWithDefaults.getPosture,
    getPressure: accessors.getPressure ?? accessorsWithDefaults.getPressure,
  };
  
  // Sort edges deterministically (by minSid, maxSid, type)
  const edgesSorted = [...graph.edges].sort((e1, e2) => {
    const a1 = e1.a < e1.b ? e1.a : e1.b;
    const b1 = e1.a < e1.b ? e1.b : e1.a;
    const a2 = e2.a < e2.b ? e2.a : e2.b;
    const b2 = e2.a < e2.b ? e2.b : e2.a;
    
    if (a1 !== a2) return a1.localeCompare(a2);
    if (b1 !== b2) return b1.localeCompare(b2);
    return (e1.type || '').localeCompare(e2.type || '');
  });
  
  const edgesEffective: EffectivePressureEdge[] = [];
  const gateBlockedCounts = {
    exhaustion_collapse: 0,
    cohesion_failure: 0,
    missing_required_fields: 0,
  };
  
  const eligibleWeightsByType: Record<string, number[]> = {
    shared_border: [],
    point_touch: [],
    distance_contact: [],
  };
  
  const eligibleByType = {
    shared_border: { total: 0, eligible: 0 },
    point_touch: { total: 0, eligible: 0 },
    distance_contact: { total: 0, eligible: 0 },
  };
  
  for (const edge of edgesSorted) {
    // Count by type
    eligibleByType[edge.type].total++;
    
    // Check hard gates
    const gateCheck = checkHardGates(edge, mergedAccessors);
    
    if (!gateCheck.eligible) {
      // Record gate block reason
      if (gateCheck.reasons.includes('exhaustion_collapse')) {
        gateBlockedCounts.exhaustion_collapse++;
      }
      if (gateCheck.reasons.includes('cohesion_failure')) {
        gateBlockedCounts.cohesion_failure++;
      }
      if (gateCheck.reasons.includes('missing_required_fields')) {
        gateBlockedCounts.missing_required_fields++;
      }
      
      edgesEffective.push({
        a: edge.a,
        b: edge.b,
        type: edge.type,
        eligible: false,
        w: 0,
        reasons: gateCheck.reasons,
      });
      continue;
    }
    
    // Compute weight components
    const base = getBaseWeight(edge.type);
    const distanceResult = computeDistanceFactor(edge);
    const shapeResult = computeShapeFactor(edge);
    const stateResult = computeStateFactor(edge, mergedAccessors);
    const postureResult = computePostureFactor(edge, mergedAccessors);
    
    // Combine: w = base * f_distance * f_shape * f_state * f_posture
    let w = base * distanceResult.factor * shapeResult.factor * stateResult.factor * postureResult.factor;
    w = Math.max(0, Math.min(1, w)); // Clamp to [0,1]
    
    // Collect reasons
    const reasons: string[] = [];
    if (distanceResult.reason) reasons.push(distanceResult.reason);
    if (shapeResult.reason) reasons.push(shapeResult.reason);
    reasons.push(...stateResult.reasons);
    if (postureResult.reason) reasons.push(postureResult.reason);
    
    edgesEffective.push({
      a: edge.a,
      b: edge.b,
      type: edge.type,
      eligible: true,
      w,
      reasons: reasons.length > 0 ? reasons : [],
      terms: auditEnabled ? {
        base,
        f_distance: distanceResult.factor,
        f_shape: shapeResult.factor,
        f_state: stateResult.factor,
        f_posture: postureResult.factor,
      } : undefined,
    });
    
    eligibleByType[edge.type].eligible++;
    eligibleWeightsByType[edge.type].push(w);
  }
  
  // Build audit summary if enabled
  let audit: Phase3AAuditSummary | undefined;
  
  if (auditEnabled) {
    // Compute weight distributions
    const computePercentiles = (weights: number[]): { min: number; p50: number; p90: number; p99: number; max: number } => {
      if (weights.length === 0) {
        return { min: 0, p50: 0, p90: 0, p99: 0, max: 0 };
      }
      const sorted = [...weights].sort((a, b) => a - b);
      return {
        min: sorted[0],
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p90: sorted[Math.floor(sorted.length * 0.9)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        max: sorted[sorted.length - 1],
      };
    };
    
    // Get top strongest/weakest eligible edges (stable tie-break by sid pair)
    const eligibleEdges = edgesEffective.filter(e => e.eligible);
    const sortedByWeight = [...eligibleEdges].sort((e1, e2) => {
      if (e2.w !== e1.w) return e2.w - e1.w; // Descending by weight
      const key1 = e1.a < e1.b ? `${e1.a}--${e1.b}` : `${e1.b}--${e1.a}`;
      const key2 = e2.a < e2.b ? `${e2.a}--${e2.b}` : `${e2.b}--${e2.a}`;
      return key1.localeCompare(key2);
    });
    
    audit = {
      turn: state.meta.turn,
      total_edges: edgesEffective.length,
      eligible_by_type: eligibleByType,
      weight_distribution_by_type: {
        shared_border: computePercentiles(eligibleWeightsByType.shared_border),
        point_touch: computePercentiles(eligibleWeightsByType.point_touch),
        distance_contact: computePercentiles(eligibleWeightsByType.distance_contact),
      },
      gate_blocked_counts: gateBlockedCounts,
      top_strongest: sortedByWeight.slice(0, 20).map(e => ({ a: e.a, b: e.b, type: e.type, w: e.w })),
      top_weakest: sortedByWeight.slice(-20).reverse().map(e => ({ a: e.a, b: e.b, type: e.type, w: e.w })),
    };
  }
  
  return { edgesEffective, audit };
}
