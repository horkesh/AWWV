import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettlementGraph, validateSettlementGraph } from '../map/settlements.js';

async function main(): Promise<void> {
  const settlementsPath = resolve('data/derived/settlements_index.json');
  const edgesPath = resolve('data/derived/settlement_edges.json');
  
  process.stdout.write(`Settlements path: ${settlementsPath}\n`);
  process.stdout.write(`Edges path: ${edgesPath}\n\n`);
  
  // Load fallback SIDs for resolver
  const fallbackSids = new Set<string>();
  try {
    const fallbackGeometriesPath = resolve('data/derived/fallback_geometries.json');
    const fallbackData = JSON.parse(await readFile(fallbackGeometriesPath, 'utf8')) as {
      fallbacks?: Array<{ sid: string }>;
    };
    if (fallbackData.fallbacks) {
      for (const fb of fallbackData.fallbacks) {
        fallbackSids.add(fb.sid);
      }
    }
  } catch {
    // File might not exist, continue without fallback info
  }
  
  const graph = await loadSettlementGraph();
  const issues = validateSettlementGraph(graph, { fallbackSids });

  process.stdout.write(`Map check: ${graph.settlements.size} settlements, ${graph.edges.length} edges\n`);

  // Check if edges are empty or missing (must fail)
  if (graph.edges.length === 0) {
    issues.push({
      severity: 'error',
      code: 'edges.empty',
      message: 'settlement_edges.json is empty - adjacency edges must be generated'
    });
  }

  // Compute statistics from the actual edges array being validated
  const degreeMap = new Map<string, number>();
  for (const sid of graph.settlements.keys()) {
    degreeMap.set(sid, 0);
  }
  for (const edge of graph.edges) {
    degreeMap.set(edge.a, (degreeMap.get(edge.a) || 0) + 1);
    degreeMap.set(edge.b, (degreeMap.get(edge.b) || 0) + 1);
  }

  const totalEdges = graph.edges.length;
  const totalSettlements = graph.settlements.size;
  const avgDegree = totalSettlements > 0 ? (totalEdges * 2) / totalSettlements : 0;
  const maxDegree = Math.max(...Array.from(degreeMap.values()), 0);
  const orphanSettlements = Array.from(degreeMap.entries())
    .filter(([_, degree]) => degree === 0)
    .map(([sid, _]) => sid);
  const orphanCount = orphanSettlements.length;

  // Display adjacency statistics computed from actual edges
  process.stdout.write(
    `Adjacency stats: total_edges=${totalEdges}, ` +
    `avg_degree=${avgDegree.toFixed(2)}, ` +
    `orphan_count=${orphanCount}, ` +
    `max_degree=${maxDegree}\n`
  );

  // Try to load edge breakdown from adjacency report (optional, for reference only)
  try {
    const adjacencyReportPath = resolve('data/derived/adjacency_report.json');
    const adjacencyReport = JSON.parse(await readFile(adjacencyReportPath, 'utf8')) as {
      total_edges?: number;
      edge_breakdown?: {
        line?: number;
        touch?: number;
        distance?: number;
      };
    };

    // Warn if report total doesn't match actual (report may be stale)
    if (adjacencyReport.total_edges !== undefined && adjacencyReport.total_edges !== totalEdges) {
      issues.push({
        severity: 'warn',
        code: 'adjacency_report.stale',
        message: `adjacency_report.json total_edges (${adjacencyReport.total_edges}) does not match actual edges (${totalEdges}). Report may be stale.`
      });
    }

    // Print edge_breakdown if available (for reference, not used for validation)
    if (adjacencyReport.edge_breakdown) {
      const breakdown = adjacencyReport.edge_breakdown;
      process.stdout.write(
        `Edge breakdown (from report): line=${breakdown.line ?? 0}, ` +
        `touch=${breakdown.touch ?? 0}, ` +
        `distance=${breakdown.distance ?? 0}\n`
      );
    }
  } catch (err) {
    // Adjacency report is optional - don't error, just skip
  }

  if (orphanSettlements.length > 0) {
    // Report orphans (sample if too many)
    const sampleSize = Math.min(orphanSettlements.length, 20);
    const sample = orphanSettlements.slice(0, sampleSize);
    const more = orphanSettlements.length > sampleSize ? ` (and ${orphanSettlements.length - sampleSize} more)` : '';
    
    issues.push({
      severity: 'warn',
      code: 'orphan.settlements',
      message: `Found ${orphanSettlements.length} orphan settlements (degree 0): ${sample.join(', ')}${more}. These are quarantined and excluded from gameplay logic.`
    });
  }

  // Check for fallback geometries
  try {
    const fallbackGeometriesPath = resolve('data/derived/fallback_geometries.json');
    const fallbackData = JSON.parse(await readFile(fallbackGeometriesPath, 'utf8')) as {
      total_fallbacks: number;
      fallbacks: Array<{ sid: string; mun: string }>;
    };
    
    if (fallbackData.total_fallbacks > 0) {
      issues.push({
        severity: 'warn',
        code: 'fallback.geometries',
        message: `Found ${fallbackData.total_fallbacks} settlement(s) using fallback replacement geometries. These are quarantined pending manual review and excluded from gameplay logic.`
      });
    }
  } catch (err) {
    // Fallback geometries file might not exist if no replacements were used
    // This is fine, skip the check
  }

  // Validate count assertions
  try {
    const auditReportPath = resolve('data/derived/map_raw_audit_report.json');
    const buildReportPath = resolve('data/derived/map_build_report.json');

    const auditReport = JSON.parse(await readFile(auditReportPath, 'utf8')) as {
      total_records: number;
      exact_duplicates: Array<{ records: unknown[] }>;
    };
    const buildReport = JSON.parse(await readFile(buildReportPath, 'utf8')) as {
      stats: {
        total_raw_records: number;
        total_derived_records: number;
        exact_duplicates_collapsed_count: number;
      };
    };

    const expectedDerivedCount =
      auditReport.total_records - buildReport.stats.exact_duplicates_collapsed_count;
    const actualDerivedCount = graph.settlements.size;

    if (actualDerivedCount !== expectedDerivedCount) {
      issues.push({
        severity: 'error',
        code: 'count.mismatch',
        message: `Derived settlement count (${actualDerivedCount}) does not match expected (${expectedDerivedCount} = ${auditReport.total_records} raw - ${buildReport.stats.exact_duplicates_collapsed_count} exact duplicates collapsed)`
      });
    }

    // Check for duplicate sids in derived output
    const sidSet = new Set<string>();
    for (const sid of graph.settlements.keys()) {
      if (sidSet.has(sid)) {
        issues.push({
          severity: 'error',
          code: 'duplicate.sid',
          message: `Duplicate sid found in derived output: ${sid}`
        });
      }
      sidSet.add(sid);
    }
  } catch (err) {
    issues.push({
      severity: 'warn',
      code: 'validation.report_missing',
      message: `Could not load audit/build reports for validation: ${err}`
    });
  }

  if (issues.length === 0) {
    process.stdout.write('No issues found.\n');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warn');
  process.stdout.write(`Issues: ${errors.length} error(s), ${warns.length} warning(s)\n`);

  for (const issue of issues) {
    const loc = issue.path ? ` @ ${issue.path}` : '';
    process.stdout.write(`- [${issue.severity.toUpperCase()}] ${issue.code}${loc}: ${issue.message}\n`);
  }

  if (errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('sim:mapcheck failed', err);
  process.exitCode = 1;
});

