/**
 * MapKit remediation (pipeline-only, deterministic).
 *
 * Reads:
 * - data/derived/settlements_polygons.geojson
 * - data/diagnostics/suspects.csv (exported from UI-0 diagnostics)
 *
 * Produces (versioned, no overwrites of original):
 * - data/derived/settlements_polygons.repaired.geojson
 * - data/derived/settlements_polygons.repaired_summary.json
 * - docs/mapkit_repair_report.md
 *
 * Determinism:
 * - stable sorting by sid (string asc)
 * - no timestamps
 * - fixed-threshold heuristics
 * - fixed-iteration 2-means clustering for QA metrics
 */
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Centroid = { cx: number; cy: number };
type GeoJSONFeature = {
  type: 'Feature';
  properties?: Record<string, unknown>;
  geometry: { type: string; coordinates: any };
};
type GeoJSONFC = { type: 'FeatureCollection'; features: GeoJSONFeature[] };

const DEFAULT_INPUT = resolve('data/derived/settlements_polygons.geojson');
const DEFAULT_SUSPECTS = resolve('data/diagnostics/suspects.csv');
const DEFAULT_OUTPUT = resolve('data/derived/settlements_polygons.repaired.geojson');
const DEFAULT_SUMMARY = resolve('data/derived/settlements_polygons.repaired_summary.json');
const DEFAULT_REPORT = resolve('docs/mapkit_repair_report.md');

// Thresholds (must remain deterministic)
const MAIN_BOUNDS_PADDING = 0.1; // 10%
const REGIME_MIN_FRACTION = 0.9; // 90% consistency required
const OFFSET_MAD_FRACTION_OF_MAIN_SPAN = 0.01; // MAD must be < 1% of main span
const OUTSIDE_FRACTION_REQUIRED = 0.8; // suspects should mostly be outside if offset regime
const INSIDE_RATE_REQUIRED_AFTER = 0.99; // 99% should land inside expanded main bounds after transform
const CORE_OUTLIER_K = 8; // for core bounds if no suspects.csv

function usage(): string {
  return [
    'Usage:',
    '  tsx scripts/map/repair_settlements_geom.ts [--input <geojson>] [--suspects <csv>] [--out <geojson>] [--summary <json>] [--report <md>] [--analysis-only]',
    '',
    'Notes:',
    '- If suspects.csv is missing, runs in analysis-only mode by default (no outputs written).',
    '- Set --analysis-only to force no writes even if a safe transform is detected.',
    ''
  ].join('\n');
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--analysis-only') args['analysisOnly'] = true;
    else if (a === '--input') args['input'] = argv[++i] ?? '';
    else if (a === '--suspects') args['suspects'] = argv[++i] ?? '';
    else if (a === '--out') args['out'] = argv[++i] ?? '';
    else if (a === '--summary') args['summary'] = argv[++i] ?? '';
    else if (a === '--report') args['report'] = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args['help'] = true;
  }
  return {
    input: resolve(String(args['input'] || DEFAULT_INPUT)),
    suspects: resolve(String(args['suspects'] || DEFAULT_SUSPECTS)),
    out: resolve(String(args['out'] || DEFAULT_OUTPUT)),
    summary: resolve(String(args['summary'] || DEFAULT_SUMMARY)),
    report: resolve(String(args['report'] || DEFAULT_REPORT)),
    analysisOnly: Boolean(args['analysisOnly']),
    help: Boolean(args['help'])
  };
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(values: number[], med: number): number {
  const dev = values.map((v) => Math.abs(v - med));
  return median(dev);
}

function expandBounds(b: Bounds, paddingFrac: number): Bounds {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return {
    minX: b.minX - w * paddingFrac,
    minY: b.minY - h * paddingFrac,
    maxX: b.maxX + w * paddingFrac,
    maxY: b.maxY + h * paddingFrac
  };
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

function boundsArea(b: Bounds): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

function computeBoundsAndCentroid(feature: GeoJSONFeature): { bounds: Bounds; centroid: Centroid; ok: boolean } {
  const geom = feature.geometry;
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

  if (geom.type === 'Polygon') {
    const rings = geom.coordinates as any[];
    const outer = Array.isArray(rings) ? rings[0] : null;
    if (Array.isArray(outer)) for (const pt of outer) pushPoint(pt);
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates as any[];
    if (Array.isArray(polys)) {
      for (const poly of polys) {
        const outer = Array.isArray(poly) ? poly[0] : null;
        if (Array.isArray(outer)) for (const pt of outer) pushPoint(pt);
      }
    }
  } else {
    return { bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, centroid: { cx: 0, cy: 0 }, ok: false };
  }

  if (!Number.isFinite(minX) || n === 0) {
    return { bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, centroid: { cx: 0, cy: 0 }, ok: false };
  }
  return { bounds: { minX, minY, maxX, maxY }, centroid: { cx: sumX / n, cy: sumY / n }, ok: true };
}

function stableSid(feature: GeoJSONFeature): string {
  const sid = (feature.properties as any)?.sid;
  return sid == null ? '' : String(sid);
}

// Minimal CSV parsing with quoted fields (no dependencies).
function parseCsv(content: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        const next = content[i + 1];
        if (next === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') pushField();
      else if (c === '\n') { pushField(); pushRow(); }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  // last field
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? '';
    out.push(obj);
  }
  return out;
}

async function readSuspectsCsv(path: string): Promise<Set<string> | null> {
  try {
    await access(path);
  } catch {
    return null;
  }
  const content = await readFile(path, 'utf8');
  const parsed = parseCsv(content);
  const set = new Set<string>();
  for (const row of parsed) {
    const sid = row['sid'] ?? row['SID'] ?? '';
    if (sid) set.add(String(sid));
  }
  return set;
}

function computeCoreBoundsFromAll(centroids: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }>): Bounds {
  const xs = centroids.map((c) => c.cx);
  const ys = centroids.map((c) => c.cy);
  const medX = median(xs);
  const medY = median(ys);
  const ds = centroids.map((c) => Math.hypot(c.cx - medX, c.cy - medY));
  const medD = median(ds);
  const madD = mad(ds, medD);
  const cutoff = madD === 0 ? medD : medD + CORE_OUTLIER_K * madD;
  let b: Bounds | null = null;
  for (let i = 0; i < centroids.length; i++) {
    if (ds[i] <= cutoff) b = mergeBounds(b, centroids[i].bounds);
  }
  return b ?? centroids[0].bounds;
}

function percentInside(pts: Array<{ cx: number; cy: number }>, bounds: Bounds): number {
  if (pts.length === 0) return 1;
  let inside = 0;
  for (const p of pts) {
    if (p.cx >= bounds.minX && p.cx <= bounds.maxX && p.cy >= bounds.minY && p.cy <= bounds.maxY) inside++;
  }
  return inside / pts.length;
}

function twoMeansStrayPercent(points: Array<{ sid: string; cx: number; cy: number; bounds: Bounds }>): { strayPercent: number; mainCount: number; strayCount: number } {
  if (points.length < 2) return { strayPercent: 0, mainCount: points.length, strayCount: 0 };
  // seed1: min (cx+cy), tie sid asc
  let seed1 = points[0];
  for (const p of points) {
    const s = p.cx + p.cy;
    const sBest = seed1.cx + seed1.cy;
    if (s < sBest || (s === sBest && p.sid.localeCompare(seed1.sid) < 0)) seed1 = p;
  }
  // seed2: farthest from seed1, tie sid asc
  let seed2 = points[0] === seed1 ? points[1] : points[0];
  let bestD2 = -1;
  for (const p of points) {
    if (p === seed1) continue;
    const dx = p.cx - seed1.cx;
    const dy = p.cy - seed1.cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > bestD2 || (d2 === bestD2 && p.sid.localeCompare(seed2.sid) < 0)) {
      bestD2 = d2;
      seed2 = p;
    }
  }
  let meanA = { x: seed1.cx, y: seed1.cy };
  let meanB = { x: seed2.cx, y: seed2.cy };
  let setA = new Set<string>();
  let setB = new Set<string>();
  for (let iter = 0; iter < 10; iter++) {
    setA = new Set<string>();
    setB = new Set<string>();
    for (const p of points) {
      const dxA = p.cx - meanA.x, dyA = p.cy - meanA.y;
      const dxB = p.cx - meanB.x, dyB = p.cy - meanB.y;
      const dA = dxA * dxA + dyA * dyA;
      const dB = dxB * dxB + dyB * dyB;
      if (dA <= dB) setA.add(p.sid);
      else setB.add(p.sid);
    }
    let ax = 0, ay = 0, ac = 0;
    let bx = 0, by = 0, bc = 0;
    for (const p of points) {
      if (setA.has(p.sid)) { ax += p.cx; ay += p.cy; ac++; }
      else { bx += p.cx; by += p.cy; bc++; }
    }
    if (ac > 0) meanA = { x: ax / ac, y: ay / ac };
    if (bc > 0) meanB = { x: bx / bc, y: by / bc };
  }

  // determine main/stray by count then area
  const boundsA = points.filter(p => setA.has(p.sid)).reduce<Bounds | null>((acc, p) => mergeBounds(acc, p.bounds), null);
  const boundsB = points.filter(p => setB.has(p.sid)).reduce<Bounds | null>((acc, p) => mergeBounds(acc, p.bounds), null);
  const areaA = boundsA ? boundsArea(boundsA) : 0;
  const areaB = boundsB ? boundsArea(boundsB) : 0;
  const countA = setA.size;
  const countB = setB.size;
  const mainIsA = countA > countB ? true : countB > countA ? false : areaA >= areaB;
  const mainCount = mainIsA ? countA : countB;
  const strayCount = mainIsA ? countB : countA;
  return { strayPercent: points.length === 0 ? 0 : strayCount / points.length, mainCount, strayCount };
}

function transformCoords(coords: any, fn: (x: number, y: number) => [number, number]): any {
  if (!Array.isArray(coords)) return coords;
  // point
  if (coords.length >= 2 && typeof coords[0] !== 'object' && typeof coords[1] !== 'object') return coords;
  // coordinate pair
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const x = coords[0], y = coords[1];
    const [nx, ny] = fn(x, y);
    return [nx, ny, ...coords.slice(2)];
  }
  return coords.map((c) => transformCoords(c, fn));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  // Load suspects if present
  const suspectsSet = await readSuspectsCsv(args.suspects);
  const suspectsMissing = suspectsSet === null;
  const suspectSids = suspectsSet ?? new Set<string>();
  const analysisOnly = args.analysisOnly || suspectsMissing;
  if (suspectsMissing) {
    process.stderr.write(`Warning: suspects.csv not found at ${args.suspects}\n`);
    process.stderr.write(`  Running in analysis-only mode. Place UI export at data/diagnostics/suspects.csv to enable repair.\n`);
  }

  // Load GeoJSON
  const fc = JSON.parse(await readFile(args.input, 'utf8')) as GeoJSONFC;
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection at ${args.input}`);
  }

  // Compute per-feature stats
  const records: Array<{
    feature: GeoJSONFeature;
    sid: string;
    suspect: boolean;
    bounds: Bounds;
    centroid: Centroid;
  }> = [];

  let invalidGeomCount = 0;
  for (const f of fc.features) {
    const sid = stableSid(f);
    const { bounds, centroid, ok } = computeBoundsAndCentroid(f);
    if (!sid || !ok) {
      invalidGeomCount++;
      continue;
    }
    records.push({ feature: f, sid, suspect: suspectSids.has(sid), bounds, centroid });
  }

  records.sort((a, b) => a.sid.localeCompare(b.sid));

  const nonSuspects = records.filter(r => !r.suspect);
  const suspects = records.filter(r => r.suspect);

  const mainBoundsRaw = nonSuspects.length > 0
    ? nonSuspects.reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null)!
    : computeCoreBoundsFromAll(records.map(r => ({ sid: r.sid, cx: r.centroid.cx, cy: r.centroid.cy, bounds: r.bounds })));
  const mainBoundsExpanded = expandBounds(mainBoundsRaw, MAIN_BOUNDS_PADDING);

  const percentInsideBefore = percentInside(records.map(r => r.centroid), mainBoundsExpanded);
  const percentSuspectsInsideBefore = percentInside(suspects.map(r => r.centroid), mainBoundsExpanded);

  const strayBefore = twoMeansStrayPercent(records.map(r => ({ sid: r.sid, cx: r.centroid.cx, cy: r.centroid.cy, bounds: r.bounds })));

  // Detect regimes (suspects only)
  let decision: { kind: 'none' | 'lonlat' | 'offset' | 'scale'; params?: Record<string, number>; reason: string } = {
    kind: 'none',
    reason: 'No suspects or no safe regime detected.'
  };

  if (suspects.length > 0) {
    const lonLatCount = suspects.filter(s => Math.abs(s.centroid.cx) <= 180 && Math.abs(s.centroid.cy) <= 90).length;
    const lonLatFrac = lonLatCount / suspects.length;
    const mainSpanX = mainBoundsRaw.maxX - mainBoundsRaw.minX;
    const mainSpanY = mainBoundsRaw.maxY - mainBoundsRaw.minY;
    if (lonLatFrac >= REGIME_MIN_FRACTION && mainSpanX > 360 && mainSpanY > 180) {
      decision = {
        kind: 'lonlat',
        reason: `Lon/lat signature detected for ${(lonLatFrac * 100).toFixed(1)}% of suspects while main bounds span is large (projected).`
      };
    } else {
      // Offset hypothesis
      const outside = suspects.filter(s =>
        s.centroid.cx < mainBoundsRaw.minX || s.centroid.cx > mainBoundsRaw.maxX ||
        s.centroid.cy < mainBoundsRaw.minY || s.centroid.cy > mainBoundsRaw.maxY
      );
      const outsideFrac = outside.length / suspects.length;
      const dxs: number[] = [];
      const dys: number[] = [];
      for (const s of suspects) {
        const cx = s.centroid.cx, cy = s.centroid.cy;
        const clx = clamp(cx, mainBoundsRaw.minX, mainBoundsRaw.maxX);
        const cly = clamp(cy, mainBoundsRaw.minY, mainBoundsRaw.maxY);
        dxs.push(cx - clx);
        dys.push(cy - cly);
      }
      const medDx = median(dxs);
      const medDy = median(dys);
      const madDx = mad(dxs, medDx);
      const madDy = mad(dys, medDy);

      const dxOk = madDx <= mainSpanX * OFFSET_MAD_FRACTION_OF_MAIN_SPAN;
      const dyOk = madDy <= mainSpanY * OFFSET_MAD_FRACTION_OF_MAIN_SPAN;
      const outsideOk = outsideFrac >= OUTSIDE_FRACTION_REQUIRED;
      if (outsideOk && dxOk && dyOk) {
        // validate by applying to centroids only
        const transformed = suspects.map(s => ({ cx: s.centroid.cx - medDx, cy: s.centroid.cy - medDy }));
        const insideAfter = percentInside(transformed, mainBoundsExpanded);
        if (insideAfter >= INSIDE_RATE_REQUIRED_AFTER) {
          decision = {
            kind: 'offset',
            params: { dx: medDx, dy: medDy },
            reason: `Consistent offset detected (outsideFrac ${(outsideFrac * 100).toFixed(1)}%, MADdx ${madDx.toFixed(3)}, MADdy ${madDy.toFixed(3)}).`
          };
        }
      }

      // Scale hypothesis (only if offset not chosen)
      if (decision.kind === 'none') {
        const sBounds = suspects.reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null);
        if (sBounds) {
          const sSpanX = sBounds.maxX - sBounds.minX;
          const sSpanY = sBounds.maxY - sBounds.minY;
          if (sSpanX > 0 && sSpanY > 0) {
            const kx = mainSpanX / sSpanX;
            const ky = mainSpanY / sSpanY;
            if (Number.isFinite(kx) && Number.isFinite(ky) && kx > 0.01 && kx < 100 && ky > 0.01 && ky < 100) {
              const transformed = suspects.map(s => ({ cx: s.centroid.cx * kx, cy: s.centroid.cy * ky }));
              const insideAfter = percentInside(transformed, mainBoundsExpanded);
              if (insideAfter >= INSIDE_RATE_REQUIRED_AFTER) {
                decision = {
                  kind: 'scale',
                  params: { kx, ky },
                  reason: `Scale regime detected by span ratio (kx=${kx.toFixed(6)}, ky=${ky.toFixed(6)}), insideAfter ${(insideAfter * 100).toFixed(1)}%.`
                };
              }
            }
          }
        }
      }
    }
  }

  // Apply repair (only if safe, not analysis-only, and decision is offset/scale)
  let repairedFc: GeoJSONFC | null = null;
  let percentSuspectsInsideAfter: number | null = null;
  let percentInsideAfter: number | null = null;
  let strayAfter: { strayPercent: number; mainCount: number; strayCount: number } | null = null;

  if (!analysisOnly && (decision.kind === 'offset' || decision.kind === 'scale') && decision.params) {
    const fn =
      decision.kind === 'offset'
        ? (x: number, y: number) => [x - decision.params!.dx, y - decision.params!.dy] as [number, number]
        : (x: number, y: number) => [x * decision.params!.kx, y * decision.params!.ky] as [number, number];

    const repairedFeatures: GeoJSONFeature[] = [];
    for (const r of records) {
      const isSuspect = r.suspect;
      const src = r.feature;
      const out: GeoJSONFeature = {
        type: 'Feature',
        properties: src.properties ? { ...src.properties } : {},
        geometry: { type: src.geometry.type, coordinates: src.geometry.coordinates }
      };
      if (isSuspect) out.geometry.coordinates = transformCoords(out.geometry.coordinates, fn);
      repairedFeatures.push(out);
    }

    repairedFeatures.sort((a, b) => stableSid(a).localeCompare(stableSid(b)));
    repairedFc = { type: 'FeatureCollection', features: repairedFeatures };

    // Recompute after metrics using repaired geometry
    const afterRecs: Array<{ sid: string; suspect: boolean; bounds: Bounds; centroid: Centroid }> = [];
    for (const f of repairedFeatures) {
      const sid = stableSid(f);
      const { bounds, centroid, ok } = computeBoundsAndCentroid(f);
      if (!sid || !ok) continue;
      afterRecs.push({ sid, suspect: suspectSids.has(sid), bounds, centroid });
    }
    const afterMain = afterRecs.filter(r => !r.suspect);
    const afterMainBounds = (afterMain.length > 0
      ? afterMain.reduce<Bounds | null>((acc, r) => mergeBounds(acc, r.bounds), null)!
      : computeCoreBoundsFromAll(afterRecs.map(r => ({ sid: r.sid, cx: r.centroid.cx, cy: r.centroid.cy, bounds: r.bounds }))));
    const afterExpanded = expandBounds(afterMainBounds, MAIN_BOUNDS_PADDING);
    percentInsideAfter = percentInside(afterRecs.map(r => r.centroid), afterExpanded);
    percentSuspectsInsideAfter = percentInside(afterRecs.filter(r => r.suspect).map(r => r.centroid), afterExpanded);
    strayAfter = twoMeansStrayPercent(afterRecs.map(r => ({ sid: r.sid, cx: r.centroid.cx, cy: r.centroid.cy, bounds: r.bounds })));
  }

  // Deterministic report + summary
  const reportMd = [
    '## MapKit remediation report (deterministic)',
    '',
    '### Inputs',
    `- GeoJSON: \`${args.input}\``,
    `- Suspects CSV: \`${args.suspects}\` ${suspectsMissing ? '(MISSING)' : ''}`,
    '',
    '### Summary',
    `- total_features_read: ${fc.features.length}`,
    `- total_features_valid: ${records.length}`,
    `- invalid_or_unsupported_geometries_skipped: ${invalidGeomCount}`,
    `- suspects_in_csv: ${suspectSids.size}`,
    `- suspects_found_in_geojson: ${suspects.length}`,
    '',
    '### Main reference bounds',
    `- main_bounds_raw: ${JSON.stringify(mainBoundsRaw)}`,
    `- main_bounds_expanded(10%): ${JSON.stringify(mainBoundsExpanded)}`,
    '',
    '### Pre-repair diagnostics',
    `- percent_centroids_inside_main_bounds_expanded: ${(percentInsideBefore * 100).toFixed(2)}%`,
    `- percent_suspect_centroids_inside_main_bounds_expanded: ${(percentSuspectsInsideBefore * 100).toFixed(2)}%`,
    `- stray_cluster_percent(two-means): ${(strayBefore.strayPercent * 100).toFixed(2)}% (stray=${strayBefore.strayCount}, main=${strayBefore.mainCount})`,
    '',
    '### Regime decision',
    `- decision: ${decision.kind}`,
    `- reason: ${decision.reason}`,
    decision.params ? `- params: ${JSON.stringify(decision.params)}` : '',
    '',
    '### Repair output',
    analysisOnly
      ? '- analysis_only: true (no files written)'
      : decision.kind === 'offset' || decision.kind === 'scale'
        ? `- wrote: \`${args.out}\` and \`${args.summary}\``
        : '- no safe transform detected; no repaired GeoJSON written',
    '',
    ...(percentInsideAfter != null ? [
      '### Post-repair diagnostics',
      `- percent_centroids_inside_main_bounds_expanded: ${(percentInsideAfter * 100).toFixed(2)}%`,
      `- percent_suspect_centroids_inside_main_bounds_expanded: ${(percentSuspectsInsideAfter! * 100).toFixed(2)}%`,
      `- stray_cluster_percent(two-means): ${(strayAfter!.strayPercent * 100).toFixed(2)}% (stray=${strayAfter!.strayCount}, main=${strayAfter!.mainCount})`,
      ''
    ] : []),
    '### Next steps if decision is `lonlat` or `none`',
    '- This script intentionally refuses to auto-fix ambiguous cases.',
    '- If `lonlat`: locate authoritative projection step/parameters in MapKit source and reproject those geometries upstream.',
    '- If `none`: investigate SID↔geometry join integrity (wrong geometry attached to SID) and/or multiple regimes.',
    ''
  ].filter((l) => l !== '').join('\n') + '\n';

  const summaryJson = {
    input: args.input,
    suspects_csv: args.suspects,
    total_features_read: fc.features.length,
    total_features_valid: records.length,
    invalid_or_unsupported_geometries_skipped: invalidGeomCount,
    suspects_in_csv: suspectSids.size,
    suspects_found_in_geojson: suspects.length,
    decision,
    main_bounds_raw: mainBoundsRaw,
    main_bounds_expanded: mainBoundsExpanded,
    pre: {
      percent_inside_main_bounds_expanded: percentInsideBefore,
      percent_suspects_inside_main_bounds_expanded: percentSuspectsInsideBefore,
      stray_cluster_percent: strayBefore.strayPercent,
      stray_cluster_count: strayBefore.strayCount
    },
    post: percentInsideAfter == null ? null : {
      percent_inside_main_bounds_expanded: percentInsideAfter,
      percent_suspects_inside_main_bounds_expanded: percentSuspectsInsideAfter,
      stray_cluster_percent: strayAfter!.strayPercent,
      stray_cluster_count: strayAfter!.strayCount
    }
  };

  // Write outputs (if not analysis-only and we produced repaired FC)
  if (!analysisOnly && repairedFc) {
    await mkdir(resolve('data/derived'), { recursive: true });
    await writeFile(args.out, JSON.stringify(repairedFc, null, 2) + '\n', 'utf8');
    await writeFile(args.summary, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8');
  }
  // Always write report deterministically (even analysis-only) so docs is present; no timestamps.
  await mkdir(resolve('docs'), { recursive: true });
  await writeFile(args.report, reportMd, 'utf8');

  process.stdout.write(`MapKit repair analysis complete.\n`);
  process.stdout.write(`  decision=${decision.kind}${analysisOnly ? ' (analysis-only)' : ''}\n`);
  process.stdout.write(`  report=${args.report}\n`);
  if (!analysisOnly && repairedFc) {
    process.stdout.write(`  repaired_geojson=${args.out}\n`);
    process.stdout.write(`  summary=${args.summary}\n`);
  }

  // Exit non-zero if we detected lonlat/none but had suspects (action required)
  if (suspects.length > 0 && (decision.kind === 'lonlat' || decision.kind === 'none')) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`repair_settlements_geom failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

