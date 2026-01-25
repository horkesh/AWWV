import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettlementGraph } from '../../src/map/settlements.js';

interface RemapRule {
  from: string;
  to: string;
  count: number;
}

interface FixReport {
  endpointsRemapped: number;
  edgesDropped: number;
  duplicatesRemoved: number;
  topRemapRules: RemapRule[];
}

/**
 * Extract base SID (first two segments) from a SID string.
 * Returns null if SID doesn't have at least 2 segments.
 */
function getBaseSid(sid: string): string | null {
  const parts = sid.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Check if a SID is a base SID (exactly 2 segments).
 */
function isBaseSid(sid: string): boolean {
  const parts = sid.split(':');
  return parts.length === 2;
}

/**
 * Normalize edge key for undirected edges (min(a,b)|max(a,b)).
 */
function normalizedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Load fallback geometries set for detecting fallback settlements.
 */
async function loadFallbackSids(): Promise<Set<string>> {
  try {
    const fallbackPath = resolve('data/derived/fallback_geometries.json');
    const fallbackData = JSON.parse(await readFile(fallbackPath, 'utf8')) as {
      fallbacks?: Array<{ sid: string }>;
    };
    const fallbackSet = new Set<string>();
    if (fallbackData.fallbacks) {
      for (const fb of fallbackData.fallbacks) {
        fallbackSet.add(fb.sid);
      }
    }
    return fallbackSet;
  } catch {
    // File might not exist, return empty set
    return new Set<string>();
  }
}

async function main(): Promise<void> {
  process.stdout.write('Fix Edges: Canonicalize SIDs\n');
  process.stdout.write('============================\n\n');
  
  // Load data
  const settlementsPath = resolve('data/derived/settlements_index.json');
  const edgesPath = resolve('data/derived/settlement_edges.json');
  
  process.stdout.write(`Settlements path: ${settlementsPath}\n`);
  process.stdout.write(`Edges path: ${edgesPath}\n\n`);
  
  const graph = await loadSettlementGraph();
  const fallbackSids = await loadFallbackSids();
  
  process.stdout.write(`Loaded ${graph.settlements.size} settlements, ${graph.edges.length} edges\n`);
  process.stdout.write(`Fallback geometries: ${fallbackSids.size}\n\n`);
  
  // Build Set of all settlement SIDs
  const sidSet = new Set<string>(graph.settlements.keys());
  
  // Build base SID to candidates mapping
  const baseToCandidates = new Map<string, string[]>();
  for (const sid of graph.settlements.keys()) {
    const baseSid = getBaseSid(sid);
    if (baseSid && sid !== baseSid) {
      // This SID has 3+ segments, so it's a candidate for the base
      if (!baseToCandidates.has(baseSid)) {
        baseToCandidates.set(baseSid, []);
      }
      baseToCandidates.get(baseSid)!.push(sid);
    }
  }
  
  process.stdout.write(`Base SIDs with candidates: ${baseToCandidates.size}\n\n`);
  
  // Process edges
  const remapCounts = new Map<string, Map<string, number>>(); // from -> to -> count
  let endpointsRemapped = 0;
  let edgesDropped = 0;
  const fixedEdges: Array<{ a: string; b: string; one_way?: boolean; allow_self_loop?: boolean }> = [];
  
  for (const edge of graph.edges) {
    let a = edge.a;
    let b = edge.b;
    let aValid = false;
    let bValid = false;
    
    // Resolve endpoint a
    if (sidSet.has(a)) {
      aValid = true;
    } else if (isBaseSid(a)) {
      const candidates = baseToCandidates.get(a);
      if (candidates && candidates.length > 0) {
        // Choose deterministically
        let chosen: string;
        if (candidates.length === 1) {
          chosen = candidates[0];
        } else {
          // Multiple candidates: prefer non-fallback, then lexicographically smallest
          const nonFallbacks = candidates.filter(sid => !fallbackSids.has(sid));
          if (nonFallbacks.length > 0) {
            chosen = nonFallbacks.sort((x, y) => x.localeCompare(y))[0];
          } else {
            chosen = candidates.sort((x, y) => x.localeCompare(y))[0];
          }
        }
        a = chosen;
        aValid = true;
        endpointsRemapped++;
        
        // Track remap
        if (!remapCounts.has(edge.a)) {
          remapCounts.set(edge.a, new Map());
        }
        const toMap = remapCounts.get(edge.a)!;
        toMap.set(chosen, (toMap.get(chosen) || 0) + 1);
      }
    }
    
    // Resolve endpoint b
    if (sidSet.has(b)) {
      bValid = true;
    } else if (isBaseSid(b)) {
      const candidates = baseToCandidates.get(b);
      if (candidates && candidates.length > 0) {
        // Choose deterministically
        let chosen: string;
        if (candidates.length === 1) {
          chosen = candidates[0];
        } else {
          // Multiple candidates: prefer non-fallback, then lexicographically smallest
          const nonFallbacks = candidates.filter(sid => !fallbackSids.has(sid));
          if (nonFallbacks.length > 0) {
            chosen = nonFallbacks.sort((x, y) => x.localeCompare(y))[0];
          } else {
            chosen = candidates.sort((x, y) => x.localeCompare(y))[0];
          }
        }
        b = chosen;
        bValid = true;
        endpointsRemapped++;
        
        // Track remap
        if (!remapCounts.has(edge.b)) {
          remapCounts.set(edge.b, new Map());
        }
        const toMap = remapCounts.get(edge.b)!;
        toMap.set(chosen, (toMap.get(chosen) || 0) + 1);
      }
    }
    
    // Only keep edge if both endpoints are valid
    if (aValid && bValid) {
      fixedEdges.push({
        a,
        b,
        one_way: edge.one_way,
        allow_self_loop: edge.allow_self_loop
      });
    } else {
      edgesDropped++;
    }
  }
  
  process.stdout.write(`Endpoints remapped: ${endpointsRemapped}\n`);
  process.stdout.write(`Edges dropped: ${edgesDropped}\n`);
  process.stdout.write(`Edges after remapping: ${fixedEdges.length}\n\n`);
  
  // Deduplicate edges (undirected)
  const edgeSet = new Set<string>();
  const deduplicatedEdges: Array<{ a: string; b: string; one_way?: boolean; allow_self_loop?: boolean }> = [];
  let duplicatesRemoved = 0;
  
  for (const edge of fixedEdges) {
    const key = normalizedEdgeKey(edge.a, edge.b);
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      deduplicatedEdges.push(edge);
    } else {
      duplicatesRemoved++;
    }
  }
  
  process.stdout.write(`Duplicates removed: ${duplicatesRemoved}\n`);
  process.stdout.write(`Final edge count: ${deduplicatedEdges.length}\n\n`);
  
  // Build remap rules summary (top 50 by frequency)
  const remapRules: RemapRule[] = [];
  for (const [from, toMap] of remapCounts.entries()) {
    for (const [to, count] of toMap.entries()) {
      remapRules.push({ from, to, count });
    }
  }
  remapRules.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });
  const topRemapRules = remapRules.slice(0, 50);
  
  // Build report
  const report: FixReport = {
    endpointsRemapped,
    edgesDropped,
    duplicatesRemoved,
    topRemapRules
  };
  
  // Write fixed edges file
  const edgesJson = {
    version: '1.0.0',
    allow_self_loops_default: false,
    edges: deduplicatedEdges.sort((x, y) => {
      // Deterministic sort: first by a, then by b
      if (x.a !== y.a) return x.a.localeCompare(y.a);
      return x.b.localeCompare(y.b);
    })
  };
  
  await writeFile(edgesPath, JSON.stringify(edgesJson, null, 2), 'utf8');
  process.stdout.write(`Fixed edges written to: ${edgesPath}\n`);
  
  // Write report
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });
  
  const reportPath = resolve(outputDir, 'fix_edges_canonicalize_sids.report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`Report written to: ${reportPath}\n`);
  
  process.stdout.write(`\nTop 10 remap rules:\n`);
  for (const rule of topRemapRules.slice(0, 10)) {
    process.stdout.write(`  ${rule.from} -> ${rule.to} (${rule.count} times)\n`);
  }
}

main().catch((err) => {
  console.error('fix_edges_canonicalize_sids failed', err);
  process.exitCode = 1;
});
