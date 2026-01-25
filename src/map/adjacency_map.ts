export type AdjacencyMap = Record<string, string[]>;

export function buildAdjacencyMap(settlementEdges: Array<{ a: string; b: string }>): AdjacencyMap {
  const tmp = new Map<string, Set<string>>();
  for (const e of settlementEdges ?? []) {
    if (!e || typeof e.a !== 'string' || typeof e.b !== 'string') continue;
    const a = e.a;
    const b = e.b;
    if (!tmp.has(a)) tmp.set(a, new Set());
    if (!tmp.has(b)) tmp.set(b, new Set());
    tmp.get(a)!.add(b);
    tmp.get(b)!.add(a);
  }

  const out: AdjacencyMap = {};
  const keysSorted = Array.from(tmp.keys()).sort();
  for (const k of keysSorted) {
    out[k] = Array.from(tmp.get(k) ?? []).sort();
  }
  return out;
}
