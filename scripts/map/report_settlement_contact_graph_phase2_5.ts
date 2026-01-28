/**
 * Phase 2.5 Contact Graph Characterization Report
 * 
 * CANONICAL SCRIPT FOR PHASE 2.5 CONTACT GRAPH CHARACTERIZATION
 * 
 * This script reads the Phase 2 enriched contact graph and produces diagnostic
 * reports (JSON + TXT) with distributions, connectivity analysis, and suspicious
 * edge lists. This is diagnostic only: no edge pruning, no eligibility policies,
 * no parameter changes.
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * 
 * Usage:
 *   npm run map:contact:report2_5
 *   or: tsx scripts/map/report_settlement_contact_graph_phase2_5.ts
 * 
 * Outputs:
 *   - data/derived/settlement_contact_graph_phase2_report.json
 *   - data/derived/settlement_contact_graph_phase2_report.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("phase2.5 characterize enriched contact graph and produce report artifacts");

interface EnrichedNode {
  sid: string;
  degree?: number;
  [key: string]: unknown;
}

interface EnrichedEdge {
  a: string;
  b: string;
  type: 'shared_border' | 'point_touch' | 'distance_contact';
  centroid_distance_svg?: number | null;
  contact_span_svg?: number | null;
  bbox_overlap_ratio?: number | null;
  area_ratio?: number | null;
  perimeter_ratio?: number | null;
  overlap_len?: number | null;
  min_dist?: number | null;
  [key: string]: unknown;
}

interface EnrichedGraph {
  schema_version?: number;
  parameters?: Record<string, unknown>;
  nodes?: EnrichedNode[];
  edges?: EnrichedEdge[];
  [key: string]: unknown;
}

interface DistributionStats {
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean?: number;
}

interface Component {
  size: number;
  node_sids_sorted: string[];
}

interface SuspiciousEdge {
  a: string;
  b: string;
  type: string;
  key_metric_value: number | null;
  centroid_distance_svg: number | null;
  bbox_overlap_ratio: number | null;
  min_dist: number | null;
  overlap_len: number | null;
}

interface Phase2Report {
  meta: {
    version: string;
    inputs: {
      enriched_graph_path: string;
    };
    hashes: {
      sha256_enriched_graph: string;
      sha256_report_json: string;
      sha256_report_txt: string;
    };
    counts: {
      nodes: number;
      edges: number;
      edges_by_type: {
        shared_border: number;
        point_touch: number;
        distance_contact: number;
      };
    };
  };
  distributions: {
    degree: DistributionStats;
    centroid_distance_svg: {
      shared_border: DistributionStats | null;
      point_touch: DistributionStats | null;
      distance_contact: DistributionStats | null;
    };
    contact_span_svg: {
      shared_border: DistributionStats | null;
      point_touch: DistributionStats | null;
      distance_contact: DistributionStats | null;
    };
    bbox_overlap_ratio: {
      shared_border: DistributionStats | null;
      point_touch: DistributionStats | null;
      distance_contact: DistributionStats | null;
    };
    area_ratio: {
      shared_border: DistributionStats | null;
      point_touch: DistributionStats | null;
      distance_contact: DistributionStats | null;
    };
    perimeter_ratio: {
      shared_border: DistributionStats | null;
      point_touch: DistributionStats | null;
      distance_contact: DistributionStats | null;
    };
  };
  connectivity: {
    connected_components: {
      count: number;
      largest_component_size: number;
      size_distribution: {
        min: number;
        p50: number;
        p90: number;
        max: number;
      };
      small_components: Component[];
    };
  };
  suspicious_lists: {
    distance_contact_longest_centroid_distance: {
      total_qualifying: number;
      top_200: SuspiciousEdge[];
    };
    distance_contact_lowest_bbox_overlap: {
      total_qualifying: number;
      top_200: SuspiciousEdge[];
    };
    shared_border_smallest_overlap_len: {
      total_qualifying: number;
      top_200: SuspiciousEdge[];
      note?: string;
    };
    distance_contact_min_dist_zero: {
      total_qualifying: number;
      top_200: SuspiciousEdge[];
    };
  };
  notes: {
    missing_metrics: {
      centroid_distance_svg: number;
      contact_span_svg: number;
      bbox_overlap_ratio: number;
      area_ratio: number;
      perimeter_ratio: number;
      overlap_len: number;
      min_dist: number;
    };
    schema_anomalies: {
      unknown_edge_types: string[];
      missing_endpoints: number;
    };
  };
}

/**
 * Compute percentile from sorted array (deterministic)
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * Compute distribution stats from numeric array
 */
function computeDistributionStats(values: number[]): DistributionStats | null {
  if (values.length === 0) {
    return null;
  }
  
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / values.length;
  
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean
  };
}

/**
 * Compute SHA256 hash of file content
 */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Find connected components using union-find
 */
function findConnectedComponents(edges: EnrichedEdge[]): Component[] {
  const nodeMap = new Map<string, string>();
  const nodeToRoot = new Map<string, string>();
  
  // Collect all nodes
  for (const edge of edges) {
    if (!nodeMap.has(edge.a)) {
      nodeMap.set(edge.a, edge.a);
      nodeToRoot.set(edge.a, edge.a);
    }
    if (!nodeMap.has(edge.b)) {
      nodeMap.set(edge.b, edge.b);
      nodeToRoot.set(edge.b, edge.b);
    }
  }
  
  // Union-find: find root
  function find(node: string): string {
    let root = nodeToRoot.get(node)!;
    while (root !== nodeToRoot.get(root)!) {
      const parent = nodeToRoot.get(root)!;
      nodeToRoot.set(root, nodeToRoot.get(parent)!);
      root = nodeToRoot.get(parent)!;
    }
    return root;
  }
  
  // Union-find: union
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      nodeToRoot.set(rootB, rootA);
    }
  }
  
  // Process edges
  for (const edge of edges) {
    union(edge.a, edge.b);
  }
  
  // Collect components
  const componentMap = new Map<string, string[]>();
  for (const node of nodeMap.keys()) {
    const root = find(node);
    if (!componentMap.has(root)) {
      componentMap.set(root, []);
    }
    componentMap.get(root)!.push(node);
  }
  
  // Convert to Component[] with deterministic sorting
  const components: Component[] = [];
  for (const [root, sids] of componentMap.entries()) {
    const sortedSids = [...sids].sort();
    components.push({
      size: sortedSids.length,
      node_sids_sorted: sortedSids
    });
  }
  
  // Sort components: by size asc, then by first sid lexicographic
  components.sort((a, b) => {
    if (a.size !== b.size) {
      return a.size - b.size;
    }
    if (a.node_sids_sorted.length === 0 || b.node_sids_sorted.length === 0) {
      return 0;
    }
    return a.node_sids_sorted[0].localeCompare(b.node_sids_sorted[0]);
  });
  
  return components;
}

async function main(): Promise<void> {
  const enrichedGraphPath = resolve('data/derived/settlement_contact_graph_enriched.json');
  const outputDir = resolve('data/derived');
  const reportJsonPath = resolve(outputDir, 'settlement_contact_graph_phase2_report.json');
  const reportTxtPath = resolve(outputDir, 'settlement_contact_graph_phase2_report.txt');
  
  mkdirSync(outputDir, { recursive: true });
  
  // Load enriched graph
  process.stdout.write(`Loading ${enrichedGraphPath}...\n`);
  const enrichedGraphContent = readFileSync(enrichedGraphPath, 'utf8');
  const enrichedGraphHash = sha256(enrichedGraphContent);
  const enrichedGraph = JSON.parse(enrichedGraphContent) as EnrichedGraph;
  
  // Normalize graph format
  let nodes: EnrichedNode[] = [];
  let edges: EnrichedEdge[] = [];
  
  if (enrichedGraph.nodes && Array.isArray(enrichedGraph.nodes)) {
    nodes = enrichedGraph.nodes;
  }
  
  if (enrichedGraph.edges && Array.isArray(enrichedGraph.edges)) {
    edges = enrichedGraph.edges;
  }
  
  if (nodes.length === 0 || edges.length === 0) {
    throw new Error('Graph missing nodes or edges');
  }
  
  // Compute node degree from edges (undirected)
  const degreeMap = new Map<string, number>();
  for (const node of nodes) {
    degreeMap.set(node.sid, 0);
  }
  for (const edge of edges) {
    const degA = degreeMap.get(edge.a) ?? 0;
    const degB = degreeMap.get(edge.b) ?? 0;
    degreeMap.set(edge.a, degA + 1);
    degreeMap.set(edge.b, degB + 1);
  }
  const degrees = Array.from(degreeMap.values());
  
  // Count edges by type
  const edgesByType = {
    shared_border: edges.filter(e => e.type === 'shared_border').length,
    point_touch: edges.filter(e => e.type === 'point_touch').length,
    distance_contact: edges.filter(e => e.type === 'distance_contact').length
  };
  
  // Collect edge types for anomaly detection
  const edgeTypes = new Set<string>();
  let missingEndpoints = 0;
  for (const edge of edges) {
    edgeTypes.add(edge.type);
    if (!edge.a || !edge.b) {
      missingEndpoints++;
    }
  }
  const unknownEdgeTypes = Array.from(edgeTypes).filter(
    t => t !== 'shared_border' && t !== 'point_touch' && t !== 'distance_contact'
  ).sort();
  
  // Compute distributions by type
  const distributionsByType = (field: keyof EnrichedEdge) => {
    const sharedBorder = edges
      .filter(e => e.type === 'shared_border' && e[field] !== null && e[field] !== undefined && typeof e[field] === 'number')
      .map(e => e[field] as number);
    
    const pointTouch = edges
      .filter(e => e.type === 'point_touch' && e[field] !== null && e[field] !== undefined && typeof e[field] === 'number')
      .map(e => e[field] as number);
    
    const distanceContact = edges
      .filter(e => e.type === 'distance_contact' && e[field] !== null && e[field] !== undefined && typeof e[field] === 'number')
      .map(e => e[field] as number);
    
    return {
      shared_border: computeDistributionStats(sharedBorder),
      point_touch: computeDistributionStats(pointTouch),
      distance_contact: computeDistributionStats(distanceContact)
    };
  };
  
  // Missing metrics counts
  const missingMetrics = {
    centroid_distance_svg: edges.filter(e => e.centroid_distance_svg === null || e.centroid_distance_svg === undefined).length,
    contact_span_svg: edges.filter(e => e.contact_span_svg === null || e.contact_span_svg === undefined).length,
    bbox_overlap_ratio: edges.filter(e => e.bbox_overlap_ratio === null || e.bbox_overlap_ratio === undefined).length,
    area_ratio: edges.filter(e => e.area_ratio === null || e.area_ratio === undefined).length,
    perimeter_ratio: edges.filter(e => e.perimeter_ratio === null || e.perimeter_ratio === undefined).length,
    overlap_len: edges.filter(e => e.overlap_len === null || e.overlap_len === undefined).length,
    min_dist: edges.filter(e => e.min_dist === null || e.min_dist === undefined).length
  };
  
  // Connectivity analysis
  const components = findConnectedComponents(edges);
  const componentSizes = components.map(c => c.size).sort((a, b) => a - b);
  const sizeDistribution = componentSizes.length > 0 ? {
    min: componentSizes[0],
    p50: percentile(componentSizes, 50),
    p90: percentile(componentSizes, 90),
    max: componentSizes[componentSizes.length - 1]
  } : { min: 0, p50: 0, p90: 0, max: 0 };
  
  const smallComponents = components.filter(c => c.size <= 5);
  
  // Suspicious lists
  const minSid = (a: string, b: string) => a < b ? a : b;
  const maxSid = (a: string, b: string) => a > b ? a : b;
  
  // distance_contact_longest_centroid_distance
  const distanceContactLongest = edges
    .filter(e => e.type === 'distance_contact' && e.centroid_distance_svg !== null && e.centroid_distance_svg !== undefined)
    .map(e => ({
      edge: e,
      value: e.centroid_distance_svg!,
      minSid: minSid(e.a, e.b),
      maxSid: maxSid(e.a, e.b)
    }))
    .sort((a, b) => {
      if (b.value !== a.value) {
        return b.value - a.value;
      }
      if (a.minSid !== b.minSid) {
        return a.minSid.localeCompare(b.minSid);
      }
      return a.maxSid.localeCompare(b.maxSid);
    })
    .map(item => ({
      a: item.edge.a,
      b: item.edge.b,
      type: item.edge.type,
      key_metric_value: item.value,
      centroid_distance_svg: item.edge.centroid_distance_svg ?? null,
      bbox_overlap_ratio: item.edge.bbox_overlap_ratio ?? null,
      min_dist: item.edge.min_dist ?? null,
      overlap_len: item.edge.overlap_len ?? null
    }));
  
  // distance_contact_lowest_bbox_overlap
  const distanceContactLowestOverlap = edges
    .filter(e => e.type === 'distance_contact' && e.bbox_overlap_ratio !== null && e.bbox_overlap_ratio !== undefined)
    .map(e => ({
      edge: e,
      value: e.bbox_overlap_ratio!,
      minSid: minSid(e.a, e.b),
      maxSid: maxSid(e.a, e.b)
    }))
    .sort((a, b) => {
      if (a.value !== b.value) {
        return a.value - b.value;
      }
      if (a.minSid !== b.minSid) {
        return a.minSid.localeCompare(b.minSid);
      }
      return a.maxSid.localeCompare(b.maxSid);
    })
    .map(item => ({
      a: item.edge.a,
      b: item.edge.b,
      type: item.edge.type,
      key_metric_value: item.value,
      centroid_distance_svg: item.edge.centroid_distance_svg ?? null,
      bbox_overlap_ratio: item.edge.bbox_overlap_ratio ?? null,
      min_dist: item.edge.min_dist ?? null,
      overlap_len: item.edge.overlap_len ?? null
    }));
  
  // shared_border_smallest_overlap_len
  const sharedBorderSmallestOverlap = edges
    .filter(e => e.type === 'shared_border' && e.overlap_len !== null && e.overlap_len !== undefined)
    .map(e => ({
      edge: e,
      value: e.overlap_len!,
      minSid: minSid(e.a, e.b),
      maxSid: maxSid(e.a, e.b)
    }))
    .sort((a, b) => {
      if (a.value !== b.value) {
        return a.value - b.value;
      }
      if (a.minSid !== b.minSid) {
        return a.minSid.localeCompare(b.minSid);
      }
      return a.maxSid.localeCompare(b.maxSid);
    })
    .map(item => ({
      a: item.edge.a,
      b: item.edge.b,
      type: item.edge.type,
      key_metric_value: item.value,
      centroid_distance_svg: item.edge.centroid_distance_svg ?? null,
      bbox_overlap_ratio: item.edge.bbox_overlap_ratio ?? null,
      min_dist: item.edge.min_dist ?? null,
      overlap_len: item.edge.overlap_len ?? null
    }));
  
  // distance_contact_min_dist_zero
  const distanceContactMinDistZero = edges
    .filter(e => e.type === 'distance_contact' && e.min_dist !== null && e.min_dist !== undefined && e.min_dist <= 0)
    .map(e => ({
      edge: e,
      minSid: minSid(e.a, e.b),
      maxSid: maxSid(e.a, e.b)
    }))
    .sort((a, b) => {
      if (a.minSid !== b.minSid) {
        return a.minSid.localeCompare(b.minSid);
      }
      return a.maxSid.localeCompare(b.maxSid);
    })
    .map(item => ({
      a: item.edge.a,
      b: item.edge.b,
      type: item.edge.type,
      key_metric_value: item.edge.min_dist ?? null,
      centroid_distance_svg: item.edge.centroid_distance_svg ?? null,
      bbox_overlap_ratio: item.edge.bbox_overlap_ratio ?? null,
      min_dist: item.edge.min_dist ?? null,
      overlap_len: item.edge.overlap_len ?? null
    }));
  
  // Build report
  const report: Phase2Report = {
    meta: {
      version: 'phase2_5_report_v1',
      inputs: {
        enriched_graph_path: 'data/derived/settlement_contact_graph_enriched.json'
      },
      hashes: {
        sha256_enriched_graph: enrichedGraphHash,
        sha256_report_json: '', // Will compute after JSON generation
        sha256_report_txt: '' // Will compute after TXT generation
      },
      counts: {
        nodes: nodes.length,
        edges: edges.length,
        edges_by_type: edgesByType
      }
    },
    distributions: {
      degree: computeDistributionStats(degrees) ?? { min: 0, p50: 0, p90: 0, p99: 0, max: 0 },
      centroid_distance_svg: distributionsByType('centroid_distance_svg'),
      contact_span_svg: distributionsByType('contact_span_svg'),
      bbox_overlap_ratio: distributionsByType('bbox_overlap_ratio'),
      area_ratio: distributionsByType('area_ratio'),
      perimeter_ratio: distributionsByType('perimeter_ratio')
    },
    connectivity: {
      connected_components: {
        count: components.length,
        largest_component_size: components.length > 0 ? Math.max(...componentSizes) : 0,
        size_distribution: sizeDistribution,
        small_components: smallComponents
      }
    },
    suspicious_lists: {
      distance_contact_longest_centroid_distance: {
        total_qualifying: distanceContactLongest.length,
        top_200: distanceContactLongest.slice(0, 200)
      },
      distance_contact_lowest_bbox_overlap: {
        total_qualifying: distanceContactLowestOverlap.length,
        top_200: distanceContactLowestOverlap.slice(0, 200)
      },
      shared_border_smallest_overlap_len: {
        total_qualifying: sharedBorderSmallestOverlap.length,
        top_200: sharedBorderSmallestOverlap.slice(0, 200),
        note: sharedBorderSmallestOverlap.length === 0 ? 'No shared_border edges have overlap_len field' : undefined
      },
      distance_contact_min_dist_zero: {
        total_qualifying: distanceContactMinDistZero.length,
        top_200: distanceContactMinDistZero.slice(0, 200)
      }
    },
    notes: {
      missing_metrics: missingMetrics,
      schema_anomalies: {
        unknown_edge_types: unknownEdgeTypes,
        missing_endpoints: missingEndpoints
      }
    }
  };
  
  // Generate JSON report
  const reportJson = JSON.stringify(report, null, 2) + '\n';
  const reportJsonHash = sha256(reportJson);
  report.meta.hashes.sha256_report_json = reportJsonHash;
  
  // Regenerate JSON with updated hash
  const finalReportJson = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(reportJsonPath, finalReportJson, 'utf8');
  process.stdout.write(`Wrote ${reportJsonPath}\n`);
  
  // Generate TXT report
  const txtLines: string[] = [];
  txtLines.push('Phase 2.5 Contact Graph Characterization Report');
  txtLines.push('='.repeat(60));
  txtLines.push('');
  txtLines.push(`Nodes: ${report.meta.counts.nodes}`);
  txtLines.push(`Edges: ${report.meta.counts.edges}`);
  txtLines.push(`  - Shared-border: ${report.meta.counts.edges_by_type.shared_border}`);
  txtLines.push(`  - Point-touch: ${report.meta.counts.edges_by_type.point_touch}`);
  txtLines.push(`  - Distance-contact: ${report.meta.counts.edges_by_type.distance_contact}`);
  txtLines.push('');
  
  // Degree distribution
  txtLines.push('Degree Distribution (Overall):');
  const degStats = report.distributions.degree;
  txtLines.push(`  Min: ${degStats.min}, P50: ${degStats.p50}, P90: ${degStats.p90}, P99: ${degStats.p99}, Max: ${degStats.max}`);
  if (degStats.mean !== undefined) {
    txtLines.push(`  Mean: ${degStats.mean.toFixed(3)}`);
  }
  txtLines.push('');
  
  // Distributions by type
  const typeNames = ['shared_border', 'point_touch', 'distance_contact'] as const;
  const metricNames = [
    { key: 'centroid_distance_svg', label: 'Centroid Distance (SVG)' },
    { key: 'contact_span_svg', label: 'Contact Span (SVG)' },
    { key: 'bbox_overlap_ratio', label: 'BBox Overlap Ratio' },
    { key: 'area_ratio', label: 'Area Ratio' },
    { key: 'perimeter_ratio', label: 'Perimeter Ratio' }
  ] as const;
  
  for (const metric of metricNames) {
    txtLines.push(`${metric.label} Distribution:`);
    for (const type of typeNames) {
      const stats = report.distributions[metric.key as keyof typeof report.distributions][type];
      if (stats) {
        txtLines.push(`  ${type}: Min=${stats.min.toFixed(3)}, P50=${stats.p50.toFixed(3)}, P90=${stats.p90.toFixed(3)}, P99=${stats.p99.toFixed(3)}, Max=${stats.max.toFixed(3)}`);
        if (stats.mean !== undefined) {
          txtLines.push(`    Mean: ${stats.mean.toFixed(3)}`);
        }
      } else {
        txtLines.push(`  ${type}: (no data)`);
      }
    }
    txtLines.push('');
  }
  
  // Connectivity
  txtLines.push('Connectivity:');
  txtLines.push(`  Connected Components: ${report.connectivity.connected_components.count}`);
  txtLines.push(`  Largest Component Size: ${report.connectivity.connected_components.largest_component_size}`);
  txtLines.push(`  Size Distribution: Min=${report.connectivity.connected_components.size_distribution.min}, P50=${report.connectivity.connected_components.size_distribution.p50}, P90=${report.connectivity.connected_components.size_distribution.p90}, Max=${report.connectivity.connected_components.size_distribution.max}`);
  txtLines.push(`  Small Components (size <= 5): ${report.connectivity.connected_components.small_components.length}`);
  txtLines.push('');
  
  // Suspicious lists (top 20)
  txtLines.push('Suspicious Lists (Top 20):');
  txtLines.push('');
  
  txtLines.push(`Distance-Contact Longest Centroid Distance (total: ${report.suspicious_lists.distance_contact_longest_centroid_distance.total_qualifying}):`);
  for (const edge of report.suspicious_lists.distance_contact_longest_centroid_distance.top_200.slice(0, 20)) {
    txtLines.push(`  ${edge.a} <-> ${edge.b}: ${edge.key_metric_value?.toFixed(3)}`);
  }
  txtLines.push('');
  
  txtLines.push(`Distance-Contact Lowest BBox Overlap (total: ${report.suspicious_lists.distance_contact_lowest_bbox_overlap.total_qualifying}):`);
  for (const edge of report.suspicious_lists.distance_contact_lowest_bbox_overlap.top_200.slice(0, 20)) {
    txtLines.push(`  ${edge.a} <-> ${edge.b}: ${edge.key_metric_value?.toFixed(3)}`);
  }
  txtLines.push('');
  
  txtLines.push(`Shared-Border Smallest Overlap Length (total: ${report.suspicious_lists.shared_border_smallest_overlap_len.total_qualifying}):`);
  if (report.suspicious_lists.shared_border_smallest_overlap_len.note) {
    txtLines.push(`  ${report.suspicious_lists.shared_border_smallest_overlap_len.note}`);
  } else {
    for (const edge of report.suspicious_lists.shared_border_smallest_overlap_len.top_200.slice(0, 20)) {
      txtLines.push(`  ${edge.a} <-> ${edge.b}: ${edge.key_metric_value?.toFixed(3)}`);
    }
  }
  txtLines.push('');
  
  txtLines.push(`Distance-Contact Min Dist Zero (total: ${report.suspicious_lists.distance_contact_min_dist_zero.total_qualifying}):`);
  for (const edge of report.suspicious_lists.distance_contact_min_dist_zero.top_200.slice(0, 20)) {
    txtLines.push(`  ${edge.a} <-> ${edge.b}: min_dist=${edge.min_dist}`);
  }
  txtLines.push('');
  
  // Notes
  txtLines.push('Notes:');
  txtLines.push('Missing Metrics:');
  txtLines.push(`  centroid_distance_svg: ${report.notes.missing_metrics.centroid_distance_svg}`);
  txtLines.push(`  contact_span_svg: ${report.notes.missing_metrics.contact_span_svg}`);
  txtLines.push(`  bbox_overlap_ratio: ${report.notes.missing_metrics.bbox_overlap_ratio}`);
  txtLines.push(`  area_ratio: ${report.notes.missing_metrics.area_ratio}`);
  txtLines.push(`  perimeter_ratio: ${report.notes.missing_metrics.perimeter_ratio}`);
  txtLines.push(`  overlap_len: ${report.notes.missing_metrics.overlap_len}`);
  txtLines.push(`  min_dist: ${report.notes.missing_metrics.min_dist}`);
  txtLines.push('');
  
  if (report.notes.schema_anomalies.unknown_edge_types.length > 0) {
    txtLines.push(`Unknown Edge Types: ${report.notes.schema_anomalies.unknown_edge_types.join(', ')}`);
  }
  if (report.notes.schema_anomalies.missing_endpoints > 0) {
    txtLines.push(`Missing Endpoints: ${report.notes.schema_anomalies.missing_endpoints}`);
  }
  
  const reportTxt = txtLines.join('\n') + '\n';
  const reportTxtHash = sha256(reportTxt);
  report.meta.hashes.sha256_report_txt = reportTxtHash;
  
  // Regenerate JSON with updated TXT hash
  const finalReportJsonWithTxtHash = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(reportJsonPath, finalReportJsonWithTxtHash, 'utf8');
  
  writeFileSync(reportTxtPath, reportTxt, 'utf8');
  process.stdout.write(`Wrote ${reportTxtPath}\n`);
  
  process.stdout.write('Done.\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
