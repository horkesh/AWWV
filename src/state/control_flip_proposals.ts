import { FrontEdge, getSettlementSide } from '../map/front_edges.js';
import { GameState } from './game_state.js';
import { FrontBreach, FRONT_BREACH_THRESHOLD } from './front_breaches.js';
import { AdjacencyMap, buildAdjacencyMap } from '../map/adjacency_map.js';

export type { AdjacencyMap };
export { buildAdjacencyMap };

export interface ControlFlipTarget {
  sid: string;
  from: string;
  to: string;
  reason: 'breach_1hop';
}

export interface ControlFlipProposal {
  edge_id: string;
  pressure_value: number;
  side_a: string;
  side_b: string;
  favored_side: string;
  losing_side: string;
  targets: ControlFlipTarget[];
}

export interface ControlFlipProposalFile {
  schema: 1;
  turn: number;
  threshold: number;
  proposals: ControlFlipProposal[];
}

function parseEdgeId(edge_id: string): [string, string] | null {
  if (typeof edge_id !== 'string' || !edge_id.includes('__')) return null;
  const parts = edge_id.split('__');
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!a || !b) return null;
  return [a, b];
}

function getNeighbors(adjacencyMap: AdjacencyMap, sid: string): string[] {
  const n = adjacencyMap[sid];
  return Array.isArray(n) ? n : [];
}

export function computeControlFlipProposals(
  state: GameState,
  derivedFrontEdges: FrontEdge[],
  breaches: FrontBreach[],
  adjacencyMap: AdjacencyMap
): ControlFlipProposalFile {
  const turn = state.meta.turn;

  const edgeById = new Map<string, FrontEdge>();
  for (const e of derivedFrontEdges) {
    if (!e || typeof e.edge_id !== 'string') continue;
    if (!edgeById.has(e.edge_id)) edgeById.set(e.edge_id, e);
  }

  const breachesSorted = [...breaches].sort((a, b) => {
    const absA = Math.abs(a.pressure_value);
    const absB = Math.abs(b.pressure_value);
    if (absA !== absB) return absB - absA;
    return a.edge_id.localeCompare(b.edge_id);
  });

  const proposals: ControlFlipProposal[] = [];

  for (const breach of breachesSorted) {
    const parsed = parseEdgeId(breach.edge_id);
    if (!parsed) continue;
    const [a, b] = parsed;

    const derived = edgeById.get(breach.edge_id);
    if (!derived) continue;
    if (typeof derived.side_a !== 'string' || typeof derived.side_b !== 'string') continue;

    const favored_side = breach.favored_side === 'side_a' ? derived.side_a : derived.side_b;
    const losing_side = breach.favored_side === 'side_a' ? derived.side_b : derived.side_a;

    const controllerA = getSettlementSide(state, a);
    const controllerB = getSettlementSide(state, b);

    const targets: ControlFlipTarget[] = [];
    // Build candidates = {a,b} ∪ N(a) ∪ N(b)
    const candidateSet = new Set<string>();
    candidateSet.add(a);
    candidateSet.add(b);
    for (const n of getNeighbors(adjacencyMap, a)) candidateSet.add(n);
    for (const n of getNeighbors(adjacencyMap, b)) candidateSet.add(n);

    // Evaluate candidates controlled by losing_side (deterministic: sorted list).
    const candidatesSorted = Array.from(candidateSet).sort();
    const candidatesLosing = candidatesSorted.filter((sid) => getSettlementSide(state, sid) === losing_side);

    let bestSid: string | null = null;
    let bestScore = -1;
    for (const sid of candidatesLosing) {
      const neighbors = getNeighbors(adjacencyMap, sid);
      let score = 0;
      // neighbors are already sorted by buildAdjacencyMap contract (and preserved here).
      for (const n of neighbors) {
        if (getSettlementSide(state, n) === favored_side) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSid = sid;
      } else if (score === bestScore && bestSid !== null) {
        if (sid.localeCompare(bestSid) < 0) bestSid = sid;
      }
    }

    if (bestSid !== null) {
      targets.push({ sid: bestSid, from: losing_side, to: favored_side, reason: 'breach_1hop' });
    }

    proposals.push({
      edge_id: breach.edge_id,
      pressure_value: breach.pressure_value,
      side_a: derived.side_a,
      side_b: derived.side_b,
      favored_side,
      losing_side,
      targets
    });
  }

  // Deterministic ordering required by artifact schema.
  proposals.sort((a, b) => {
    const absA = Math.abs(a.pressure_value);
    const absB = Math.abs(b.pressure_value);
    if (absA !== absB) return absB - absA;
    return a.edge_id.localeCompare(b.edge_id);
  });

  return { schema: 1, turn, threshold: FRONT_BREACH_THRESHOLD, proposals };
}

export function applyControlFlipProposals(state: GameState, file: ControlFlipProposalFile): { applied: number } {
  const factionsSorted = [...(state.factions ?? [])].sort((a, b) => a.id.localeCompare(b.id));

  // Build id -> faction reference for the final add step.
  const factionById = new Map<string, (typeof factionsSorted)[number]>();
  for (const f of factionsSorted) factionById.set(f.id, f);

  let applied = 0;

  for (const proposal of file.proposals) {
    const targetsSorted = [...proposal.targets].sort((a, b) => a.sid.localeCompare(b.sid));
    for (const t of targetsSorted) {
      // Remove sid from ALL factions first (deterministic by faction id sort).
      for (const f of factionsSorted) {
        if (!Array.isArray(f.areasOfResponsibility)) f.areasOfResponsibility = [];
        const idx = f.areasOfResponsibility.indexOf(t.sid);
        if (idx !== -1) f.areasOfResponsibility.splice(idx, 1);
      }

      // Add to favored faction if present.
      const favored = factionById.get(t.to);
      if (favored) {
        if (!Array.isArray(favored.areasOfResponsibility)) favored.areasOfResponsibility = [];
        if (!favored.areasOfResponsibility.includes(t.sid)) favored.areasOfResponsibility.push(t.sid);
      }
      applied += 1;
    }
  }

  // Keep AoR arrays deterministic after mutation.
  for (const f of factionsSorted) {
    if (!Array.isArray(f.areasOfResponsibility)) continue;
    f.areasOfResponsibility.sort();
  }

  return { applied };
}

