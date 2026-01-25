import { GameState, FactionState } from '../state/game_state.js';
import { LoadedSettlementGraph, EdgeRecord } from '../map/settlements.js';
import { ValidationIssue } from './validate.js';

export interface AoRComponent {
  sids: string[];
}

export interface AoRContiguityResult {
  factionId: string;
  isContiguous: boolean;
  components: AoRComponent[];
}

/**
 * Builds an adjacency map from settlement edges.
 * Treats edges as bidirectional (ignores one_way flag for connectivity).
 */
function buildAdjacencyMap(graph: LoadedSettlementGraph): Map<string, Set<string>> {
  const adjMap = new Map<string, Set<string>>();

  // Initialize all settlements
  for (const sid of graph.settlements.keys()) {
    adjMap.set(sid, new Set<string>());
  }

  // Add edges (bidirectional)
  for (const edge of graph.edges) {
    const neighborsA = adjMap.get(edge.a);
    const neighborsB = adjMap.get(edge.b);

    if (neighborsA && neighborsB) {
      neighborsA.add(edge.b);
      neighborsB.add(edge.a);
    }
  }

  return adjMap;
}

/**
 * Finds all connected components in a set of settlements using BFS.
 * Returns an array of components, each containing the sids in that component.
 */
function findConnectedComponents(
  settlementSet: Set<string>,
  adjMap: Map<string, Set<string>>
): AoRComponent[] {
  const visited = new Set<string>();
  const components: AoRComponent[] = [];

  for (const startSid of settlementSet) {
    if (visited.has(startSid)) continue;

    // BFS from startSid
    const component: string[] = [];
    const queue: string[] = [startSid];
    visited.add(startSid);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = adjMap.get(current) || new Set<string>();
      for (const neighbor of neighbors) {
        // Only traverse to neighbors that are in the settlement set
        if (settlementSet.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Sort component sids for deterministic output
    component.sort();
    components.push({ sids: component });
  }

  // Sort components by first sid for deterministic output
  components.sort((a, b) => {
    if (a.sids.length === 0) return 1;
    if (b.sids.length === 0) return -1;
    return a.sids[0].localeCompare(b.sids[0]);
  });

  return components;
}

/**
 * Validates AoR contiguity for a single faction.
 * Returns null if contiguous, or a result object with components if disconnected.
 */
export function validateAoRContiguity(
  faction: FactionState,
  graph: LoadedSettlementGraph,
  adjMap?: Map<string, Set<string>>
): AoRContiguityResult | null {
  if (faction.areasOfResponsibility.length === 0) {
    // Empty AoR is considered contiguous
    return null;
  }

  const adjacencyMap = adjMap || buildAdjacencyMap(graph);
  const aorSet = new Set(faction.areasOfResponsibility);

  // Check if all settlements in AoR exist
  for (const sid of faction.areasOfResponsibility) {
    if (!graph.settlements.has(sid)) {
      // Invalid settlement - will be caught by other validators
      continue;
    }
  }

  const components = findConnectedComponents(aorSet, adjacencyMap);

  if (components.length <= 1) {
    return null; // Contiguous
  }

  return {
    factionId: faction.id,
    isContiguous: false,
    components
  };
}

/**
 * Validates AoR contiguity for all factions in a game state.
 * Returns validation issues for factions with disconnected AoRs.
 */
export function validateAllAoRContiguity(
  state: GameState,
  graph: LoadedSettlementGraph
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const adjMap = buildAdjacencyMap(graph);

  for (const faction of state.factions) {
    const result = validateAoRContiguity(faction, graph, adjMap);

    if (result) {
      // Disconnected AoR found
      const componentDescriptions = result.components.map(
        (comp, idx) => `Component ${idx + 1} (${comp.sids.length} settlement${comp.sids.length !== 1 ? 's' : ''}): ${comp.sids.join(', ')}`
      );

      const factionIndex = state.factions.indexOf(faction);
      issues.push({
        severity: 'error',
        code: 'aor.disconnected',
        message: `Faction ${faction.id} has disconnected AoR with ${result.components.length} component${result.components.length !== 1 ? 's' : ''}. ${componentDescriptions.join('; ')}`,
        path: `factions[${factionIndex}].areasOfResponsibility`
      });
    }
  }

  return issues;
}
