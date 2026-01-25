/**
 * Diagnostic: Report settlements whose centroids fall outside their parent municipality boundary.
 * 
 * Municipality boundaries are constructed by unioning all settlement polygons for each municipality.
 * This provides a stronger invariant than "inside MAIN bounds" - each settlement must be
 * inside its own municipality's union boundary.
 * 
 * Usage:
 *   tsx scripts/map/report_settlements_outside_municipality.ts
 * 
 * Inputs:
 *   - data/derived/settlements_polygons.normalized.v1.geojson
 * 
 * Outputs:
 *   - data/derived/settlements_outside_municipality.summary.json
 *   - data/derived/settlements_outside_municipality.report.md
 * 
 * Note: Municipality boundaries are constructed from settlement polygons.
 * 
 * Dataset search results:
 * - No separate municipality boundary GeoJSON found in data/derived/*municipal*.geojson
 * - No separate municipality boundary GeoJSON found in data/derived/*opstin*.geojson
 * - No separate municipality boundary GeoJSON found in data/derived/*municipality*_polygons*.geojson
 * 
 * Chosen approach: Construct boundaries by unioning all settlement polygons per municipality.
 * Municipality key extracted from properties.source_js_file (format: "MunicipalityName_XXXXX.js").
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type GeoJSONFeature = { type: 'Feature'; properties?: Record<string, unknown>; geometry: { type: string; coordinates: any } };
type GeoJSONFC = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

interface CentroidRecord {
  sid: string;
  cx: number;
  cy: number;
  municipalityKey: string;
}

interface MunicipalityStats {
  municipalityKey: string;
  featureCount: number;
  outsideCount: number;
  outsideRate: number;
}

interface OutsideSummary {
  totalSettlements: number;
  missingMunicipalityMatches: number;
  outsideCount: number;
  outsidePercent: number;
  perMunicipality: MunicipalityStats[];
}

/**
 * Copy of validator's toFiniteNumber function.
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Copy of validator's computeBoundsAndCentroid function.
 * Computes centroid from ALL finite points of the OUTER ring for Polygon;
 * same handling for MultiPolygon if present.
 */
function computeBoundsAndCentroid(feature: GeoJSONFeature): { sid: string; bounds: Bounds; cx: number; cy: number; ok: boolean } {
  const sid = (feature.properties as any)?.sid;
  const sidStr = sid == null ? '' : String(sid);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0, n = 0;
  const pushPoint = (pt: any) => {
    if (!Array.isArray(pt) || pt.length < 2) return;
    const x = toFiniteNumber(pt[0]);
    const y = toFiniteNumber(pt[1]);
    if (x === null || y === null) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    sumX += x; sumY += y; n++;
  };
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const outer = Array.isArray(geom.coordinates) ? geom.coordinates[0] : null;
    if (Array.isArray(outer)) for (const pt of outer) pushPoint(pt);
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates;
    if (Array.isArray(polys)) for (const poly of polys) {
      const outer = Array.isArray(poly) ? poly[0] : null;
      if (Array.isArray(outer)) for (const pt of outer) pushPoint(pt);
    }
  } else {
    return { sid: sidStr, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, cx: 0, cy: 0, ok: false };
  }
  if (!sidStr || !Number.isFinite(minX) || n === 0) return { sid: sidStr, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, cx: 0, cy: 0, ok: false };
  return { sid: sidStr, bounds: { minX, minY, maxX, maxY }, cx: sumX / n, cy: sumY / n, ok: true };
}

/**
 * Extract municipality key from source_js_file.
 * Format: "MunicipalityName_XXXXX.js" -> "MunicipalityName"
 * Or use mun_code if available.
 */
function extractMunicipalityKey(feature: GeoJSONFeature): string | null {
  const props = feature.properties || {};
  const sourceFile = String(props.source_js_file || '');
  if (sourceFile && sourceFile !== '(missing)') {
    // Extract municipality name from "MunicipalityName_XXXXX.js"
    const match = sourceFile.match(/^([^_]+)_/);
    if (match) return match[1];
  }
  // Fallback to mun_code if available
  const munCode = props.mun_code;
  if (munCode != null) return String(munCode);
  return null;
}

/**
 * Point-in-polygon test using Turf.js.
 * Tests if point (cx, cy) is inside the municipality polygon (outer ring only).
 */
function pointInPolygon(cx: number, cy: number, municipalityPolygon: turf.Feature<turf.Polygon | turf.MultiPolygon>): boolean {
  const point = turf.point([cx, cy]);
  return turf.booleanPointInPolygon(point, municipalityPolygon);
}

/**
 * Construct municipality boundary by unioning all settlement polygons for that municipality.
 */
function constructMunicipalityBoundary(features: GeoJSONFeature[], municipalityKey: string): turf.Feature<turf.Polygon | turf.MultiPolygon> | null {
  const municipalityFeatures = features.filter(f => {
    const key = extractMunicipalityKey(f);
    return key === municipalityKey;
  });

  if (municipalityFeatures.length === 0) return null;

  // Union all polygons for this municipality
  let union: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;

  for (const feature of municipalityFeatures) {
    const geom = feature.geometry;
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;

    try {
      const turfFeature = turf.feature(geom) as turf.Feature<turf.Polygon | turf.MultiPolygon>;
      if (!turf.booleanValid(turfFeature)) continue;

      if (union === null) {
        union = turfFeature;
      } else {
        try {
          union = turf.union(union, turfFeature) as turf.Feature<turf.Polygon | turf.MultiPolygon>;
        } catch (err) {
          // Skip if union fails
          continue;
        }
      }
    } catch (err) {
      // Skip invalid geometries
      continue;
    }
  }

  return union;
}

async function main(): Promise<void> {
  process.stdout.write('Settlements outside municipality diagnostic\n');
  process.stdout.write('==========================================\n\n');
  
  // Load input
  const inputPath = resolve('data/derived/settlements_polygons.normalized.v1.geojson');
  process.stdout.write(`  Input: ${inputPath}\n\n`);
  
  const fc = JSON.parse(await readFile(inputPath, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${inputPath}`);
  }
  
  process.stdout.write(`  Loaded ${fc.features.length} features\n\n`);
  
  // Compute centroids and group by municipality
  process.stdout.write('Computing centroids and grouping by municipality...\n');
  const centroids: CentroidRecord[] = [];
  const municipalityKeys = new Set<string>();
  let badFeatures = 0;
  let missingMunicipalityKey = 0;
  
  for (const f of fc.features) {
    const r = computeBoundsAndCentroid(f);
    if (!r.ok) {
      badFeatures++;
      continue;
    }
    const municipalityKey = extractMunicipalityKey(f);
    if (!municipalityKey) {
      missingMunicipalityKey++;
      continue;
    }
    municipalityKeys.add(municipalityKey);
    centroids.push({
      sid: r.sid,
      cx: r.cx,
      cy: r.cy,
      municipalityKey
    });
  }
  
  process.stdout.write(`  Valid centroids: ${centroids.length}\n`);
  if (badFeatures > 0) {
    process.stdout.write(`  Bad features: ${badFeatures}\n`);
  }
  if (missingMunicipalityKey > 0) {
    process.stdout.write(`  Missing municipality key: ${missingMunicipalityKey}\n`);
  }
  process.stdout.write(`  Municipalities: ${municipalityKeys.size}\n\n`);
  
  // Construct municipality boundaries
  process.stdout.write('Constructing municipality boundaries...\n');
  const municipalityBoundaries = new Map<string, turf.Feature<turf.Polygon | turf.MultiPolygon>>();
  const sortedKeys = Array.from(municipalityKeys).sort();
  
  for (const key of sortedKeys) {
    const boundary = constructMunicipalityBoundary(fc.features, key);
    if (boundary) {
      municipalityBoundaries.set(key, boundary);
    }
  }
  
  process.stdout.write(`  Constructed boundaries: ${municipalityBoundaries.size}\n\n`);
  
  // Test each centroid against its municipality boundary
  process.stdout.write('Testing centroids against municipality boundaries...\n');
  const municipalityStats = new Map<string, { featureCount: number; outsideCount: number }>();
  let outsideCount = 0;
  let missingBoundaryCount = 0;
  
  for (const centroid of centroids) {
    const stats = municipalityStats.get(centroid.municipalityKey) || { featureCount: 0, outsideCount: 0 };
    stats.featureCount++;
    municipalityStats.set(centroid.municipalityKey, stats);
    
    const boundary = municipalityBoundaries.get(centroid.municipalityKey);
    if (!boundary) {
      missingBoundaryCount++;
      continue;
    }
    
    const isInside = pointInPolygon(centroid.cx, centroid.cy, boundary);
    if (!isInside) {
      stats.outsideCount++;
      outsideCount++;
    }
  }
  
  process.stdout.write(`  Outside count: ${outsideCount}\n`);
  if (missingBoundaryCount > 0) {
    process.stdout.write(`  Missing boundaries: ${missingBoundaryCount}\n`);
  }
  process.stdout.write('\n');
  
  // Build per-municipality stats
  const perMunicipality: MunicipalityStats[] = [];
  for (const [key, stats] of Array.from(municipalityStats.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const outsideRate = stats.featureCount > 0 ? (stats.outsideCount / stats.featureCount) * 100 : 0;
    perMunicipality.push({
      municipalityKey: key,
      featureCount: stats.featureCount,
      outsideCount: stats.outsideCount,
      outsideRate
    });
  }
  
  // Build summary
  const outsidePercent = centroids.length > 0 ? (outsideCount / centroids.length) * 100 : 0;
  const summary: OutsideSummary = {
    totalSettlements: centroids.length,
    missingMunicipalityMatches: missingBoundaryCount,
    outsideCount,
    outsidePercent,
    perMunicipality: perMunicipality.sort((a, b) => a.municipalityKey.localeCompare(b.municipalityKey))
  };
  
  // Write outputs
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });
  
  // Output 1: Summary JSON
  const summaryPath = resolve(outputDir, 'settlements_outside_municipality.summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`  Summary: ${summaryPath}\n`);
  
  // Output 2: Report Markdown (top offenders first)
  const reportPath = resolve(outputDir, 'settlements_outside_municipality.report.md');
  const perMunicipalityByOffender = [...perMunicipality].sort((a, b) => {
    if (b.outsideCount !== a.outsideCount) {
      return b.outsideCount - a.outsideCount;
    }
    return a.municipalityKey.localeCompare(b.municipalityKey);
  });
  
  const reportLines: string[] = [
    '# Settlements Outside Municipality Diagnostic',
    '',
    '## Overall Summary',
    '',
    `- Total settlements checked: ${summary.totalSettlements}`,
    `- Settlements outside municipality: ${summary.outsideCount} (${summary.outsidePercent.toFixed(2)}%)`,
    `- Missing municipality boundary matches: ${summary.missingMunicipalityMatches}`,
    '',
    '**Note:** Municipality boundaries are constructed by unioning all settlement polygons for each municipality.',
    '',
    '## Per-Municipality Statistics',
    '',
    'Top offenders (by outside count):',
    '',
    '| Municipality | Features | Outside | Outside % |',
    '|-------------|----------|---------|-----------|'
  ];
  
  // Report top offenders first
  for (const stats of perMunicipalityByOffender) {
    if (stats.outsideCount > 0) {
      reportLines.push(
        `| ${stats.municipalityKey} | ${stats.featureCount} | ${stats.outsideCount} | ${stats.outsideRate.toFixed(2)}% |`
      );
    }
  }
  
  reportLines.push('');
  reportLines.push('### All Municipalities (including zero outside)');
  reportLines.push('');
  reportLines.push('| Municipality | Features | Outside | Outside % |');
  reportLines.push('|-------------|----------|---------|-----------|');
  
  // All municipalities in deterministic order
  for (const stats of summary.perMunicipality) {
    reportLines.push(
      `| ${stats.municipalityKey} | ${stats.featureCount} | ${stats.outsideCount} | ${stats.outsideRate.toFixed(2)}% |`
    );
  }
  
  await writeFile(reportPath, reportLines.join('\n'), 'utf8');
  process.stdout.write(`  Report: ${reportPath}\n`);
  
  // Final summary
  process.stdout.write('\nDiagnostic complete:\n');
  process.stdout.write(`  Settlements outside municipality: ${summary.outsideCount} (${summary.outsidePercent.toFixed(2)}%)\n`);
  process.stdout.write(`  Municipalities with outside settlements: ${summary.perMunicipality.filter(s => s.outsideCount > 0).length}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
