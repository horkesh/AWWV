import type { GameState } from '../state/game_state.js';
import type { FrontEdge } from './front_edges.js';

export interface FrontRegion {
  region_id: string; // deterministic stable id
  side_pair: string; // canonical "A--B" where A < B lexicographically
  edge_ids: string[]; // sorted
  settlements: string[]; // sorted unique sids that appear in those edges
  active_edge_count: number;
}

export interface FrontRegionsFile {
  schema: 1;
  turn: number;
  regions: FrontRegion[]; // sorted by side_pair asc, then active_edge_count desc, then region_id asc
}

function canonicalSidePair(sideA: string, sideB: string): string {
  return sideA < sideB ? `${sideA}--${sideB}` : `${sideB}--${sideA}`;
}

/**
 * Deterministically derive connected "front regions" (connected components) from active front edges.
 *
 * Rules:
 * - Consider only edges that are active in state.front_segments[edge_id]?.active === true
 * - Consider only derived front edges with non-null side_a and side_b
 * - Regionization is performed per canonical side-pair (A--B), based on shared endpoint settlement IDs
 * - Two edges are adjacent if they share any endpoint sid (a or b)
 * - region_id is hash-free and stable under unchanged component membership:
 *   region_id = side_pair + "::" + first_edge_id, where first_edge_id is smallest edge_id in the component
 */
export function computeFrontRegions(state: GameState, derivedFrontEdges: FrontEdge[]): FrontRegionsFile {
  const activeEdgeIds = new Set<string>();
  for (const [edge_id, seg] of Object.entries(state.front_segments ?? {})) {
    if (seg && typeof seg === 'object' && (seg as any).active === true) activeEdgeIds.add(edge_id);
  }

  type EdgeLite = { edge_id: string; a: string; b: string; side_pair: string };
  const edgesBySidePair = new Map<string, EdgeLite[]>();

  for (const e of derivedFrontEdges) {
    if (!e || typeof e.edge_id !== 'string') continue;
    if (!activeEdgeIds.has(e.edge_id)) continue;
    if (typeof e.a !== 'string' || typeof e.b !== 'string') continue;
    if (typeof e.side_a !== 'string' || typeof e.side_b !== 'string') continue;
    const side_pair = canonicalSidePair(e.side_a, e.side_b);
    const arr = edgesBySidePair.get(side_pair) ?? [];
    arr.push({ edge_id: e.edge_id, a: e.a, b: e.b, side_pair });
    edgesBySidePair.set(side_pair, arr);
  }

  const regions: FrontRegion[] = [];

  for (const [side_pair, edges] of edgesBySidePair.entries()) {
    // Deterministic ordering inside the side-pair processing.
    edges.sort((a, b) => a.edge_id.localeCompare(b.edge_id));

    const edgeById = new Map<string, EdgeLite>();
    for (const e of edges) edgeById.set(e.edge_id, e);

    // sid -> edge_ids index for efficient adjacency lookup
    const sidToEdgeIds = new Map<string, string[]>();
    for (const e of edges) {
      const idsA = sidToEdgeIds.get(e.a) ?? [];
      idsA.push(e.edge_id);
      sidToEdgeIds.set(e.a, idsA);
      const idsB = sidToEdgeIds.get(e.b) ?? [];
      idsB.push(e.edge_id);
      sidToEdgeIds.set(e.b, idsB);
    }
    for (const ids of sidToEdgeIds.values()) ids.sort((a, b) => a.localeCompare(b));

    const visited = new Set<string>();
    const edgeIdsSorted = edges.map((e) => e.edge_id);

    for (const startId of edgeIdsSorted) {
      if (visited.has(startId)) continue;

      // BFS to find connected component.
      const componentEdgeIds: string[] = [];
      const componentSettlements = new Set<string>();
      const queue: string[] = [startId];
      visited.add(startId);

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        componentEdgeIds.push(currentId);
        const current = edgeById.get(currentId);
        if (!current) continue;

        componentSettlements.add(current.a);
        componentSettlements.add(current.b);

        const neighborsA = sidToEdgeIds.get(current.a) ?? [];
        const neighborsB = sidToEdgeIds.get(current.b) ?? [];
        // Deterministic neighbor visitation by concatenated sorted lists.
        const neighbors = neighborsA.length === 0 ? neighborsB : neighborsB.length === 0 ? neighborsA : [...neighborsA, ...neighborsB];
        for (const nid of neighbors) {
          if (visited.has(nid)) continue;
          visited.add(nid);
          queue.push(nid);
        }
      }

      componentEdgeIds.sort((a, b) => a.localeCompare(b));
      const settlements = Array.from(componentSettlements).sort((a, b) => a.localeCompare(b));
      const first_edge_id = componentEdgeIds[0] ?? '';
      const region_id = `${side_pair}::${first_edge_id}`;

      regions.push({
        region_id,
        side_pair,
        edge_ids: componentEdgeIds,
        settlements,
        active_edge_count: componentEdgeIds.length
      });
    }
  }

  regions.sort((a, b) => {
    const sp = a.side_pair.localeCompare(b.side_pair);
    if (sp !== 0) return sp;
    if (a.active_edge_count !== b.active_edge_count) return b.active_edge_count - a.active_edge_count;
    return a.region_id.localeCompare(b.region_id);
  });

  return { schema: 1, turn: state.meta.turn, regions };
}

