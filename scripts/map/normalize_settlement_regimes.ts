/**
 * @deprecated This script uses noncompliant gates (centroid distance reduction, expanded bounds).
 * Use scripts/map/normalize_coordinate_regimes.ts instead, which implements Phase MAP-N1 exactly.
 * 
 * Coordinate regime normalization: Apply scale+offset transforms to STRAY regime files.
 * 
 * This script:
 * 1) Reads regen GeoJSON and regime diagnosis
 * 2) Applies per-file scale+offset transforms to STRAY files
 * 3) Validates transforms with safety gates
 * 4) Emits normalized GeoJSON and summary
 * 
 * Usage:
 *   tsx scripts/map/normalize_settlement_regimes.ts [--input <geojson>] [--diagnosis <json>] [--out <geojson>]
 * 
 * Defaults:
 *   input: data/derived/settlements_polygons.regen.geojson
 *   diagnosis: data/derived/mapkit_regime_diagnosis.json
 *   out: data/derived/settlements_polygons.regen_norm.geojson
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

interface NormalizationSummary {
  totalFeatures: number;
  transformedFiles: number;
  unresolvedFiles: number;
  unresolvedFileList: string[];
  transformedFeatures: number;
  strayClusterBefore: number;
  strayClusterAfter: number;
  boundsBefore: Bounds;
  boundsAfter: Bounds;
}

function parseArgs(argv: string[]): { input: string; diagnosis: string; out: string; help: boolean } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i] ?? '';
    else if (a === '--diagnosis') args.diagnosis = argv[++i] ?? '';
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = '1';
  }
  return {
    input: args.input || resolve('data/derived/settlements_polygons.regen.geojson'),
    diagnosis: args.diagnosis || resolve('data/derived/mapkit_regime_diagnosis.json'),
    out: args.out || resolve('data/derived/settlements_polygons.regen_norm.geojson'),
    help: Boolean(args.help)
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeCentroid(feature: GeoJSONFeature): { cx: number; cy: number } | null {
  let sumX = 0, sumY = 0, count = 0;
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  };
  
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    if (Array.isArray(coords) && coords.length > 0) {
      processRing(coords[0] as Ring);
    }
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    if (Array.isArray(coords) && coords.length > 0) {
      const firstPoly = coords[0] as Polygon;
      if (Array.isArray(firstPoly) && firstPoly.length > 0) {
        processRing(firstPoly[0] as Ring);
      }
    }
  }
  
  if (count === 0) return null;
  return { cx: sumX / count, cy: sumY / count };
}

function computeBounds(feature: GeoJSONFeature): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      hasPoints = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  };
  
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    if (Array.isArray(coords)) {
      for (const ring of coords) {
        processRing(ring as Ring);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    if (Array.isArray(coords)) {
      for (const polygon of coords) {
        if (Array.isArray(polygon)) {
          for (const ring of polygon) {
            processRing(ring as Ring);
          }
        }
      }
    }
  }
  
  if (!hasPoints) return null;
  return { minX, minY, maxX, maxY };
}

function boundsArea(b: Bounds): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

function expandBounds(b: Bounds, padding: number): Bounds {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return {
    minX: b.minX - w * padding,
    minY: b.minY - h * padding,
    maxX: b.maxX + w * padding,
    maxY: b.maxY + h * padding
  };
}

function pointInBounds(x: number, y: number, b: Bounds): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

function transformPoint(x: number, y: number, kx: number, ky: number, dx: number, dy: number): [number, number] {
  const xNew = x * kx + dx;
  const yNew = y * ky + dy;
  if (!Number.isFinite(xNew) || !Number.isFinite(yNew)) {
    throw new Error(`Transform produced non-finite coordinate: (${x}, ${y}) -> (${xNew}, ${yNew})`);
  }
  return [xNew, yNew];
}

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

function computeStrayClusterPercent(features: GeoJSONFeature[]): number {
  if (features.length < 2) return 0;
  
  const centroids = features.map(f => computeCentroid(f)).filter((c): c is { cx: number; cy: number } => c !== null);
  if (centroids.length < 2) return 0;
  
  // Deterministic 2-means clustering
  let seed1Idx = 0;
  let minSum = centroids[0].cx + centroids[0].cy;
  for (let i = 1; i < centroids.length; i++) {
    const sum = centroids[i].cx + centroids[i].cy;
    if (sum < minSum) {
      minSum = sum;
      seed1Idx = i;
    }
  }
  
  let seed2Idx = 0;
  let maxDistSq = 0;
  const seed1 = centroids[seed1Idx];
  for (let i = 0; i < centroids.length; i++) {
    if (i === seed1Idx) continue;
    const dx = centroids[i].cx - seed1.cx;
    const dy = centroids[i].cy - seed1.cy;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxDistSq) {
      maxDistSq = distSq;
      seed2Idx = i;
    }
  }
  
  let meanA = { x: seed1.cx, y: seed1.cy };
  let meanB = { x: centroids[seed2Idx].cx, y: centroids[seed2Idx].cy };
  let clusterA: number[] = [];
  let clusterB: number[] = [];
  
  for (let iter = 0; iter < 10; iter++) {
    clusterA = [];
    clusterB = [];
    
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const dxA = c.cx - meanA.x;
      const dyA = c.cy - meanA.y;
      const distSqA = dxA * dxA + dyA * dyA;
      
      const dxB = c.cx - meanB.x;
      const dyB = c.cy - meanB.y;
      const distSqB = dxB * dxB + dyB * dyB;
      
      if (distSqA <= distSqB) {
        clusterA.push(i);
      } else {
        clusterB.push(i);
      }
    }
    
    let ax = 0, ay = 0, ac = 0, bx = 0, by = 0, bc = 0;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      if (clusterA.includes(i)) {
        ax += c.cx;
        ay += c.cy;
        ac++;
      } else {
        bx += c.cx;
        by += c.cy;
        bc++;
      }
    }
    if (ac > 0) meanA = { x: ax / ac, y: ay / ac };
    if (bc > 0) meanB = { x: bx / bc, y: by / bc };
  }
  
  const countA = clusterA.length;
  const countB = clusterB.length;
  const strayCount = countA < countB ? countA : countB;
  
  return (strayCount / centroids.length) * 100;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help) {
    process.stdout.write([
      'Usage:',
      '  tsx scripts/map/normalize_settlement_regimes.ts [--input <geojson>] [--diagnosis <json>] [--out <geojson>]',
      '',
      'Defaults:',
      `  input: ${args.input}`,
      `  diagnosis: ${args.diagnosis}`,
      `  out: ${args.out}`,
      ''
    ].join('\n'));
    return;
  }
  
  process.stdout.write('Coordinate regime normalization\n');
  process.stdout.write(`  Input: ${args.input}\n`);
  process.stdout.write(`  Diagnosis: ${args.diagnosis}\n`);
  process.stdout.write(`  Output: ${args.out}\n\n`);
  
  // Load inputs
  const fc = JSON.parse(await readFile(args.input, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${args.input}`);
  }
  
  const diagnosis = JSON.parse(await readFile(args.diagnosis, 'utf8')) as RegimeDiagnosis;
  
  process.stdout.write(`  Loaded ${fc.features.length} features\n`);
  process.stdout.write(`  Diagnosis: ${diagnosis.summary.filesStray} STRAY files, ${diagnosis.summary.featuresStray} STRAY features (${diagnosis.summary.featuresStrayPct.toFixed(2)}%)\n\n`);
  
  // Verify all features have source_js_file
  const missingSource = fc.features.find(f => !f.properties.source_js_file);
  if (missingSource) {
    throw new Error(`Feature ${missingSource.properties.sid} missing source_js_file property`);
  }
  
  // Build file -> transform mapping
  const fileToTransform = new Map<string, { kx: number; ky: number; dx: number; dy: number }>();
  const fileToSource = new Map<string, SourceStats>();
  
  for (const source of diagnosis.sources) {
    fileToSource.set(source.file, source);
    if (source.cluster === 'STRAY' && source.hints) {
      fileToTransform.set(source.file, {
        kx: source.hints.kx,
        ky: source.hints.ky,
        dx: source.hints.dx,
        dy: source.hints.dy
      });
    }
  }
  
  // Compute MAIN bounds from MAIN features
  const mainFeatures = fc.features.filter(f => {
    const file = f.properties.source_js_file as string;
    const source = fileToSource.get(file);
    return source && source.cluster === 'MAIN';
  });
  
  let mainBounds: Bounds | null = null;
  for (const feature of mainFeatures) {
    const bounds = computeBounds(feature);
    if (bounds) {
      if (!mainBounds) {
        mainBounds = { ...bounds };
      } else {
        mainBounds.minX = Math.min(mainBounds.minX, bounds.minX);
        mainBounds.minY = Math.min(mainBounds.minY, bounds.minY);
        mainBounds.maxX = Math.max(mainBounds.maxX, bounds.maxX);
        mainBounds.maxY = Math.max(mainBounds.maxY, bounds.maxY);
      }
    }
  }
  
  if (!mainBounds) {
    throw new Error('Could not compute MAIN bounds');
  }
  
  const expandedMainBounds = expandBounds(mainBounds, 0.1);
  
  // Group features by file for safety gate validation
  const featuresByFile = new Map<string, GeoJSONFeature[]>();
  for (const feature of fc.features) {
    const file = feature.properties.source_js_file as string;
    if (!featuresByFile.has(file)) {
      featuresByFile.set(file, []);
    }
    featuresByFile.get(file)!.push(feature);
  }
  
  // Validate safety gates per STRAY file
  const unresolvedFiles: string[] = [];
  const fileTransforms = new Map<string, { kx: number; ky: number; dx: number; dy: number }>();
  
  process.stdout.write('Validating safety gates for STRAY files...\n');
  
  for (const [file, transform] of fileToTransform.entries()) {
    const features = featuresByFile.get(file) || [];
    if (features.length === 0) continue;
    
    // Sample: first min(50, count) features sorted by sid
    const sample = [...features]
      .sort((a, b) => a.properties.sid.localeCompare(b.properties.sid))
      .slice(0, Math.min(50, features.length));
    
    // Compute before stats
    const beforeCentroids = sample.map(f => computeCentroid(f)).filter((c): c is { cx: number; cy: number } => c !== null);
    const beforeMedCx = median(beforeCentroids.map(c => c.cx));
    const beforeMedCy = median(beforeCentroids.map(c => c.cy));
    const beforeDist = distance(beforeMedCx, beforeMedCy, diagnosis.main.mainMedCx, diagnosis.main.mainMedCy);
    
    const beforeBounds = sample.map(f => computeBounds(f)).filter((b): b is Bounds => b !== null);
    const beforeMedW = median(beforeBounds.map(b => b.maxX - b.minX));
    const beforeMedH = median(beforeBounds.map(b => b.maxY - b.minY));
    
    // Transform sample
    let transformedSample: GeoJSONFeature[];
    try {
      transformedSample = sample.map(f => transformFeature(f, transform.kx, transform.ky, transform.dx, transform.dy));
    } catch (err) {
      process.stdout.write(`  ${file}: FAILED - transform error: ${err instanceof Error ? err.message : String(err)}\n`);
      unresolvedFiles.push(file);
      continue;
    }
    
    // Compute after stats
    const afterCentroids = transformedSample.map(f => computeCentroid(f)).filter((c): c is { cx: number; cy: number } => c !== null);
    const afterMedCx = median(afterCentroids.map(c => c.cx));
    const afterMedCy = median(afterCentroids.map(c => c.cy));
    const afterDist = distance(afterMedCx, afterMedCy, diagnosis.main.mainMedCx, diagnosis.main.mainMedCy);
    
    const afterBounds = transformedSample.map(f => computeBounds(f)).filter((b): b is Bounds => b !== null);
    const afterMedW = median(afterBounds.map(b => b.maxX - b.minX));
    const afterMedH = median(afterBounds.map(b => b.maxY - b.minY));
    
    // Gate A: centroid distance reduction
    const distReduction = beforeDist > 0 ? afterDist / beforeDist : 0;
    if (distReduction > 0.1) {
      process.stdout.write(`  ${file}: FAILED Gate A - distance reduction ${(distReduction * 100).toFixed(1)}% (required <= 10%)\n`);
      unresolvedFiles.push(file);
      continue;
    }
    
    // Gate B: scale sanity
    const wRatio = afterMedW / diagnosis.main.mainMedW;
    const hRatio = afterMedH / diagnosis.main.mainMedH;
    if (wRatio < 0.5 || wRatio > 2.0 || hRatio < 0.5 || hRatio > 2.0) {
      process.stdout.write(`  ${file}: FAILED Gate B - scale ratios w=${wRatio.toFixed(3)}, h=${hRatio.toFixed(3)} (required 0.5-2.0)\n`);
      unresolvedFiles.push(file);
      continue;
    }
    
    // Gate C: in-bounds rate
    const inBoundsCount = afterCentroids.filter(c => pointInBounds(c.cx, c.cy, expandedMainBounds)).length;
    const inBoundsRate = afterCentroids.length > 0 ? inBoundsCount / afterCentroids.length : 0;
    if (inBoundsRate < 0.95) {
      process.stdout.write(`  ${file}: FAILED Gate C - in-bounds rate ${(inBoundsRate * 100).toFixed(1)}% (required >= 95%)\n`);
      unresolvedFiles.push(file);
      continue;
    }
    
    // All gates passed
    fileTransforms.set(file, transform);
    process.stdout.write(`  ${file}: PASSED all gates (${features.length} features)\n`);
  }
  
  process.stdout.write(`\n  Transformed files: ${fileTransforms.size}\n`);
  process.stdout.write(`  Unresolved files: ${unresolvedFiles.length}\n`);
  
  if (unresolvedFiles.length > 0) {
    process.stdout.write(`  Unresolved: ${unresolvedFiles.join(', ')}\n`);
  }
  
  // Apply transforms to all features
  process.stdout.write('\nApplying transforms...\n');
  const transformedFeatures: GeoJSONFeature[] = [];
  let transformedCount = 0;
  
  for (const feature of fc.features) {
    const file = feature.properties.source_js_file as string;
    const transform = fileTransforms.get(file);
    
    if (transform) {
      try {
        transformedFeatures.push(transformFeature(feature, transform.kx, transform.ky, transform.dx, transform.dy));
        transformedCount++;
      } catch (err) {
        throw new Error(`Failed to transform feature ${feature.properties.sid} from ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      transformedFeatures.push(feature);
    }
  }
  
  // Sort by sid for deterministic output
  transformedFeatures.sort((a, b) => a.properties.sid.localeCompare(b.properties.sid));
  
  // Compute bounds
  let boundsBefore: Bounds | null = null;
  let boundsAfter: Bounds | null = null;
  
  for (const feature of fc.features) {
    const bounds = computeBounds(feature);
    if (bounds) {
      if (!boundsBefore) boundsBefore = { ...bounds };
      else {
        boundsBefore.minX = Math.min(boundsBefore.minX, bounds.minX);
        boundsBefore.minY = Math.min(boundsBefore.minY, bounds.minY);
        boundsBefore.maxX = Math.max(boundsBefore.maxX, bounds.maxX);
        boundsBefore.maxY = Math.max(boundsBefore.maxY, bounds.maxY);
      }
    }
  }
  
  for (const feature of transformedFeatures) {
    const bounds = computeBounds(feature);
    if (bounds) {
      if (!boundsAfter) boundsAfter = { ...bounds };
      else {
        boundsAfter.minX = Math.min(boundsAfter.minX, bounds.minX);
        boundsAfter.minY = Math.min(boundsAfter.minY, bounds.minY);
        boundsAfter.maxX = Math.max(boundsAfter.maxX, bounds.maxX);
        boundsAfter.maxY = Math.max(boundsAfter.maxY, bounds.maxY);
      }
    }
  }
  
  // Compute stray cluster after
  const strayClusterAfter = computeStrayClusterPercent(transformedFeatures);
  
  // Build summary
  const summary: NormalizationSummary = {
    totalFeatures: fc.features.length,
    transformedFiles: fileTransforms.size,
    unresolvedFiles: unresolvedFiles.length,
    unresolvedFileList: unresolvedFiles.sort(),
    transformedFeatures: transformedCount,
    strayClusterBefore: diagnosis.summary.featuresStrayPct,
    strayClusterAfter,
    boundsBefore: boundsBefore || { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    boundsAfter: boundsAfter || { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  };
  
  // Write outputs
  await mkdir(dirname(args.out), { recursive: true });
  
  const outputFC: GeoJSONFC = {
    type: 'FeatureCollection',
    features: transformedFeatures
  };
  
  await writeFile(args.out, JSON.stringify(outputFC, null, 2), 'utf8');
  process.stdout.write(`  GeoJSON: ${args.out}\n`);
  
  const summaryPath = args.out.replace('.geojson', '_summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`  Summary: ${summaryPath}\n`);
  
  // Print results
  process.stdout.write('\nNormalization complete:\n');
  process.stdout.write(`  Transformed files: ${summary.transformedFiles} / ${diagnosis.summary.filesStray} STRAY files\n`);
  process.stdout.write(`  Unresolved files: ${summary.unresolvedFiles}\n`);
  process.stdout.write(`  Transformed features: ${summary.transformedFeatures}\n`);
  process.stdout.write(`  Stray cluster before: ${summary.strayClusterBefore.toFixed(2)}%\n`);
  process.stdout.write(`  Stray cluster after: ${summary.strayClusterAfter.toFixed(2)}%\n`);
  
  if (summary.strayClusterAfter > 0.5) {
    process.stdout.write(`\n  WARNING: Stray cluster still above 0.5% threshold\n`);
  }
  
  // Update markdown report
  const reportPath = resolve('docs/mapkit_regen_report.md');
  try {
    let reportContent = await readFile(reportPath, 'utf8');
    
    const normalizationSection = [
      '## Coordinate Regime Normalization',
      '',
      `- Transformed files: ${summary.transformedFiles} / ${diagnosis.summary.filesStray} STRAY files`,
      `- Unresolved files: ${summary.unresolvedFiles}`,
      summary.unresolvedFiles > 0
        ? `  - Unresolved: ${summary.unresolvedFileList.join(', ')}`
        : '',
      `- Transformed features: ${summary.transformedFeatures}`,
      `- Stray cluster before: ${summary.strayClusterBefore.toFixed(2)}%`,
      `- Stray cluster after: ${summary.strayClusterAfter.toFixed(2)}%`,
      '',
      '### Safety Gates:',
      '- Gate A (centroid distance reduction): All transformed files reduced distance to main regime by >= 90%',
      '- Gate B (scale sanity): All transformed files have scale ratios within [0.5, 2.0]',
      '- Gate C (in-bounds rate): All transformed files have >= 95% centroids within expanded main bounds',
      '',
      `**Normalized GeoJSON:** \`${args.out}\``,
      `**Summary:** \`${summaryPath}\``,
      ''
    ].filter(line => line !== '').join('\n');
    
    // Replace existing section or append
    const sectionStart = reportContent.indexOf('## Coordinate Regime Normalization');
    if (sectionStart >= 0) {
      const nextSection = reportContent.indexOf('\n## ', sectionStart + 1);
      const sectionEnd = nextSection >= 0 ? nextSection : reportContent.length;
      reportContent = reportContent.substring(0, sectionStart) + normalizationSection + '\n\n' + reportContent.substring(sectionEnd);
    } else {
      // Append before "Next Steps" section
      const nextStepsIdx = reportContent.indexOf('## Next Steps');
      if (nextStepsIdx >= 0) {
        reportContent = reportContent.substring(0, nextStepsIdx) + normalizationSection + '\n\n' + reportContent.substring(nextStepsIdx);
      } else {
        reportContent += '\n\n' + normalizationSection + '\n';
      }
    }
    
    await writeFile(reportPath, reportContent, 'utf8');
    process.stdout.write(`  Updated report: ${reportPath}\n`);
  } catch (err) {
    process.stdout.write(`  Note: Could not update report (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`normalize_settlement_regimes failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
