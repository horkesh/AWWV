/**
 * Phase MAP-N1: Coordinate Regime Normalization
 * 
 * Normalizes STRAY municipality geometries into the MAIN coordinate regime
 * deterministically, per-source using affine transforms.
 * 
 * Method (MANDATORY): per-source affine transform
 *   x' = (x * kx) + dx
 *   y' = (y * ky) + dy
 * 
 * Safety gates (NON-NEGOTIABLE):
 *   Gate 1: ≥90% of features in that source conform
 *   Gate 2: ≥99% of transformed features land inside MAIN bounds
 *   Gate 3: parameters finite (no NaN/Inf), kx/ky non-zero, deterministic ordering preserved
 * 
 * If a municipality fails gates → leave it untouched and report.
 * 
 * Usage:
 *   tsx scripts/map/normalize_coordinate_regimes.ts
 * 
 * Inputs:
 *   - data/derived/mapkit_regime_diagnosis.json
 *   - data/derived/settlements_polygons.regen.geojson
 * 
 * Outputs:
 *   - data/derived/settlements_polygons.normalized.v1.geojson
 *   - data/derived/mapkit_regime_normalization.summary.json
 *   - data/derived/mapkit_regime_normalization.report.md
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    mun_code: string;
    settlement_id: string;
    source_js_file?: string;
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface SourceStats {
  file: string;
  munCode: string;
  featureCount: number;
  medCx: number;
  medCy: number;
  medW: number;
  medH: number;
  medA: number;
  bounds: Bounds;
  centroidBounds: Bounds;
  cluster: 'MAIN' | 'STRAY';
  hints?: {
    dx: number;
    dy: number;
    kx: number;
    ky: number;
    k: number;
    label: string;
  };
}

interface RegimeDiagnosis {
  main: {
    files: string[];
    mainMedCx: number;
    mainMedCy: number;
    mainMedW: number;
    mainMedH: number;
  };
  stray: {
    files: string[];
  };
  sources: SourceStats[];
  summary: {
    filesTotal: number;
    filesStray: number;
    featuresTotal: number;
    featuresStray: number;
    featuresStrayPct: number;
  };
}

interface FileNormalizationStats {
  file: string;
  cluster: 'MAIN' | 'STRAY';
  applied: boolean;
  featureCount: number;
  conformCount: number;
  conformPercent: number;
  landedCount: number;
  landedPercent: number;
  reasons?: string[];
  params?: {
    dx: number;
    dy: number;
    kx: number;
    ky: number;
  };
}

interface NormalizationSummary {
  totalFeatures: number;
  totalFiles: number;
  mainFiles: number;
  strayFiles: number;
  transformedFiles: number;
  untouchedFiles: number;
  transformedFeatures: number;
  perFileStats: FileNormalizationStats[];
}

/**
 * Extract all coordinates from all rings in a feature.
 * Returns array of [x, y] points.
 */
function extractAllCoordinates(feature: GeoJSONFeature): Point[] {
  const coords: Point[] = [];
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        coords.push([x, y]);
      }
    }
  };
  
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    if (Array.isArray(polygon)) {
      for (const ring of polygon) {
        processRing(ring as Ring);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    const multipolygon = geom.coordinates as MultiPolygon;
    if (Array.isArray(multipolygon)) {
      for (const polygon of multipolygon) {
        if (Array.isArray(polygon)) {
          for (const ring of polygon) {
            processRing(ring as Ring);
          }
        }
      }
    }
  }
  
  return coords;
}

/**
 * Compute bounds from all coordinates of all rings in features.
 */
function computeBoundsFromCoordinates(features: GeoJSONFeature[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;
  
  for (const feature of features) {
    const coords = extractAllCoordinates(feature);
    for (const [x, y] of coords) {
      hasPoints = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  
  if (!hasPoints) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Check if a point is inside bounds.
 */
function pointInBounds(x: number, y: number, bounds: Bounds): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

/**
 * Apply affine transform to a point.
 */
function transformPoint(x: number, y: number, kx: number, ky: number, dx: number, dy: number): [number, number] {
  const xNew = x * kx + dx;
  const yNew = y * ky + dy;
  return [xNew, yNew];
}

/**
 * Apply affine transform to all coordinates in a feature.
 */
function transformFeature(feature: GeoJSONFeature, kx: number, ky: number, dx: number, dy: number): GeoJSONFeature {
  const transformRing = (ring: Ring): Ring => {
    return ring.map(point => {
      if (!Array.isArray(point) || point.length < 2) return point;
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return point;
      return transformPoint(x, y, kx, ky, dx, dy);
    });
  };
  
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    return {
      ...feature,
      geometry: {
        ...geom,
        coordinates: coords.map(ring => transformRing(ring as Ring))
      }
    };
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    return {
      ...feature,
      geometry: {
        ...geom,
        coordinates: coords.map(polygon => 
          (polygon as Polygon).map(ring => transformRing(ring as Ring))
        )
      }
    };
  }
  
  return feature;
}

/**
 * Validate Gate 3: parameters finite, kx/ky non-zero, reasonable bounds.
 */
function validateGate3(dx: number, dy: number, kx: number, ky: number): { valid: boolean; reason?: string } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(kx) || !Number.isFinite(ky)) {
    return { valid: false, reason: 'Non-finite parameters' };
  }
  
  if (kx === 0 || ky === 0) {
    return { valid: false, reason: 'Zero scale factor (kx or ky is zero)' };
  }
  
  if (Math.abs(kx) > 100 || Math.abs(ky) > 100) {
    return { valid: false, reason: `Scale factor too large: |kx|=${Math.abs(kx).toFixed(3)}, |ky|=${Math.abs(ky).toFixed(3)}` };
  }
  
  if (Math.abs(kx) < 0.0001 || Math.abs(ky) < 0.0001) {
    return { valid: false, reason: `Scale factor too small: |kx|=${Math.abs(kx).toFixed(6)}, |ky|=${Math.abs(ky).toFixed(6)}` };
  }
  
  return { valid: true };
}

/**
 * Check if a feature passes the landing test (all coordinates inside MAIN bounds).
 */
function featureLandsInBounds(feature: GeoJSONFeature, bounds: Bounds): boolean {
  const coords = extractAllCoordinates(feature);
  if (coords.length === 0) return false;
  
  for (const [x, y] of coords) {
    if (!pointInBounds(x, y, bounds)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Validate all gates for a file group.
 * Returns stats about the validation.
 */
function validateGatesForFile(
  features: GeoJSONFeature[],
  dx: number,
  dy: number,
  kx: number,
  ky: number,
  mainBounds: Bounds
): {
  gate3Pass: boolean;
  gate3Reason?: string;
  conformCount: number;
  conformPercent: number;
  landedCount: number;
  landedPercent: number;
  gate1Pass: boolean;
  gate2Pass: boolean;
} {
  // Gate 3: parameter validation
  const gate3 = validateGate3(dx, dy, kx, ky);
  if (!gate3.valid) {
    return {
      gate3Pass: false,
      gate3Reason: gate3.reason,
      conformCount: 0,
      conformPercent: 0,
      landedCount: 0,
      landedPercent: 0,
      gate1Pass: false,
      gate2Pass: false
    };
  }
  
  // Transform all features and check landing
  let conformCount = 0;
  let transformedCount = 0;
  let landedCount = 0;
  
  for (const feature of features) {
    try {
      const transformed = transformFeature(feature, kx, ky, dx, dy);
      
      // Check if transform produced finite coordinates
      const coords = extractAllCoordinates(transformed);
      let allFinite = true;
      for (const [x, y] of coords) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          allFinite = false;
          break;
        }
      }
      
      if (allFinite) {
        transformedCount++;
        const lands = featureLandsInBounds(transformed, mainBounds);
        if (lands) {
          conformCount++;
          landedCount++;
        }
      }
    } catch (err) {
      // Transform failed, feature doesn't conform
    }
  }
  
  const conformPercent = features.length > 0 ? (conformCount / features.length) * 100 : 0;
  const landedPercent = transformedCount > 0 ? (landedCount / transformedCount) * 100 : 0;
  
  // Gate 1: ≥90% conform
  const gate1Pass = conformPercent >= 90;
  
  // Gate 2: ≥99% landed
  const gate2Pass = landedPercent >= 99;
  
  return {
    gate3Pass: true,
    conformCount,
    conformPercent,
    landedCount,
    landedPercent,
    gate1Pass,
    gate2Pass
  };
}

async function main(): Promise<void> {
  process.stdout.write('Phase MAP-N1: Coordinate Regime Normalization\n');
  process.stdout.write('==============================================\n\n');
  
  // Load inputs
  const diagnosisPath = resolve('data/derived/mapkit_regime_diagnosis.json');
  const inputPath = resolve('data/derived/settlements_polygons.regen.geojson');
  
  process.stdout.write(`  Diagnosis: ${diagnosisPath}\n`);
  process.stdout.write(`  Input: ${inputPath}\n\n`);
  
  const fc = JSON.parse(await readFile(inputPath, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${inputPath}`);
  }
  
  const diagnosis = JSON.parse(await readFile(diagnosisPath, 'utf8')) as RegimeDiagnosis;
  
  process.stdout.write(`  Loaded ${fc.features.length} features\n`);
  process.stdout.write(`  Diagnosis: ${diagnosis.summary.filesStray} STRAY files, ${diagnosis.summary.featuresStray} STRAY features (${diagnosis.summary.featuresStrayPct.toFixed(2)}%)\n\n`);
  
  // Verify all features have source_js_file
  const missingSource = fc.features.find(f => !f.properties.source_js_file);
  if (missingSource) {
    throw new Error(`Feature ${missingSource.properties.sid} missing source_js_file property`);
  }
  
  // Build file -> source classification mapping
  const fileToSource = new Map<string, SourceStats>();
  for (const source of diagnosis.sources) {
    fileToSource.set(source.file, source);
  }
  
  // Compute MAIN bounds from MAIN features only (all coordinates of all rings)
  process.stdout.write('Computing MAIN bounds from MAIN features...\n');
  const mainFeatures = fc.features.filter(f => {
    const file = f.properties.source_js_file as string;
    const source = fileToSource.get(file);
    return source && source.cluster === 'MAIN';
  });
  
  const mainBounds = computeBoundsFromCoordinates(mainFeatures);
  if (!mainBounds) {
    throw new Error('Could not compute MAIN bounds from MAIN features');
  }
  
  process.stdout.write(`  MAIN bounds: [${mainBounds.minX.toFixed(2)}, ${mainBounds.minY.toFixed(2)}] to [${mainBounds.maxX.toFixed(2)}, ${mainBounds.maxY.toFixed(2)}]\n\n`);
  
  // Group features by file
  const featuresByFile = new Map<string, GeoJSONFeature[]>();
  for (const feature of fc.features) {
    const file = feature.properties.source_js_file as string;
    if (!featuresByFile.has(file)) {
      featuresByFile.set(file, []);
    }
    featuresByFile.get(file)!.push(feature);
  }
  
  // Process each file
  process.stdout.write('Validating safety gates for STRAY files...\n');
  const fileStats: FileNormalizationStats[] = [];
  const fileTransforms = new Map<string, { kx: number; ky: number; dx: number; dy: number }>();
  
  // Process all files (MAIN and STRAY) for reporting
  for (const source of diagnosis.sources.sort((a, b) => a.file.localeCompare(b.file))) {
    const file = source.file;
    const features = featuresByFile.get(file) || [];
    const cluster = source.cluster;
    
    const stats: FileNormalizationStats = {
      file,
      cluster,
      applied: false,
      featureCount: features.length,
      conformCount: 0,
      conformPercent: 0,
      landedCount: 0,
      landedPercent: 0
    };
    
    if (cluster === 'STRAY' && source.hints) {
      const { dx, dy, kx, ky } = source.hints;
      stats.params = { dx, dy, kx, ky };
      
      const validation = validateGatesForFile(features, dx, dy, kx, ky, mainBounds);
      
      stats.conformCount = validation.conformCount;
      stats.conformPercent = validation.conformPercent;
      stats.landedCount = validation.landedCount;
      stats.landedPercent = validation.landedPercent;
      
      if (!validation.gate3Pass) {
        stats.reasons = [`Gate 3 failed: ${validation.gate3Reason}`];
        process.stdout.write(`  ${file}: FAILED Gate 3 - ${validation.gate3Reason}\n`);
      } else if (!validation.gate1Pass) {
        stats.reasons = [`Gate 1 failed: ${validation.conformPercent.toFixed(2)}% conform (required ≥90%)`];
        process.stdout.write(`  ${file}: FAILED Gate 1 - ${validation.conformPercent.toFixed(2)}% conform (required ≥90%)\n`);
      } else if (!validation.gate2Pass) {
        stats.reasons = [`Gate 2 failed: ${validation.landedPercent.toFixed(2)}% landed (required ≥99%)`];
        process.stdout.write(`  ${file}: FAILED Gate 2 - ${validation.landedPercent.toFixed(2)}% landed (required ≥99%)\n`);
      } else {
        // All gates passed
        stats.applied = true;
        fileTransforms.set(file, { kx, ky, dx, dy });
        process.stdout.write(`  ${file}: PASSED all gates (${features.length} features, ${validation.conformPercent.toFixed(1)}% conform, ${validation.landedPercent.toFixed(1)}% landed)\n`);
      }
    } else if (cluster === 'STRAY' && !source.hints) {
      stats.reasons = ['Missing transform hints in diagnosis'];
      process.stdout.write(`  ${file}: SKIPPED - missing transform hints\n`);
    }
    
    fileStats.push(stats);
  }
  
  process.stdout.write(`\n  Transformed files: ${fileTransforms.size} / ${diagnosis.summary.filesStray} STRAY files\n`);
  process.stdout.write(`  Untouched files: ${diagnosis.summary.filesStray - fileTransforms.size}\n\n`);
  
  // Apply transforms to features (preserving deterministic ordering)
  process.stdout.write('Applying transforms...\n');
  const outputFeatures: GeoJSONFeature[] = [];
  let transformedCount = 0;
  
  for (const feature of fc.features) {
    const file = feature.properties.source_js_file as string;
    const transform = fileTransforms.get(file);
    
    if (transform) {
      try {
        const transformed = transformFeature(feature, transform.kx, transform.ky, transform.dx, transform.dy);
        outputFeatures.push(transformed);
        transformedCount++;
      } catch (err) {
        throw new Error(`Failed to transform feature ${feature.properties.sid} from ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      outputFeatures.push(feature);
    }
  }
  
  process.stdout.write(`  Transformed ${transformedCount} features\n\n`);
  
  // Build summary
  const summary: NormalizationSummary = {
    totalFeatures: fc.features.length,
    totalFiles: diagnosis.sources.length,
    mainFiles: diagnosis.summary.filesTotal - diagnosis.summary.filesStray,
    strayFiles: diagnosis.summary.filesStray,
    transformedFiles: fileTransforms.size,
    untouchedFiles: diagnosis.summary.filesStray - fileTransforms.size,
    transformedFeatures: transformedCount,
    perFileStats: fileStats
  };
  
  // Write outputs
  const outputDir = resolve('data/derived');
  await mkdir(outputDir, { recursive: true });
  
  // Output 1: Normalized GeoJSON
  const outputPath = resolve(outputDir, 'settlements_polygons.normalized.v1.geojson');
  const outputFC: GeoJSONFC = {
    type: 'FeatureCollection',
    features: outputFeatures
  };
  await writeFile(outputPath, JSON.stringify(outputFC, null, 2), 'utf8');
  process.stdout.write(`  GeoJSON: ${outputPath}\n`);
  
  // Output 2: Summary JSON
  const summaryPath = resolve(outputDir, 'mapkit_regime_normalization.summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`  Summary: ${summaryPath}\n`);
  
  // Output 3: Report Markdown
  const reportPath = resolve(outputDir, 'mapkit_regime_normalization.report.md');
  const reportLines: string[] = [
    '# Coordinate Regime Normalization Report',
    '',
    '## Summary',
    '',
    `- Total features: ${summary.totalFeatures}`,
    `- Total files: ${summary.totalFiles} (${summary.mainFiles} MAIN, ${summary.strayFiles} STRAY)`,
    `- Transformed files: ${summary.transformedFiles} / ${summary.strayFiles} STRAY files`,
    `- Untouched files: ${summary.untouchedFiles}`,
    `- Transformed features: ${summary.transformedFeatures}`,
    '',
    '## Per-File Statistics',
    '',
    '| File | Cluster | Applied | Features | Conform % | Landed % | Reasons |',
    '|------|---------|--------|----------|-----------|----------|---------|'
  ];
  
  for (const stats of fileStats) {
    const applied = stats.applied ? '✓' : '✗';
    const conformPct = stats.conformPercent.toFixed(1);
    const landedPct = stats.landedPercent.toFixed(1);
    const reasons = stats.reasons ? stats.reasons.join('; ') : '-';
    const params = stats.params ? `dx=${stats.params.dx.toFixed(1)}, dy=${stats.params.dy.toFixed(1)}, kx=${stats.params.kx.toFixed(3)}, ky=${stats.params.ky.toFixed(3)}` : '-';
    
    reportLines.push(`| ${stats.file} | ${stats.cluster} | ${applied} | ${stats.featureCount} | ${conformPct} | ${landedPct} | ${reasons} |`);
  }
  
  reportLines.push('');
  reportLines.push('## Transform Parameters');
  reportLines.push('');
  reportLines.push('| File | dx | dy | kx | ky |');
  reportLines.push('|------|----|----|----|----|');
  
  for (const stats of fileStats.filter(s => s.params)) {
    const p = stats.params!;
    reportLines.push(`| ${stats.file} | ${p.dx.toFixed(2)} | ${p.dy.toFixed(2)} | ${p.kx.toFixed(6)} | ${p.ky.toFixed(6)} |`);
  }
  
  reportLines.push('');
  reportLines.push('## Safety Gates');
  reportLines.push('');
  reportLines.push('- **Gate 1**: ≥90% of features conform (finite transform + pass landing test)');
  reportLines.push('- **Gate 2**: ≥99% of transformed features land inside MAIN bounds');
  reportLines.push('- **Gate 3**: Parameters finite, kx/ky non-zero, reasonable bounds (0.0001 < |kx|,|ky| < 100)');
  reportLines.push('');
  reportLines.push('If any gate fails, features from that file are left untouched.');
  
  await writeFile(reportPath, reportLines.join('\n'), 'utf8');
  process.stdout.write(`  Report: ${reportPath}\n`);
  
  // Final summary
  process.stdout.write('\nNormalization complete:\n');
  process.stdout.write(`  Transformed files: ${summary.transformedFiles} / ${summary.strayFiles} STRAY files\n`);
  process.stdout.write(`  Untouched files: ${summary.untouchedFiles}\n`);
  process.stdout.write(`  Transformed features: ${summary.transformedFeatures}\n`);
}

main().catch((err) => {
  process.stderr.write(`normalize_coordinate_regimes failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
