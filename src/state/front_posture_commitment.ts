import type { GameState, FactionId } from './game_state.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import type { FormationFatigueStepReport } from './formation_fatigue.js';
import { isFormationSupplied, computeLocalSupplyForEdges } from './formation_fatigue.js';
import { buildAdjacencyMap } from '../map/adjacency_map.js';

/**
 * Effective posture weight after commitment and friction.
 * Same structure as FrontPostureAssignment but with effective_weight.
 */
export interface EffectivePostureAssignment {
  edge_id: string;
  posture: 'hold' | 'probe' | 'push';
  base_weight: number;
  effective_weight: number;
}

export interface EffectivePostureState {
  assignments: Record<string, EffectivePostureAssignment>;
}

/**
 * Per-edge commitment audit record.
 */
export interface CommitmentEdgeAudit {
  edge_id: string;
  base_weight: number;
  commit_points: number; // integer milli-points (1 commit = 1000)
  friction_factor: number; // 0.0 to 1.0 (clamped)
  effective_weight: number;
}

/**
 * Per-faction commitment totals.
 */
export interface CommitmentFactionTotals {
  faction_id: FactionId;
  formations_active: number;
  formations_assigned_region: number;
  formations_assigned_edge: number;
  total_commit_points: number; // integer milli-points
  total_demand_weight: number;
  total_effective_weight: number;
  command_capacity: number;
  capacity_applied: boolean;
  global_factor: number; // 1.0 if not applied
}

/**
 * Commitment step audit report.
 */
export interface CommitmentStepReport {
  by_faction: CommitmentFactionTotals[];
  by_edge: CommitmentEdgeAudit[];
  global_capacity: {
    total_demand: number;
    command_capacity: number;
    global_factor: number;
  } | null;
}

/**
 * Compute effective posture weights from formation commitments and friction.
 *
 * Rules:
 * 1. Only ACTIVE formations with matching faction count.
 * 2. Edge assignments: 1 commit point (1000 milli-points) per formation to that edge.
 * 3. Region assignments: 1 commit point split evenly across all active edges in that region for that faction's side-pair.
 * 4. Friction: effective_weight = floor(base_weight * clamp01(commit_points / (demand_points * 1000)))
 * 5. Command capacity: if total_demand > capacity, apply global scaling factor.
 *
 * Returns effective posture per faction and audit report.
 */
export function applyFormationCommitment(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  frontRegions: FrontRegionsFile,
  formationFatigueReport?: FormationFatigueStepReport,
  settlementEdges?: Array<{ a: string; b: string }>
): {
  effectivePosture: Record<FactionId, EffectivePostureState>;
  report: CommitmentStepReport;
} {
  const effectivePosture: Record<FactionId, EffectivePostureState> = {};
  const edgeAudits: CommitmentEdgeAudit[] = [];
  const factionTotals: CommitmentFactionTotals[] = [];

  // Build active edge sets per faction+side-pair for region assignment splitting
  const activeEdgesByFactionSidePair = new Map<string, string[]>();
  for (const edge of derivedFrontEdges) {
    if (!edge.side_a || !edge.side_b) continue;
    const seg = (state.front_segments as any)?.[edge.edge_id];
    if (!seg || typeof seg !== 'object' || (seg as any).active !== true) continue;

    // Add to side_a's active edges
    const keyA = `${edge.side_a}::${edge.side_a}--${edge.side_b}`;
    const edgesA = activeEdgesByFactionSidePair.get(keyA) ?? [];
    if (!edgesA.includes(edge.edge_id)) {
      edgesA.push(edge.edge_id);
      activeEdgesByFactionSidePair.set(keyA, edgesA);
    }

    // Add to side_b's active edges
    const keyB = `${edge.side_b}::${edge.side_a}--${edge.side_b}`;
    const edgesB = activeEdgesByFactionSidePair.get(keyB) ?? [];
    if (!edgesB.includes(edge.edge_id)) {
      edgesB.push(edge.edge_id);
      activeEdgesByFactionSidePair.set(keyB, edgesB);
    }
  }

  // Sort edges deterministically in each set
  for (const [key, edges] of activeEdgesByFactionSidePair.entries()) {
    edges.sort((a, b) => a.localeCompare(b));
  }

  // Build region lookup
  const regionById = new Map<string, { edge_ids: string[]; side_pair: string }>();
  for (const r of frontRegions.regions ?? []) {
    if (r && typeof r === 'object' && typeof (r as any).region_id === 'string') {
      regionById.set((r as any).region_id, {
        edge_ids: Array.isArray((r as any).edge_ids) ? (r as any).edge_ids : [],
        side_pair: typeof (r as any).side_pair === 'string' ? (r as any).side_pair : ''
      });
    }
  }

  // Process each faction
  const factionIdsSorted = [...state.factions].map((f) => f.id).sort();
  for (const factionId of factionIdsSorted) {
    const faction = state.factions.find((f) => f.id === factionId);
    if (!faction) continue;

    const commandCapacity = (faction.command_capacity !== undefined && Number.isInteger(faction.command_capacity) && faction.command_capacity >= 0) ? faction.command_capacity : 0;

    // Collect active formations for this faction
    const formations = (state as any).formations as Record<string, any> | undefined;
    const activeFormations: Array<{ id: string; assignment: any }> = [];
    if (formations && typeof formations === 'object') {
      for (const [id, f] of Object.entries(formations)) {
        if (!f || typeof f !== 'object') continue;
        if ((f as any).faction !== factionId) continue;
        if ((f as any).status !== 'active') continue;
        const assignment = (f as any).assignment;
        activeFormations.push({ id, assignment });
      }
    }

    // Count formations by assignment type
    let assignedRegionCount = 0;
    let assignedEdgeCount = 0;
    for (const f of activeFormations) {
      if (f.assignment && typeof f.assignment === 'object') {
        if (f.assignment.kind === 'region') assignedRegionCount += 1;
        else if (f.assignment.kind === 'edge') assignedEdgeCount += 1;
      }
    }

    // Accumulate commit points per edge (in milli-points: 1 commit = 1000 base, minus supply/fatigue penalties)
    const commitPointsByEdge = new Map<string, number>();

    for (const f of activeFormations) {
      if (!f.assignment || typeof f.assignment !== 'object') continue;

      // Phase 10: Compute commit points with supply/fatigue penalties
      const formationData = formations?.[f.id];
      const ops = formationData && typeof formationData === 'object' ? (formationData as any).ops : undefined;
      const fatigue = ops && typeof ops === 'object' && Number.isInteger(ops.fatigue) ? (ops.fatigue as number) : 0;
      
      // Phase 12A: Determine supply from formation_fatigue_report if available (preferred),
      // otherwise recompute deterministically using the same helper used by fatigue step
      let supplied_this_turn: boolean;
      if (formationFatigueReport && Array.isArray(formationFatigueReport.by_formation)) {
        const formationRecord = formationFatigueReport.by_formation.find((r) => r.formation_id === f.id);
        if (formationRecord && typeof formationRecord.supplied_this_turn === 'boolean') {
          supplied_this_turn = formationRecord.supplied_this_turn;
        } else {
          // Fallback: recompute supply deterministically (same logic as fatigue step)
          if (settlementEdges) {
            const adjacencyMap = buildAdjacencyMap(settlementEdges);
            const localSupplyByEdge = computeLocalSupplyForEdges(state, derivedFrontEdges, adjacencyMap);
            supplied_this_turn = isFormationSupplied(state, formationData, localSupplyByEdge, frontRegions, derivedFrontEdges);
          } else {
            // Last resort: use last_supplied_turn equality (should not happen in normal pipeline)
            const currentTurn = state.meta.turn;
            const lastSuppliedTurn = ops && typeof ops === 'object' ? (ops.last_supplied_turn as number | null | undefined) : null;
            supplied_this_turn = lastSuppliedTurn === currentTurn;
          }
        }
      } else {
        // No report available: recompute deterministically
        if (settlementEdges) {
          const adjacencyMap = buildAdjacencyMap(settlementEdges);
          const localSupplyByEdge = computeLocalSupplyForEdges(state, derivedFrontEdges, adjacencyMap);
          supplied_this_turn = isFormationSupplied(state, formationData, localSupplyByEdge, frontRegions, derivedFrontEdges);
        } else {
          // Last resort: use last_supplied_turn equality (should not happen in normal pipeline)
          const currentTurn = state.meta.turn;
          const lastSuppliedTurn = ops && typeof ops === 'object' ? (ops.last_supplied_turn as number | null | undefined) : null;
          supplied_this_turn = lastSuppliedTurn === currentTurn;
        }
      }
      
      // Compute commit points: base 1000, 50% penalty if unsupplied, minus fatigue*50
      let commitPoints = 1000;
      if (!supplied_this_turn) {
        commitPoints = Math.floor(1000 * 0.5); // 500 when unsupplied
      }
      const penalty = fatigue * 50;
      commitPoints = Math.max(0, commitPoints - penalty);

      if (f.assignment.kind === 'edge' && typeof f.assignment.edge_id === 'string') {
        const edgeId = f.assignment.edge_id;
        const cur = commitPointsByEdge.get(edgeId) ?? 0;
        commitPointsByEdge.set(edgeId, cur + commitPoints);
      } else if (f.assignment.kind === 'region' && typeof f.assignment.region_id === 'string') {
        const regionId = f.assignment.region_id;
        const region = regionById.get(regionId);
        if (!region) continue;

        // Find active edges in this region where the faction is one of the sides
        // The region has a side_pair, and we need edges where factionId is in that side_pair
        const sidePair = region.side_pair;
        const [sideA, sideB] = sidePair.split('--');
        
        // Check if this faction is part of the region's side-pair
        if (sideA !== factionId && sideB !== factionId) continue;

        // Get active edges for this faction in this side-pair
        const key = `${factionId}::${sidePair}`;
        const activeEdges = activeEdgesByFactionSidePair.get(key) ?? [];

        // Filter to edges that are in the region
        const regionEdges = activeEdges.filter((eid) => region.edge_ids.includes(eid)).sort((a, b) => a.localeCompare(b));

        if (regionEdges.length === 0) continue;

        // Split commit points evenly across region edges
        const pointsPerEdge = Math.floor(commitPoints / regionEdges.length);
        const remainder = commitPoints - pointsPerEdge * regionEdges.length;

        // Distribute remainder deterministically by edge_id order
        for (let i = 0; i < regionEdges.length; i += 1) {
          const edgeId = regionEdges[i];
          const extra = i < remainder ? 1 : 0;
          const cur = commitPointsByEdge.get(edgeId) ?? 0;
          commitPointsByEdge.set(edgeId, cur + pointsPerEdge + extra);
        }
      }
    }

    // Get base posture weights
    const basePosture = state.front_posture?.[factionId];
    const assignments = basePosture?.assignments ?? {};

    // Compute effective weights per edge
    const effectiveAssignments: Record<string, EffectivePostureAssignment> = {};
    let totalDemand = 0;
    let totalEffective = 0;

    // Process all edges that have base_weight > 0 or commit points
    const allEdgeIds = new Set<string>();
    for (const edgeId of Object.keys(assignments)) allEdgeIds.add(edgeId);
    for (const edgeId of commitPointsByEdge.keys()) allEdgeIds.add(edgeId);

    const edgeIdsSorted = Array.from(allEdgeIds).sort();
    for (const edgeId of edgeIdsSorted) {
      const assignment = assignments[edgeId];
      const baseWeight = assignment && typeof assignment === 'object' && Number.isInteger(assignment.weight) ? assignment.weight : 0;
      const posture = assignment && typeof assignment === 'object' && (assignment.posture === 'hold' || assignment.posture === 'probe' || assignment.posture === 'push') ? assignment.posture : 'hold';

      // If base_weight is 0, effective_weight is 0 (do not create intent from commitment alone)
      if (baseWeight === 0) {
        effectiveAssignments[edgeId] = {
          edge_id: edgeId,
          posture,
          base_weight: 0,
          effective_weight: 0
        };
        continue;
      }

      totalDemand += baseWeight;

      const commitPoints = commitPointsByEdge.get(edgeId) ?? 0;
      const demandPoints = baseWeight * 1000; // convert to milli-points for comparison

      // Phase 11B: Check if edge is frozen by ceasefire
      const ceasefire = (state as any).ceasefire as Record<string, any> | undefined;
      const freezeEntry = ceasefire?.[edgeId];
      const isFrozen = freezeEntry && typeof freezeEntry === 'object';
      if (isFrozen) {
        // Edge is frozen: set effective_weight to 0
        effectiveAssignments[edgeId] = {
          edge_id: edgeId,
          posture,
          base_weight: baseWeight,
          effective_weight: 0
        };
        // Audit record with ceasefire_freeze flag
        edgeAudits.push({
          edge_id: edgeId,
          base_weight: baseWeight,
          commit_points: commitPoints,
          friction_factor: 0,
          effective_weight: 0
        });
        continue;
      }

      // Friction factor: clamp01(supply / demand)
      const frictionFactor = demandPoints > 0 ? Math.max(0, Math.min(1, commitPoints / demandPoints)) : 0;
      let effectiveWeight = Math.floor(baseWeight * frictionFactor);

      effectiveAssignments[edgeId] = {
        edge_id: edgeId,
        posture,
        base_weight: baseWeight,
        effective_weight: effectiveWeight
      };

      totalEffective += effectiveWeight;

      // Audit record
      edgeAudits.push({
        edge_id: edgeId,
        base_weight: baseWeight,
        commit_points: commitPoints,
        friction_factor: frictionFactor,
        effective_weight: effectiveWeight
      });
    }

    // Apply command capacity global scaling if needed
    let globalFactor = 1.0;
    let capacityApplied = false;
    if (commandCapacity > 0 && totalDemand > commandCapacity) {
      globalFactor = commandCapacity / totalDemand;
      capacityApplied = true;

      // Rescale all effective weights
      for (const edgeId of Object.keys(effectiveAssignments)) {
        const eff = effectiveAssignments[edgeId];
        const oldEffective = eff.effective_weight;
        eff.effective_weight = Math.floor(oldEffective * globalFactor);
        totalEffective = totalEffective - oldEffective + eff.effective_weight;

        // Update audit record
        const audit = edgeAudits.find((a) => a.edge_id === edgeId);
        if (audit) {
          audit.effective_weight = eff.effective_weight;
        }
      }
    }

    const totalCommitPoints = Array.from(commitPointsByEdge.values()).reduce((sum, p) => sum + p, 0);

    factionTotals.push({
      faction_id: factionId,
      formations_active: activeFormations.length,
      formations_assigned_region: assignedRegionCount,
      formations_assigned_edge: assignedEdgeCount,
      total_commit_points: totalCommitPoints,
      total_demand_weight: totalDemand,
      total_effective_weight: totalEffective,
      command_capacity: commandCapacity,
      capacity_applied: capacityApplied,
      global_factor: globalFactor
    });

    effectivePosture[factionId] = {
      assignments: effectiveAssignments
    };
  }

  // Sort audits deterministically
  edgeAudits.sort((a, b) => a.edge_id.localeCompare(b.edge_id));

  // Global capacity summary (if any faction applied capacity)
  const globalCapacity = factionTotals.some((f) => f.capacity_applied)
    ? {
        total_demand: factionTotals.reduce((sum, f) => sum + f.total_demand_weight, 0),
        command_capacity: factionTotals.reduce((sum, f) => sum + f.command_capacity, 0),
        global_factor: factionTotals.find((f) => f.capacity_applied)?.global_factor ?? 1.0
      }
    : null;

  return {
    effectivePosture,
    report: {
      by_faction: factionTotals,
      by_edge: edgeAudits,
      global_capacity: globalCapacity
    }
  };
}
