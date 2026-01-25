import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettlementGraph } from '../../src/map/settlements.js';

interface MissingSidInfo {
  sid: string;
  count: number;
  sampleEdgeIndices: number[];
}

interface BaseSidMatch {
  baseSid: string;
  candidates: string[];
}

interface MissingEdgeSidsSummary {
  totalMissingEndpoints: number;
  uniqueMissingSidCount: number;
  missingSids: MissingSidInfo[];
  baseSidMatches: BaseSidMatch[];
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

async function main(): Promise<void> {
  process.stdout.write('Missing Edge SIDs Diagnostic\n');
  process.stdout.write('============================\n\n');
  
  // Load the same data sources as sim_mapcheck
  const settlementsPath = resolve('data/derived/settlements_index.json');
  const edgesPath = resolve('data/derived/settlement_edges.json');
  
  process.stdout.write(`Settlements path: ${settlementsPath}\n`);
  process.stdout.write(`Edges path: ${edgesPath}\n\n`);
  
  const graph = await loadSettlementGraph();
  
  process.stdout.write(`Loaded ${graph.settlements.size} settlements, ${graph.edges.length} edges\n\n`);
  
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
  
  // Scan edges for missing endpoints
  const missingSidCounts = new Map<string, number>();
  const missingSidEdgeIndices = new Map<string, number[]>();
  let totalMissingEndpoints = 0;
  
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    
    // Check endpoint a
    if (!sidSet.has(edge.a)) {
      totalMissingEndpoints++;
      missingSidCounts.set(edge.a, (missingSidCounts.get(edge.a) || 0) + 1);
      if (!missingSidEdgeIndices.has(edge.a)) {
        missingSidEdgeIndices.set(edge.a, []);
      }
      const indices = missingSidEdgeIndices.get(edge.a)!;
      if (indices.length < 5) {
        indices.push(i);
      }
    }
    
    // Check endpoint b
    if (!sidSet.has(edge.b)) {
      totalMissingEndpoints++;
      missingSidCounts.set(edge.b, (missingSidCounts.get(edge.b) || 0) + 1);
      if (!missingSidEdgeIndices.has(edge.b)) {
        missingSidEdgeIndices.set(edge.b, []);
      }
      const indices = missingSidEdgeIndices.get(edge.b)!;
      if (indices.length < 5) {
        indices.push(i);
      }
    }
  }
  
  const uniqueMissingSidCount = missingSidCounts.size;
  
  process.stdout.write(`Total missing endpoints: ${totalMissingEndpoints}\n`);
  process.stdout.write(`Unique missing SID count: ${uniqueMissingSidCount}\n\n`);
  
  // Build missingSids array (sorted by count desc, sid asc)
  const missingSids: MissingSidInfo[] = Array.from(missingSidCounts.entries())
    .map(([sid, count]) => ({
      sid,
      count,
      sampleEdgeIndices: missingSidEdgeIndices.get(sid) || []
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.sid.localeCompare(b.sid);
    });
  
  // Build baseSidMatches for missing SIDs that look like base SIDs
  const baseSidMatches: BaseSidMatch[] = [];
  for (const missingSid of missingSids.map(m => m.sid)) {
    if (isBaseSid(missingSid)) {
      const candidates = baseToCandidates.get(missingSid) || [];
      if (candidates.length > 0) {
        // Sort candidates deterministically
        const sortedCandidates = [...candidates].sort((a, b) => a.localeCompare(b));
        baseSidMatches.push({
          baseSid: missingSid,
          candidates: sortedCandidates
        });
      }
    }
  }
  
  // Sort baseSidMatches deterministically
  baseSidMatches.sort((a, b) => a.baseSid.localeCompare(b.baseSid));
  
  // Build summary
  const summary: MissingEdgeSidsSummary = {
    totalMissingEndpoints,
    uniqueMissingSidCount,
    missingSids,
    baseSidMatches
  };
  
  // Write output
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });
  
  const summaryPath = resolve(outputDir, 'missing_edge_sids.summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  
  process.stdout.write(`Summary written to: ${summaryPath}\n`);
  process.stdout.write(`\nTop 10 missing SIDs by count:\n`);
  for (const info of missingSids.slice(0, 10)) {
    process.stdout.write(`  ${info.sid}: ${info.count} occurrences\n`);
  }
  
  if (baseSidMatches.length > 0) {
    process.stdout.write(`\nBase SID matches found: ${baseSidMatches.length}\n`);
    process.stdout.write(`Sample (first 5):\n`);
    for (const match of baseSidMatches.slice(0, 5)) {
      process.stdout.write(`  ${match.baseSid} -> ${match.candidates.length} candidate(s): ${match.candidates.slice(0, 3).join(', ')}${match.candidates.length > 3 ? '...' : ''}\n`);
    }
  }
}

main().catch((err) => {
  console.error('report_missing_edge_sids failed', err);
  process.exitCode = 1;
});
