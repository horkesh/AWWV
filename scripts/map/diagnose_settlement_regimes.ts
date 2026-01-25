/**
 * Coordinate regime diagnosis: Identify which source JS files are in MAIN vs STRAY coordinate regimes.
 * 
 * This script analyzes the regenerated settlements GeoJSON to:
 * 1) Aggregate per-source-file statistics (centroids, bounds)
 * 2) Cluster sources into MAIN vs STRAY regimes using 2-means
 * 3) Compute transform hints (offset, scale) for STRAY sources
 * 4) Output diagnosis JSON artifact for use in normalization step
 * 
 * Usage:
 *   tsx scripts/map/diagnose_settlement_regimes.ts [--input <geojson>]
 * 
 * Defaults:
 *   input: data/derived/settlements_polygons.regen.geojson
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

function parseArgs(argv: string[]): { input: string; help: boolean } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = '1';
  }
  return {
    input: args.input || resolve('data/derived/settlements_polygons.regen.geojson'),
    help: Boolean(args.help)
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

function twoMeansCluster(points: Array<{ x: number; y: number; id: string }>): {
  clusterA: string[];
  clusterB: string[];
} {
  if (points.length < 2) {
    return { clusterA: points.map(p => p.id), clusterB: [] };
  }
  
  // Deterministic seed selection: min sum
  let seed1Idx = 0;
  let minSum = points[0].x + points[0].y;
  for (let i = 1; i < points.length; i++) {
    const sum = points[i].x + points[i].y;
    if (sum < minSum || (sum === minSum && points[i].id.localeCompare(points[seed1Idx].id) < 0)) {
      minSum = sum;
      seed1Idx = i;
    }
  }
  
  // Seed2: farthest from seed1
  let seed2Idx = 0;
  let maxDistSq = 0;
  const seed1 = points[seed1Idx];
  for (let i = 0; i < points.length; i++) {
    if (i === seed1Idx) continue;
    const dx = points[i].x - seed1.x;
    const dy = points[i].y - seed1.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxDistSq || (distSq === maxDistSq && points[i].id.localeCompare(points[seed2Idx].id) < 0)) {
      maxDistSq = distSq;
      seed2Idx = i;
    }
  }
  
  // 10 iterations
  let meanA = { x: seed1.x, y: seed1.y };
  let meanB = { x: points[seed2Idx].x, y: points[seed2Idx].y };
  let clusterA: string[] = [];
  let clusterB: string[] = [];
  
  for (let iter = 0; iter < 10; iter++) {
    clusterA = [];
    clusterB = [];
    
    for (const p of points) {
      const dxA = p.x - meanA.x;
      const dyA = p.y - meanA.y;
      const distSqA = dxA * dxA + dyA * dyA;
      
      const dxB = p.x - meanB.x;
      const dyB = p.y - meanB.y;
      const distSqB = dxB * dxB + dyB * dyB;
      
      if (distSqA <= distSqB) {
        clusterA.push(p.id);
      } else {
        clusterB.push(p.id);
      }
    }
    
    // Update means
    let ax = 0, ay = 0, ac = 0, bx = 0, by = 0, bc = 0;
    for (const p of points) {
      if (clusterA.includes(p.id)) {
        ax += p.x;
        ay += p.y;
        ac++;
      } else {
        bx += p.x;
        by += p.y;
        bc++;
      }
    }
    if (ac > 0) meanA = { x: ax / ac, y: ay / ac };
    if (bc > 0) meanB = { x: bx / bc, y: by / bc };
  }
  
  return { clusterA, clusterB };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help) {
    process.stdout.write([
      'Usage:',
      '  tsx scripts/map/diagnose_settlement_regimes.ts [--input <geojson>]',
      '',
      'Defaults:',
      `  input: ${args.input}`,
      ''
    ].join('\n'));
    return;
  }
  
  process.stdout.write('Coordinate regime diagnosis\n');
  process.stdout.write(`  Input: ${args.input}\n\n`);
  
  // Load GeoJSON
  const fc = JSON.parse(await readFile(args.input, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${args.input}`);
  }
  
  process.stdout.write(`  Loaded ${fc.features.length} features\n`);
  
  // Aggregate by source file
  const sourceMap = new Map<string, {
    file: string;
    munCode: string;
    centroids: Array<{ cx: number; cy: number }>;
    widths: number[];
    heights: number[];
    areas: number[];
    bounds: Bounds | null;
    centroidBounds: Bounds | null;
  }>();
  
  for (const feature of fc.features) {
    const sourceFile = feature.properties.source_js_file as string | undefined;
    if (!sourceFile) continue;
    
    const munCode = feature.properties.mun_code as string || 'unknown';
    
    if (!sourceMap.has(sourceFile)) {
      sourceMap.set(sourceFile, {
        file: sourceFile,
        munCode,
        centroids: [],
        widths: [],
        heights: [],
        areas: [],
        bounds: null,
        centroidBounds: null
      });
    }
    
    const stats = sourceMap.get(sourceFile)!;
    const centroid = computeCentroid(feature);
    const bounds = computeBounds(feature);
    
    if (centroid) {
      stats.centroids.push(centroid);
      
      if (!stats.centroidBounds) {
        stats.centroidBounds = { minX: centroid.cx, minY: centroid.cy, maxX: centroid.cx, maxY: centroid.cy };
      } else {
        stats.centroidBounds.minX = Math.min(stats.centroidBounds.minX, centroid.cx);
        stats.centroidBounds.minY = Math.min(stats.centroidBounds.minY, centroid.cy);
        stats.centroidBounds.maxX = Math.max(stats.centroidBounds.maxX, centroid.cx);
        stats.centroidBounds.maxY = Math.max(stats.centroidBounds.maxY, centroid.cy);
      }
    }
    
    if (bounds) {
      const w = bounds.maxX - bounds.minX;
      const h = bounds.maxY - bounds.minY;
      const a = boundsArea(bounds);
      
      stats.widths.push(w);
      stats.heights.push(h);
      stats.areas.push(a);
      
      if (!stats.bounds) {
        stats.bounds = { ...bounds };
      } else {
        stats.bounds.minX = Math.min(stats.bounds.minX, bounds.minX);
        stats.bounds.minY = Math.min(stats.bounds.minY, bounds.minY);
        stats.bounds.maxX = Math.max(stats.bounds.maxX, bounds.maxX);
        stats.bounds.maxY = Math.max(stats.bounds.maxY, bounds.maxY);
      }
    }
  }
  
  process.stdout.write(`  Aggregated ${sourceMap.size} source files\n`);
  
  // Compute per-source statistics
  const sources: SourceStats[] = [];
  for (const [file, stats] of Array.from(sourceMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    sources.push({
      file,
      munCode: stats.munCode,
      featureCount: stats.centroids.length,
      medCx: median(stats.centroids.map(c => c.cx)),
      medCy: median(stats.centroids.map(c => c.cy)),
      medW: median(stats.widths),
      medH: median(stats.heights),
      medA: median(stats.areas),
      bounds: stats.bounds || { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      centroidBounds: stats.centroidBounds || { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      cluster: 'MAIN' // Will be assigned below
    });
  }
  
  // Cluster sources into MAIN vs STRAY
  const clusterPoints = sources.map(s => ({
    x: s.medCx,
    y: s.medCy,
    id: s.file
  }));
  
  const { clusterA, clusterB } = twoMeansCluster(clusterPoints);
  
  // Determine which is MAIN (larger feature count, tie to bbox area, tie to A)
  const countA = sources.filter(s => clusterA.includes(s.file)).reduce((sum, s) => sum + s.featureCount, 0);
  const countB = sources.filter(s => clusterB.includes(s.file)).reduce((sum, s) => sum + s.featureCount, 0);
  
  let mainCluster: string[];
  let strayCluster: string[];
  
  if (countA > countB) {
    mainCluster = clusterA;
    strayCluster = clusterB;
  } else if (countB > countA) {
    mainCluster = clusterB;
    strayCluster = clusterA;
  } else {
    // Tie: use bbox area
    const areaA = sources.filter(s => clusterA.includes(s.file))
      .reduce((sum, s) => sum + boundsArea(s.bounds), 0);
    const areaB = sources.filter(s => clusterB.includes(s.file))
      .reduce((sum, s) => sum + boundsArea(s.bounds), 0);
    
    if (areaA >= areaB) {
      mainCluster = clusterA;
      strayCluster = clusterB;
    } else {
      mainCluster = clusterB;
      strayCluster = clusterA;
    }
  }
  
  // Assign clusters
  for (const source of sources) {
    source.cluster = mainCluster.includes(source.file) ? 'MAIN' : 'STRAY';
  }
  
  // Compute main regime reference (medians of source medians)
  const mainSources = sources.filter(s => s.cluster === 'MAIN');
  const mainMedCx = median(mainSources.map(s => s.medCx));
  const mainMedCy = median(mainSources.map(s => s.medCy));
  const mainMedW = median(mainSources.map(s => s.medW));
  const mainMedH = median(mainSources.map(s => s.medH));
  
  // Compute transform hints for STRAY sources
  for (const source of sources) {
    if (source.cluster === 'STRAY') {
      const dx = mainMedCx - source.medCx;
      const dy = mainMedCy - source.medCy;
      const kx = source.medW > 0 ? mainMedW / source.medW : 1;
      const ky = source.medH > 0 ? mainMedH / source.medH : 1;
      const k = Math.sqrt(kx * ky);
      
      // Label heuristic
      let label = 'likelyScale+Offset';
      if (Math.abs(kx - 1) < 0.05 && Math.abs(ky - 1) < 0.05 && Math.abs(dx) + Math.abs(dy) > 100) {
        label = 'likelyOffsetOnly';
      } else if (Math.abs(dx) + Math.abs(dy) < 50 && (Math.abs(kx - 1) > 0.2 || Math.abs(ky - 1) > 0.2)) {
        label = 'likelyScaleOnly';
      }
      if (kx < 0 || ky < 0) {
        label = 'suspiciousMirror';
      }
      
      source.hints = { dx, dy, kx, ky, k, label };
    }
  }
  
  // Build diagnosis
  const diagnosis: RegimeDiagnosis = {
    main: {
      files: mainSources.map(s => s.file).sort(),
      mainMedCx,
      mainMedCy,
      mainMedW,
      mainMedH
    },
    stray: {
      files: sources.filter(s => s.cluster === 'STRAY').map(s => s.file).sort()
    },
    sources: sources.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      filesTotal: sources.length,
      filesStray: strayCluster.length,
      featuresTotal: sources.reduce((sum, s) => sum + s.featureCount, 0),
      featuresStray: sources.filter(s => s.cluster === 'STRAY').reduce((sum, s) => sum + s.featureCount, 0),
      featuresStrayPct: 0
    }
  };
  
  diagnosis.summary.featuresStrayPct = diagnosis.summary.featuresTotal > 0
    ? (diagnosis.summary.featuresStray / diagnosis.summary.featuresTotal) * 100
    : 0;
  
  // Write diagnosis JSON
  const diagnosisPath = resolve('data/derived/mapkit_regime_diagnosis.json');
  await mkdir(dirname(diagnosisPath), { recursive: true });
  await writeFile(diagnosisPath, JSON.stringify(diagnosis, null, 2), 'utf8');
  
  process.stdout.write(`\nDiagnosis complete:\n`);
  process.stdout.write(`  Files total: ${diagnosis.summary.filesTotal}\n`);
  process.stdout.write(`  Files STRAY: ${diagnosis.summary.filesStray} (${(diagnosis.summary.filesStray / diagnosis.summary.filesTotal * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  Features total: ${diagnosis.summary.featuresTotal}\n`);
  process.stdout.write(`  Features STRAY: ${diagnosis.summary.featuresStray} (${diagnosis.summary.featuresStrayPct.toFixed(2)}%)\n`);
  process.stdout.write(`  Diagnosis: ${diagnosisPath}\n`);
  
  // Print top STRAY files
  const straySources = sources.filter(s => s.cluster === 'STRAY')
    .sort((a, b) => b.featureCount - a.featureCount)
    .slice(0, 20);
  
  if (straySources.length > 0) {
    process.stdout.write(`\nTop 20 STRAY files:\n`);
    for (const s of straySources) {
      const hints = s.hints!;
      process.stdout.write(`  ${s.file}: ${s.featureCount} features, dx=${hints.dx.toFixed(1)}, dy=${hints.dy.toFixed(1)}, kx=${hints.kx.toFixed(3)}, ky=${hints.ky.toFixed(3)} (${hints.label})\n`);
    }
  }
  
  // Update markdown report
  const reportPath = resolve('docs/mapkit_regen_report.md');
  try {
    let reportContent = await readFile(reportPath, 'utf8');
    
    // Find and replace the Coordinate Regime Diagnosis section
    const diagnosisSection = [
      '## Coordinate Regime Diagnosis',
      '',
      `- Files STRAY: ${diagnosis.summary.filesStray} / ${diagnosis.summary.filesTotal} (${(diagnosis.summary.filesStray / diagnosis.summary.filesTotal * 100).toFixed(1)}%)`,
      `- Features STRAY: ${diagnosis.summary.featuresStray} / ${diagnosis.summary.featuresTotal} (${diagnosis.summary.featuresStrayPct.toFixed(2)}%)`,
      '',
      '### Top 20 STRAY Files (by feature count):',
      ...straySources.map(s => {
        const hints = s.hints!;
        return `- **${s.file}**: ${s.featureCount} features, dx=${hints.dx.toFixed(1)}, dy=${hints.dy.toFixed(1)}, kx=${hints.kx.toFixed(3)}, ky=${hints.ky.toFixed(3)} (${hints.label})`;
      }),
      '',
      `**Diagnosis artifact:** \`data/derived/mapkit_regime_diagnosis.json\``,
      '',
      '**Note:** No transforms applied yet. Next step is deterministic normalization using this diagnosis.'
    ].join('\n');
    
    // Replace existing section or append
    const sectionStart = reportContent.indexOf('## Coordinate Regime Diagnosis');
    if (sectionStart >= 0) {
      // Find end of section (next ## or end of file)
      const nextSection = reportContent.indexOf('\n## ', sectionStart + 1);
      const sectionEnd = nextSection >= 0 ? nextSection : reportContent.length;
      reportContent = reportContent.substring(0, sectionStart) + diagnosisSection + '\n\n' + reportContent.substring(sectionEnd);
    } else {
      // Append before "Next Steps" section
      const nextStepsIdx = reportContent.indexOf('## Next Steps');
      if (nextStepsIdx >= 0) {
        reportContent = reportContent.substring(0, nextStepsIdx) + diagnosisSection + '\n\n' + reportContent.substring(nextStepsIdx);
      } else {
        // Append at end
        reportContent += '\n\n' + diagnosisSection + '\n';
      }
    }
    
    await writeFile(reportPath, reportContent, 'utf8');
    process.stdout.write(`  Updated report: ${reportPath}\n`);
  } catch (err) {
    // Report file might not exist yet, that's okay
    process.stdout.write(`  Note: Could not update report (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`diagnose_settlement_regimes failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
