import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSettlementGraph } from '../../src/map/settlements.js';

interface OrphanRecord {
  sid: string;
  baseSid: string | null;
  municipality: string;
  source_js_file?: string;
  geometryType: string;
  usesFallbackGeometry: boolean;
  centroid: { cx: number; cy: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface OrphanSummary {
  totalOrphans: number;
  orphans: OrphanRecord[];
}

type GeoJSONFeature = {
  type: 'Feature';
  properties?: Record<string, unknown>;
  geometry: { type: string; coordinates: any };
};

type GeoJSONFC = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

/**
 * Extract base SID (first two segments) from a SID string.
 */
function getBaseSid(sid: string): string | null {
  const parts = sid.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Compute bounds and centroid from GeoJSON geometry.
 */
function computeBoundsAndCentroid(feature: GeoJSONFeature): {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  centroid: { cx: number; cy: number };
} | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0, n = 0;

  const pushPoint = (pt: any) => {
    if (!Array.isArray(pt) || pt.length < 2) return;
    const x = typeof pt[0] === 'number' && Number.isFinite(pt[0]) ? pt[0] : null;
    const y = typeof pt[1] === 'number' && Number.isFinite(pt[1]) ? pt[1] : null;
    if (x === null || y === null) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    sumX += x;
    sumY += y;
    n++;
  };

  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const outer = Array.isArray(geom.coordinates) ? geom.coordinates[0] : null;
    if (Array.isArray(outer)) {
      for (const pt of outer) pushPoint(pt);
    }
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates;
    if (Array.isArray(polys)) {
      for (const poly of polys) {
        const outer = Array.isArray(poly) ? poly[0] : null;
        if (Array.isArray(outer)) {
          for (const pt of outer) pushPoint(pt);
        }
      }
    }
  } else {
    return null;
  }

  if (!Number.isFinite(minX) || n === 0) return null;

  return {
    bounds: { minX, minY, maxX, maxY },
    centroid: { cx: sumX / n, cy: sumY / n }
  };
}

async function main(): Promise<void> {
  process.stdout.write('Orphan Settlements Report\n');
  process.stdout.write('=========================\n\n');

  // Load data
  const settlementsPath = resolve('data/derived/settlements_index.json');
  const edgesPath = resolve('data/derived/settlement_edges.json');
  const polygonsPath = resolve('data/derived/settlements_polygons.geojson');
  const fallbackPath = resolve('data/derived/fallback_geometries.json');

  process.stdout.write(`Settlements path: ${settlementsPath}\n`);
  process.stdout.write(`Edges path: ${edgesPath}\n`);
  process.stdout.write(`Polygons path: ${polygonsPath}\n\n`);

  // Load settlement graph
  const graph = await loadSettlementGraph();

  // Load polygons for geometry info
  const polygonsJson = JSON.parse(await readFile(polygonsPath, 'utf8')) as GeoJSONFC;
  const polygonsMap = new Map<string, GeoJSONFeature>();
  for (const feature of polygonsJson.features) {
    const sid = feature.properties?.sid;
    if (sid && typeof sid === 'string') {
      polygonsMap.set(sid, feature);
    }
  }

  // Load fallback geometries from both sources
  const fallbackSids = new Set<string>();
  try {
    const fallbackData = JSON.parse(await readFile(fallbackPath, 'utf8')) as {
      fallbacks?: Array<{ sid: string }>;
    };
    if (fallbackData.fallbacks) {
      for (const fb of fallbackData.fallbacks) {
        fallbackSids.add(fb.sid);
      }
    }
  } catch {
    // File might not exist
  }

  // Also check settlements_index for geometry_quality field
  const settlementsIndexJson = JSON.parse(await readFile(settlementsPath, 'utf8')) as {
    settlements?: Array<{
      sid: string;
      geometry_quality?: string;
    }>;
  };
  if (settlementsIndexJson.settlements) {
    for (const settlement of settlementsIndexJson.settlements) {
      if (settlement.geometry_quality && (
        settlement.geometry_quality === 'fallback_replacement' ||
        settlement.geometry_quality === 'fallback_convex_hull'
      )) {
        fallbackSids.add(settlement.sid);
      }
    }
  }

  // Compute degree for each settlement
  const degreeMap = new Map<string, number>();
  for (const sid of graph.settlements.keys()) {
    degreeMap.set(sid, 0);
  }
  for (const edge of graph.edges) {
    degreeMap.set(edge.a, (degreeMap.get(edge.a) || 0) + 1);
    degreeMap.set(edge.b, (degreeMap.get(edge.b) || 0) + 1);
  }

  // Identify orphans (degree === 0)
  const orphanSids = Array.from(degreeMap.entries())
    .filter(([_, degree]) => degree === 0)
    .map(([sid, _]) => sid)
    .sort((a, b) => a.localeCompare(b)); // Deterministic ordering

  process.stdout.write(`Total settlements: ${graph.settlements.size}\n`);
  process.stdout.write(`Orphan settlements (degree 0): ${orphanSids.length}\n\n`);

  // Build orphan records
  const orphans: OrphanRecord[] = [];

  for (const sid of orphanSids) {
    const settlement = graph.settlements.get(sid);
    if (!settlement) continue;

    const polygon = polygonsMap.get(sid);
    const geometryInfo = polygon ? computeBoundsAndCentroid(polygon) : null;
    const geometryType = polygon?.geometry.type || 'unknown';

    const baseSid = getBaseSid(sid);
    const usesFallbackGeometry = fallbackSids.has(sid) ||
      settlement.mun_code === undefined; // Check if we can detect from index

    // Get source_js_file from polygon properties if available
    const source_js_file = polygon?.properties?.source_js_file as string | undefined;

    orphans.push({
      sid,
      baseSid,
      municipality: settlement.mun,
      source_js_file,
      geometryType,
      usesFallbackGeometry,
      centroid: geometryInfo?.centroid || { cx: 0, cy: 0 },
      bounds: geometryInfo?.bounds || { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    });
  }

  // Build summary
  const summary: OrphanSummary = {
    totalOrphans: orphans.length,
    orphans
  };

  // Write JSON output
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });

  const jsonPath = resolve(outputDir, 'settlement_orphans.json');
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`JSON output: ${jsonPath}\n`);

  // Write Markdown report
  const reportLines: string[] = [
    '# Orphan Settlements Report',
    '',
    `Total orphan settlements (degree 0): ${summary.totalOrphans}`,
    '',
    '## Summary',
    '',
    'Orphan settlements are settlements with no adjacency edges. These are quarantined and excluded from gameplay logic.',
    '',
    '## Orphan Records',
    '',
    '| SID | Base SID | Municipality | Source File | Geometry Type | Fallback | Centroid | Bounds |',
    '|-----|----------|-------------|-------------|---------------|----------|---------|--------|'
  ];

  for (const orphan of orphans) {
    const baseSidStr = orphan.baseSid || '-';
    const sourceFileStr = orphan.source_js_file || '-';
    const fallbackStr = orphan.usesFallbackGeometry ? 'Yes' : 'No';
    const centroidStr = `${orphan.centroid.cx.toFixed(2)}, ${orphan.centroid.cy.toFixed(2)}`;
    const boundsStr = `[${orphan.bounds.minX.toFixed(2)}, ${orphan.bounds.minY.toFixed(2)}, ${orphan.bounds.maxX.toFixed(2)}, ${orphan.bounds.maxY.toFixed(2)}]`;

    reportLines.push(
      `| ${orphan.sid} | ${baseSidStr} | ${orphan.municipality} | ${sourceFileStr} | ${orphan.geometryType} | ${fallbackStr} | ${centroidStr} | ${boundsStr} |`
    );
  }

  const reportPath = resolve(outputDir, 'settlement_orphans.report.md');
  await writeFile(reportPath, reportLines.join('\n'), 'utf8');
  process.stdout.write(`Markdown report: ${reportPath}\n`);
}

main().catch((err) => {
  console.error('report_orphan_settlements failed', err);
  process.exitCode = 1;
});
