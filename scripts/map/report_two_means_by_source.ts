/**
 * Two-means diagnostic: Report stray cluster by source file.
 * 
 * Explains the validator's two-means result in terms of municipality source files.
 * Uses the EXACT same two-means algorithm and centroid computation as the validator.
 * 
 * Usage:
 *   tsx scripts/map/report_two_means_by_source.ts
 * 
 * Input:
 *   - data/derived/settlements_polygons.normalized.v1.geojson
 * 
 * Outputs:
 *   - data/derived/two_means_by_source.summary.json
 *   - data/derived/two_means_by_source.report.md
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type GeoJSONFeature = { type: 'Feature'; properties?: Record<string, unknown>; geometry: { type: string; coordinates: any } };
type GeoJSONFC = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

interface CentroidRecord {
  sid: string;
  cx: number;
  cy: number;
  bounds: Bounds;
  sourceFile: string;
}

interface SourceStats {
  file: string;
  featureCount: number;
  strayFeatureCount: number;
  strayRate: number;
  medCx: number;
  medCy: number;
}

interface TwoMeansSummary {
  totalFeatures: number;
  strayCount: number;
  mainCount: number;
  strayFraction: number;
  strayPercent: number;
  perSource: SourceStats[];
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
 * Copy of validator's mergeBounds function.
 */
function mergeBounds(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

/**
 * Copy of validator's boundsArea function.
 */
function boundsArea(b: Bounds): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

/**
 * Copy of validator's twoMeansStrayPercent function.
 * Returns which cluster is stray and the assignment of each sid.
 */
function twoMeansStrayPercent(records: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }>): {
  strayPercent: number;
  strayCount: number;
  mainCount: number;
  straySids: Set<string>;
  mainSids: Set<string>;
} {
  if (records.length < 2) {
    const allSids = new Set(records.map(r => r.sid));
    return { strayPercent: 0, strayCount: 0, mainCount: records.length, straySids: new Set(), mainSids: allSids };
  }
  let seed1 = records[0];
  for (const r of records) {
    const s = r.cx + r.cy;
    const sb = seed1.cx + seed1.cy;
    if (s < sb || (s === sb && r.sid.localeCompare(seed1.sid) < 0)) seed1 = r;
  }
  // Determinism safeguard: choose seed2 without relying on input order.
  // Still: farthest from seed1, tie-break by sid (same metric/tie-break as validator loop).
  let seed2: { sid: string; cx: number; cy: number; bounds: Bounds } | null = null;
  let bestD2 = -1;
  for (const r of records) {
    if (r === seed1) continue;
    const dx = r.cx - seed1.cx, dy = r.cy - seed1.cy;
    const d2 = dx * dx + dy * dy;
    if (seed2 === null || d2 > bestD2 || (d2 === bestD2 && r.sid.localeCompare(seed2.sid) < 0)) { bestD2 = d2; seed2 = r; }
  }
  // records.length >= 2 guarantees we found a seed2.
  if (seed2 === null) seed2 = records[0] === seed1 ? records[1] : records[0];
  let meanA = { x: seed1.cx, y: seed1.cy };
  let meanB = { x: seed2.cx, y: seed2.cy };
  let setA = new Set<string>();
  let setB = new Set<string>();
  for (let iter = 0; iter < 10; iter++) {
    setA = new Set<string>();
    setB = new Set<string>();
    for (const r of records) {
      const dxA = r.cx - meanA.x, dyA = r.cy - meanA.y;
      const dxB = r.cx - meanB.x, dyB = r.cy - meanB.y;
      const dA = dxA * dxA + dyA * dyA;
      const dB = dxB * dxB + dyB * dyB;
      if (dA <= dB) setA.add(r.sid); else setB.add(r.sid);
    }
    let ax = 0, ay = 0, ac = 0, bx = 0, by = 0, bc = 0;
    for (const r of records) {
      if (setA.has(r.sid)) { ax += r.cx; ay += r.cy; ac++; }
      else { bx += r.cx; by += r.cy; bc++; }
    }
    if (ac > 0) meanA = { x: ax / ac, y: ay / ac };
    if (bc > 0) meanB = { x: bx / bc, y: by / bc };
  }
  const boundsA = records.filter(r => setA.has(r.sid)).reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null);
  const boundsB = records.filter(r => setB.has(r.sid)).reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null);
  const areaA = boundsA ? boundsArea(boundsA) : 0;
  const areaB = boundsB ? boundsArea(boundsB) : 0;
  const countA = setA.size, countB = setB.size;
  const mainIsA = countA > countB ? true : countB > countA ? false : areaA >= areaB;
  const mainCount = mainIsA ? countA : countB;
  const strayCount = mainIsA ? countB : countA;
  const mainSids = mainIsA ? setA : setB;
  const straySids = mainIsA ? setB : setA;
  return { strayPercent: strayCount / records.length, strayCount, mainCount, straySids, mainSids };
}

/**
 * Compute median of values.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main(): Promise<void> {
  process.stdout.write('Two-means diagnostic by source file\n');
  process.stdout.write('====================================\n\n');
  
  // Load input
  const inputPath = resolve('data/derived/settlements_polygons.normalized.v1.geojson');
  process.stdout.write(`  Input: ${inputPath}\n\n`);
  
  const fc = JSON.parse(await readFile(inputPath, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${inputPath}`);
  }
  
  process.stdout.write(`  Loaded ${fc.features.length} features\n\n`);
  
  // Compute centroids and bounds for all features (same as validator)
  process.stdout.write('Computing centroids and bounds...\n');
  const records: CentroidRecord[] = [];
  let badFeatures = 0;
  
  for (const f of fc.features) {
    const r = computeBoundsAndCentroid(f);
    if (!r.ok) {
      badFeatures++;
      continue;
    }
    // Keep centroid-valid features even if source_js_file is missing.
    // This ensures two-means is computed over ALL centroid-valid features.
    const sourceFile = String((f.properties as any)?.source_js_file ?? '(missing)');
    records.push({
      sid: r.sid,
      cx: r.cx,
      cy: r.cy,
      bounds: r.bounds,
      sourceFile
    });
  }
  
  process.stdout.write(`  Valid records: ${records.length}\n`);
  if (badFeatures > 0) {
    process.stdout.write(`  Bad features: ${badFeatures}\n`);
  }
  process.stdout.write('\n');
  
  // Note: validator sorts by sid before two-means; this script does not rely on that
  // for determinism. Seed selection and tie-breaks are order-independent here.
  
  // Run two-means algorithm (same as validator)
  process.stdout.write('Running two-means clustering...\n');
  const twoMeansResult = twoMeansStrayPercent(records);
  
  process.stdout.write(`  Stray cluster: ${twoMeansResult.strayCount} features (${(twoMeansResult.strayPercent * 100).toFixed(2)}%)\n`);
  process.stdout.write(`  Main cluster: ${twoMeansResult.mainCount} features\n\n`);
  
  // Group by source file
  process.stdout.write('Grouping by source file...\n');
  const sourceMap = new Map<string, {
    records: CentroidRecord[];
    strayRecords: CentroidRecord[];
  }>();
  
  for (const record of records) {
    if (!sourceMap.has(record.sourceFile)) {
      sourceMap.set(record.sourceFile, {
        records: [],
        strayRecords: []
      });
    }
    const source = sourceMap.get(record.sourceFile)!;
    source.records.push(record);
    if (twoMeansResult.straySids.has(record.sid)) {
      source.strayRecords.push(record);
    }
  }
  
  process.stdout.write(`  Source files: ${sourceMap.size}\n\n`);
  
  // Compute per-source statistics
  const perSourceByFile: SourceStats[] = [];
  for (const [file, source] of Array.from(sourceMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const strayCount = source.strayRecords.length;
    const strayRate = source.records.length > 0 ? (strayCount / source.records.length) * 100 : 0;
    const medCx = median(source.records.map(r => r.cx));
    const medCy = median(source.records.map(r => r.cy));
    
    perSourceByFile.push({
      file,
      featureCount: source.records.length,
      strayFeatureCount: strayCount,
      strayRate,
      medCx,
      medCy
    });
  }
  
  // Top offenders ordering for report (deterministic).
  const perSourceByOffender = [...perSourceByFile].sort((a, b) => {
    if (b.strayFeatureCount !== a.strayFeatureCount) {
      return b.strayFeatureCount - a.strayFeatureCount;
    }
    return a.file.localeCompare(b.file);
  });
  
  // Build summary
  const strayFraction = twoMeansResult.strayPercent;
  const summary: TwoMeansSummary = {
    totalFeatures: records.length,
    strayCount: twoMeansResult.strayCount,
    mainCount: twoMeansResult.mainCount,
    strayFraction,
    strayPercent: strayFraction * 100,
    perSource: perSourceByFile.sort((a, b) => a.file.localeCompare(b.file)) // Deterministic ordering for JSON
  };
  
  // Write outputs
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });
  
  // Output 1: Summary JSON
  const summaryPath = resolve(outputDir, 'two_means_by_source.summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`  Summary: ${summaryPath}\n`);
  
  // Output 2: Report Markdown (top offenders first)
  const reportPath = resolve(outputDir, 'two_means_by_source.report.md');
  const reportLines: string[] = [
    '# Two-Means Diagnostic by Source File',
    '',
    '## Overall Summary',
    '',
    `- Total features: ${summary.totalFeatures}`,
    `- Stray cluster: ${summary.strayCount} features (${summary.strayPercent.toFixed(2)}%)`,
    `- Main cluster: ${summary.mainCount} features`,
    '',
    '**Note:** This matches the validator\'s two-means result.',
    '',
    '## Per-Source Statistics',
    '',
    'Top offenders (by stray feature count):',
    '',
    '| File | Features | Stray Features | Stray % | Median Cx | Median Cy |',
    '|------|----------|----------------|---------|-----------|-----------|'
  ];
  
  // Report top offenders first (already sorted by strayFeatureCount descending)
  for (const stats of perSourceByOffender) {
    if (stats.strayFeatureCount > 0) {
      reportLines.push(
        `| ${stats.file} | ${stats.featureCount} | ${stats.strayFeatureCount} | ${stats.strayRate.toFixed(2)}% | ${stats.medCx.toFixed(2)} | ${stats.medCy.toFixed(2)} |`
      );
    }
  }
  
  reportLines.push('');
  reportLines.push('### All Sources (including zero stray)');
  reportLines.push('');
  reportLines.push('| File | Features | Stray Features | Stray % | Median Cx | Median Cy |');
  reportLines.push('|------|----------|----------------|---------|-----------|-----------|');
  
  // All sources in deterministic order
  const allSourcesSorted = [...summary.perSource];
  for (const stats of allSourcesSorted) {
    reportLines.push(
      `| ${stats.file} | ${stats.featureCount} | ${stats.strayFeatureCount} | ${stats.strayRate.toFixed(2)}% | ${stats.medCx.toFixed(2)} | ${stats.medCy.toFixed(2)} |`
    );
  }
  
  await writeFile(reportPath, reportLines.join('\n'), 'utf8');
  process.stdout.write(`  Report: ${reportPath}\n`);
  
  // Final summary
  process.stdout.write('\nDiagnostic complete:\n');
  process.stdout.write(`  Stray cluster: ${summary.strayCount} features (${summary.strayPercent.toFixed(2)}%)\n`);
  process.stdout.write(`  Main cluster: ${summary.mainCount} features\n`);
  process.stdout.write(`  Source files with stray features: ${summary.perSource.filter(s => s.strayFeatureCount > 0).length}\n`);
}

main().catch((err) => {
  process.stderr.write(`report_two_means_by_source failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
