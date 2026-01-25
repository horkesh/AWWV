import { GameState, FactionState } from './game_state.js';
import { getSettlementSide } from '../map/front_edges.js';
import { AdjacencyMap } from '../map/adjacency_map.js';

export interface FactionSupplyReachability {
  faction_id: string;
  sources: string[]; // sorted unique
  controlled: string[]; // sorted unique (AoR)
  reachable_controlled: string[]; // sorted
  isolated_controlled: string[]; // sorted (controlled minus reachable)
  // Phase 12C.3: Supply rights usage
  rights_edges_used_count?: number;
  rights_nodes_used_count?: number;
  corridors_active_count?: number;
}

export interface SupplyReachabilityReport {
  schema: 1;
  turn: number;
  factions: FactionSupplyReachability[]; // sorted by faction_id asc
}

/**
 * Computes supply reachability for all factions.
 * 
 * Rules:
 * - controlled set for a faction = unique AoR sids
 * - sources set for a faction = unique supply_sources sids
 * - BFS starting from sources, but traversal is restricted to settlements controlled by that faction:
 *   - you can traverse from a controlled node to a neighbor only if neighbor is also controlled
 * - Phase 12C.3: Supply rights allow traversal through corridor scopes even if not controlled
 *   - Corridor edges/nodes can be traversed for supply, but endpoints are NOT treated as controlled
 * - reachable_controlled = controlled ∩ visited
 * - isolated_controlled = controlled - reachable_controlled
 * 
 * Edge cases:
 * - if sources is empty => reachable_controlled empty, isolated_controlled = controlled
 * - if a source sid is not controlled by the faction, still treat it as a starting point ONLY if it is controlled;
 *   otherwise ignore it (report still lists it in sources, but BFS seed excludes it)
 */
export function computeSupplyReachability(
  state: GameState,
  adjacencyMap: AdjacencyMap
): SupplyReachabilityReport {
  const turn = state.meta.turn;
  const factions = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));

  // Phase 12C.3: Build active corridor rights by beneficiary
  const activeCorridorsByBeneficiary = new Map<string, Array<{ scope: { kind: 'region'; region_id: string } | { kind: 'edges'; edge_ids: string[] } | { kind: 'settlements'; sids: string[] }; edgeIds: Set<string>; nodeIds: Set<string> }>>();
  if (state.supply_rights?.corridors) {
    for (const corridor of state.supply_rights.corridors) {
      // Check if corridor is active (not expired)
      if (corridor.until_turn !== null && corridor.until_turn <= turn) {
        continue; // expired
      }
      if (corridor.since_turn > turn) {
        continue; // not yet active
      }

      // Convert scope to edge IDs and node IDs for traversal
      const edgeIds = new Set<string>();
      const nodeIds = new Set<string>();

      if (corridor.scope.kind === 'edges') {
        for (const edgeId of corridor.scope.edge_ids) {
          edgeIds.add(edgeId);
          // Parse edge_id format: "sid1__sid2" (normalized, a < b)
          const parts = edgeId.split('__');
          if (parts.length === 2) {
            nodeIds.add(parts[0]);
            nodeIds.add(parts[1]);
          }
        }
      } else if (corridor.scope.kind === 'settlements') {
        for (const sid of corridor.scope.sids) {
          nodeIds.add(sid);
          // Find all edges connected to this settlement
          const neighbors = adjacencyMap[sid] ?? [];
          for (const neighbor of neighbors) {
            const edgeId = sid < neighbor ? `${sid}__${neighbor}` : `${neighbor}__${sid}`;
            edgeIds.add(edgeId);
          }
        }
      } else if (corridor.scope.kind === 'region') {
        // For region scope, we need front regions to resolve edge IDs
        // For now, we'll skip region-based corridors in reachability (they require front regions)
        // This is acceptable as region corridors are less common
        continue;
      }

      if (!activeCorridorsByBeneficiary.has(corridor.beneficiary)) {
        activeCorridorsByBeneficiary.set(corridor.beneficiary, []);
      }
      activeCorridorsByBeneficiary.get(corridor.beneficiary)!.push({
        scope: corridor.scope,
        edgeIds,
        nodeIds
      });
    }
  }

  const factionResults: FactionSupplyReachability[] = [];

  for (const faction of factions) {
    // Get controlled settlements (unique, sorted)
    const controlled = [...new Set(faction.areasOfResponsibility ?? [])].sort();

    // Get sources (unique, sorted)
    const sourcesRaw = faction.supply_sources ?? [];
    const sources = [...new Set(sourcesRaw)].sort();

    // Build controlled set for quick lookup
    const controlledSet = new Set(controlled);

    // Phase 12C.3: Get active corridors for this beneficiary
    const activeCorridors = activeCorridorsByBeneficiary.get(faction.id) ?? [];
    const allowedEdges = new Set<string>();
    const allowedNodes = new Set<string>();
    for (const corridor of activeCorridors) {
      for (const edgeId of corridor.edgeIds) {
        allowedEdges.add(edgeId);
      }
      for (const nodeId of corridor.nodeIds) {
        allowedNodes.add(nodeId);
      }
    }

    // BFS from sources, but only traverse through controlled settlements OR corridor nodes
    const visited = new Set<string>();
    const queue: string[] = [];
    let rightsEdgesUsed = 0;
    let rightsNodesUsed = 0;

    // Initialize queue with valid sources (must be controlled by this faction)
    for (const source of sources) {
      const controller = getSettlementSide(state, source);
      if (controller === faction.id && controlledSet.has(source)) {
        if (!visited.has(source)) {
          visited.add(source);
          queue.push(source);
        }
      }
    }

    // BFS: traverse through controlled neighbors OR corridor-allowed edges/nodes
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacencyMap[current] ?? [];

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;

        const neighborController = getSettlementSide(state, neighbor);
        const edgeId = current < neighbor ? `${current}__${neighbor}` : `${neighbor}__${current}`;

        // Check if we can traverse:
        // 1. Normal path: neighbor is controlled by this faction
        // 2. Corridor path: edge is in allowedEdges OR neighbor is in allowedNodes (traversal only, not control)
        const canTraverseNormal = neighborController === faction.id && controlledSet.has(neighbor);
        const canTraverseCorridor = allowedEdges.has(edgeId) || allowedNodes.has(neighbor);

        if (canTraverseNormal) {
          visited.add(neighbor);
          queue.push(neighbor);
        } else if (canTraverseCorridor) {
          // Corridor traversal: allow traversal but don't treat as controlled
          visited.add(neighbor);
          queue.push(neighbor);
          if (allowedEdges.has(edgeId)) {
            rightsEdgesUsed += 1;
          }
          if (allowedNodes.has(neighbor)) {
            rightsNodesUsed += 1;
          }
        }
      }
    }

    // Compute reachable_controlled (controlled ∩ visited)
    const reachableSet = new Set(visited);
    const reachable_controlled = controlled.filter((sid) => reachableSet.has(sid));

    // Compute isolated_controlled (controlled - reachable)
    const isolated_controlled = controlled.filter((sid) => !reachableSet.has(sid));

    factionResults.push({
      faction_id: faction.id,
      sources,
      controlled,
      reachable_controlled,
      isolated_controlled,
      rights_edges_used_count: rightsEdgesUsed,
      rights_nodes_used_count: rightsNodesUsed,
      corridors_active_count: activeCorridors.length
    });
  }

  return {
    schema: 1,
    turn,
    factions: factionResults
  };
}
