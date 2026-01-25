/**
 * MapKit artifact validator (pipeline-only, deterministic).
 *
 * Validates a settlements polygons GeoJSON (original or repaired):
 * - no NaN/Infinity in outer rings
 * - global bounds are finite and not absurdly large relative to core bounds
 * - 99%+ of centroids are inside expanded core bounds (10%)
 * - stable sort by sid is possible (and duplicates detected)
 * Note: two-means stray cluster is computed and reported but not treated as an error.
 *
 * Usage:
 *   tsx src/cli/mapkit_validate.ts [--input <geojson>] [--stray-max <fraction>] [--inside-min <fraction>]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type GeoJSONFeature = { type: 'Feature'; properties?: Record<string, unknown>; geometry: { type: string; coordinates: any } };
type GeoJSONFC = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

const DEFAULT_INPUT = resolve('data/derived/settlements_polygons.geojson');
const MAIN_BOUNDS_PADDING = 0.1;
const CORE_OUTLIER_K = 8;

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i] ?? '';
    else if (a === '--stray-max') args.strayMax = argv[++i] ?? '';
    else if (a === '--inside-min') args.insideMin = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = '1';
  }
  return {
    input: resolve(args.input || DEFAULT_INPUT),
    strayMax: args.strayMax ? Number(args.strayMax) : 0.005,
    insideMin: args.insideMin ? Number(args.insideMin) : 0.99,
    help: Boolean(args.help)
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(values: number[], med: number): number {
  return median(values.map((v) => Math.abs(v - med)));
}

function mergeBounds(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

function expandBounds(b: Bounds, paddingFrac: number): Bounds {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return { minX: b.minX - w * paddingFrac, minY: b.minY - h * paddingFrac, maxX: b.maxX + w * paddingFrac, maxY: b.maxY + h * paddingFrac };
}

function boundsArea(b: Bounds): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

function stableSid(f: GeoJSONFeature): string {
  const sid = (f.properties as any)?.sid;
  return sid == null ? '' : String(sid);
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function computeBoundsAndCentroid(feature: GeoJSONFeature): { sid: string; bounds: Bounds; cx: number; cy: number; ok: boolean; nonFinitePoints: number } {
  const sid = stableSid(feature);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0, n = 0;
  let nonFinite = 0;
  const pushPoint = (pt: any) => {
    if (!Array.isArray(pt) || pt.length < 2) { nonFinite++; return; }
    const x = toFiniteNumber(pt[0]);
    const y = toFiniteNumber(pt[1]);
    if (x === null || y === null) { nonFinite++; return; }
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
    return { sid, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, cx: 0, cy: 0, ok: false, nonFinitePoints: nonFinite };
  }
  if (!sid || !Number.isFinite(minX) || n === 0) return { sid, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, cx: 0, cy: 0, ok: false, nonFinitePoints: nonFinite };
  return { sid, bounds: { minX, minY, maxX, maxY }, cx: sumX / n, cy: sumY / n, ok: true, nonFinitePoints: nonFinite };
}

function computeCoreBounds(records: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }>): Bounds {
  const xs = records.map(r => r.cx);
  const ys = records.map(r => r.cy);
  const medX = median(xs);
  const medY = median(ys);
  const ds = records.map(r => Math.hypot(r.cx - medX, r.cy - medY));
  const medD = median(ds);
  const madD = mad(ds, medD);
  const cutoff = madD === 0 ? medD : medD + CORE_OUTLIER_K * madD;
  let b: Bounds | null = null;
  for (let i = 0; i < records.length; i++) if (ds[i] <= cutoff) b = mergeBounds(b, records[i].bounds);
  return b ?? records[0].bounds;
}

function twoMeansStrayPercent(records: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }>): { strayPercent: number; strayCount: number; mainCount: number } {
  if (records.length < 2) return { strayPercent: 0, strayCount: 0, mainCount: records.length };
  let seed1 = records[0];
  for (const r of records) {
    const s = r.cx + r.cy;
    const sb = seed1.cx + seed1.cy;
    if (s < sb || (s === sb && r.sid.localeCompare(seed1.sid) < 0)) seed1 = r;
  }
  let seed2 = records[0] === seed1 ? records[1] : records[0];
  let bestD2 = -1;
  for (const r of records) {
    if (r === seed1) continue;
    const dx = r.cx - seed1.cx, dy = r.cy - seed1.cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > bestD2 || (d2 === bestD2 && r.sid.localeCompare(seed2.sid) < 0)) { bestD2 = d2; seed2 = r; }
  }
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
  return { strayPercent: strayCount / records.length, strayCount, mainCount };
}

function percentInside(points: Array<{ cx: number; cy: number }>, b: Bounds): number {
  if (points.length === 0) return 1;
  let inside = 0;
  for (const p of points) if (p.cx >= b.minX && p.cx <= b.maxX && p.cy >= b.minY && p.cy <= b.maxY) inside++;
  return inside / points.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('tsx src/cli/mapkit_validate.ts [--input <geojson>] [--stray-max <fraction>] [--inside-min <fraction>]\n');
    return;
  }
  const fc = JSON.parse(await readFile(args.input, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error(`Invalid GeoJSON FeatureCollection: ${args.input}`);

  const recs: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }> = [];
  let nonFinitePoints = 0;
  let badFeatures = 0;
  const sidSeen = new Set<string>();
  const duplicateSids: string[] = [];

  for (const f of fc.features) {
    const r = computeBoundsAndCentroid(f);
    nonFinitePoints += r.nonFinitePoints;
    if (!r.ok) { badFeatures++; continue; }
    if (sidSeen.has(r.sid)) duplicateSids.push(r.sid);
    sidSeen.add(r.sid);
    recs.push({ sid: r.sid, cx: r.cx, cy: r.cy, bounds: r.bounds });
  }

  recs.sort((a, b) => a.sid.localeCompare(b.sid));

  const globalBounds = recs.reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null);
  const coreBounds = computeCoreBounds(recs);
  const coreExpanded = expandBounds(coreBounds, MAIN_BOUNDS_PADDING);
  const insideRate = percentInside(recs.map(r => ({ cx: r.cx, cy: r.cy })), coreExpanded);
  const stray = twoMeansStrayPercent(recs);

  // Regression guards: ensure canonical map maintains quality standards
  // These checks prevent pipeline changes from reintroducing issues:
  // - NaN/Infinity detection
  // - Stable SID ordering (no duplicates)
  // - Inside-main-bounds rate high (>= 99% default)
  // - Finite global bounds
  const issues: string[] = [];
  const warnings: string[] = [];
  if (nonFinitePoints > 0) issues.push(`nonFinitePoints=${nonFinitePoints}`);
  if (badFeatures > 0) issues.push(`badFeatures=${badFeatures}`);
  if (duplicateSids.length > 0) issues.push(`duplicateSids=${duplicateSids.length} (first: ${duplicateSids.slice(0, 5).join(', ')})`);
  if (!globalBounds || !Number.isFinite(globalBounds.minX) || !Number.isFinite(globalBounds.maxX)) issues.push('globalBoundsNonFinite');

  // absurd bounds heuristic: if global area > 1e6 * core area, likely wrong regime
  const coreArea = boundsArea(coreBounds);
  const globalArea = globalBounds ? boundsArea(globalBounds) : Infinity;
  if (coreArea > 0 && globalArea / coreArea > 1e6) issues.push(`absurdBoundsAreaRatio=${(globalArea / coreArea).toExponential(2)}`);

  if (insideRate < args.insideMin) issues.push(`insideRate=${(insideRate * 100).toFixed(2)}% < ${(args.insideMin * 100).toFixed(2)}%`);
  if (stray.strayPercent > args.strayMax) warnings.push(`strayCluster=${(stray.strayPercent * 100).toFixed(2)}% > ${(args.strayMax * 100).toFixed(2)}% (informational only)`);

  process.stdout.write(`MapKit validate: ${args.input}\n`);
  process.stdout.write(`  valid_features=${recs.length}, bad_features=${badFeatures}, non_finite_points=${nonFinitePoints}\n`);
  process.stdout.write(`  core_bounds=${JSON.stringify(coreBounds)}\n`);
  process.stdout.write(`  inside_rate(core+10%)=${(insideRate * 100).toFixed(2)}%\n`);
  process.stdout.write(`  stray_cluster(two-means)=${(stray.strayPercent * 100).toFixed(2)}% (stray=${stray.strayCount}, main=${stray.mainCount})\n`);
  if (duplicateSids.length > 0) process.stdout.write(`  duplicate_sids_sample=${duplicateSids.slice(0, 10).join(', ')}\n`);

  if (warnings.length > 0) {
    process.stdout.write(`Warnings (${warnings.length}):\n`);
    for (const w of warnings) process.stdout.write(`- ${w}\n`);
  }

  if (issues.length > 0) {
    process.stdout.write(`Issues (${issues.length}):\n`);
    for (const i of issues) process.stdout.write(`- ${i}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('No issues found.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`mapkit_validate failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

