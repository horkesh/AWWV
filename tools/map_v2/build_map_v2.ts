/**
 * Map v2 Build: Clean rebuild from master_municipalities.zip + settlements_pack.zip
 * 
 * Key features:
 * - Correct Raphael.js parsing with transform support
 * - Strict order-based join (count equality required)
 * - Geometry sanity checks including comb detector
 * - Normalized coordinate space
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { chooseSettlementRing, ringToCoords, DropReason } from '../map/geometry_pipeline';
import { isRenderValid } from '../map/render_valid';

// Mistake guard
loadMistakes();
assertNoRepeat("Map v2 rebuild from master_municipalities.zip + settlements_pack.zip");

// Types
interface MasterMunicipality {
  id: string;
  name: string;
  name_ascii?: string;
  total_settlements?: number;
  total_population?: number;
  total_bosniaks?: number;
  total_croats?: number;
  total_serbs?: number;
  total_others?: number;
  capital_sid?: string | null;
  settlements: MasterSettlement[];
}

interface MasterSettlement {
  settlement_id: string;
  name: string;
  total_population: number;
  bosniaks: number | null;
  croats: number | null;
  serbs: number | null;
  others: number | null;
  settlement_type?: string;
  is_urban_center?: boolean;
  is_municipality_capital?: boolean;
  svg_path?: string | null;
  mapping_note?: string | null;
}

interface MasterData {
  version: string;
  source: {
    census: string;
    svg_pack: string;
  };
  municipalities: MasterMunicipality[];
}

interface MunicipalityMeta {
  mid: string;
  name: string;
  capital_sid: string | null;
  totals_by_group: {
    bosniaks: number;
    croats: number;
    serbs: number;
    others: number;
  };
  total_settlements: number;
  settlements_with_geometry: number;
}

interface SettlementMeta {
  sid: string;
  mid: string;
  name: string;
  settlement_type: string;
  is_urban_center: boolean;
  is_municipality_capital: boolean;
  total_population: number;
  bosniaks: number;
  croats: number;
  serbs: number;
  others: number;
  has_geometry: boolean;
  geometry_method?: "ring" | "ring_simplified_salvage" | "convex_hull_salvage" | "convex_hull_salvage_high_inflation";
  hull_inflation_ratio?: number | null;
  drop_reason?: string;
}

interface MapBounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  width: number;
  height: number;
}

interface GeometrySanity {
  total_settlements: number;
  settlements_joined: number;
  settlements_with_geometry: number;
  dropped_by_reason: Record<string, number>;
  transform_usage: {
    settlements_with_transform: number;
    settlements_without_transform: number;
    unsupported_transform_count: number;
  };
  coordinate_stats: {
    global_min_x: number;
    global_min_y: number;
    global_max_x: number;
    global_max_y: number;
    max_abs_coord: number;
    bbox_width_percentiles: number[];
    bbox_height_percentiles: number[];
  };
  comb_detector: {
    suspect_comb_count: number;
    suspect_comb_percent: number;
  };
}

interface ExtractedPath {
  pathString: string;
  transform: Transform | null;
  hasUnsupportedTransform: boolean;
}

interface Transform {
  translate?: { x: number; y: number };
  scale?: { x: number; y: number; cx?: number; cy?: number };
  rotate?: { angle: number; cx?: number; cy?: number };
}

// Constants
const MASTER_FILE = resolve('data/source_v2/master_municipalities.json');
const CACHE_DIR = resolve('tools/map_v2/.cache/settlements_pack');
const DERIVED_DIR = resolve('data/derived_v2');
const CURVE_SEGMENTS = 10;
const MAX_HULL_RATIO = 6.0;

/**
 * Parse Raphael transform string
 * Supports: tX,Y (translate), sS or sSx,Sy (scale), rA or rA,cx,cy (rotate)
 */
function parseTransform(transformStr: string): Transform | null {
  if (!transformStr || !transformStr.trim()) return null;
  
  const transform: Transform = {};
  const tokens = transformStr.trim().split(/\s+/);
  
  for (const token of tokens) {
    if (!token) continue;
    const cmd = token[0].toLowerCase();
    const args = token.slice(1).split(',');
    
    if (cmd === 't' && args.length >= 2) {
      const x = parseFloat(args[0]);
      const y = parseFloat(args[1]);
      if (isFinite(x) && isFinite(y)) {
        transform.translate = { x, y };
      }
    } else if (cmd === 's') {
      if (args.length >= 1) {
        const sx = parseFloat(args[0]);
        const sy = args.length >= 2 ? parseFloat(args[1]) : sx;
        const cx = args.length >= 3 ? parseFloat(args[2]) : undefined;
        const cy = args.length >= 4 ? parseFloat(args[3]) : undefined;
        if (isFinite(sx) && isFinite(sy)) {
          transform.scale = { x: sx, y: sy };
          if (cx !== undefined && cy !== undefined && isFinite(cx) && isFinite(cy)) {
            transform.scale.cx = cx;
            transform.scale.cy = cy;
          }
        }
      }
    } else if (cmd === 'r' && args.length >= 1) {
      const angle = parseFloat(args[0]);
      const cx = args.length >= 2 ? parseFloat(args[1]) : undefined;
      const cy = args.length >= 3 ? parseFloat(args[2]) : undefined;
      if (isFinite(angle)) {
        transform.rotate = { angle };
        if (cx !== undefined && cy !== undefined && isFinite(cx) && isFinite(cy)) {
          transform.rotate.cx = cx;
          transform.rotate.cy = cy;
        }
      }
    }
  }
  
  return Object.keys(transform).length > 0 ? transform : null;
}

/**
 * Apply transform to a point
 */
function applyTransform(x: number, y: number, transform: Transform | null): [number, number] {
  if (!transform) return [x, y];
  
  let tx = x;
  let ty = y;
  
  // Apply rotate (around center if specified, else origin)
  if (transform.rotate) {
    const angle = (transform.rotate.angle * Math.PI) / 180;
    const cx = transform.rotate.cx ?? 0;
    const cy = transform.rotate.cy ?? 0;
    const dx = tx - cx;
    const dy = ty - cy;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    tx = cx + dx * cos - dy * sin;
    ty = cy + dx * sin + dy * cos;
  }
  
  // Apply scale (around center if specified, else origin)
  if (transform.scale) {
    const cx = transform.scale.cx ?? 0;
    const cy = transform.scale.cy ?? 0;
    tx = cx + (tx - cx) * transform.scale.x;
    ty = cy + (ty - cy) * transform.scale.y;
  }
  
  // Apply translate
  if (transform.translate) {
    tx += transform.translate.x;
    ty += transform.translate.y;
  }
  
  return [tx, ty];
}

/**
 * Apply transform to all points in a Float32Array ring
 */
function applyTransformToRing(ring: Float32Array, transform: Transform | null): Float32Array {
  if (!transform) return ring;
  
  const result = new Float32Array(ring.length);
  for (let i = 0; i < ring.length; i += 2) {
    const [tx, ty] = applyTransform(ring[i], ring[i + 1], transform);
    result[i] = tx;
    result[i + 1] = ty;
  }
  return result;
}

/**
 * Extract paths and transforms from Raphael.js file
 * Matches R.path("...") and chained .transform(...), .translate(...), .scale(...)
 */
function extractPathsFromJS(content: string): ExtractedPath[] {
  const paths: ExtractedPath[] = [];
  
  // Match R.path("...") or R.path('...')
  const raphaelPathRegex = /R\.path\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g;
  
  let match;
  while ((match = raphaelPathRegex.exec(content)) !== null) {
    const pathStr = match[2]
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    
    // Look ahead for chained transform calls
    const afterMatch = content.slice(match.index + match[0].length);
    
    // Match .transform("...") or .transform('...')
    let transform: Transform | null = null;
    let hasUnsupportedTransform = false;
    
    const transformMatch = afterMatch.match(/\.transform\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/);
    if (transformMatch) {
      const transformStr = transformMatch[2]
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
      transform = parseTransform(transformStr);
      if (!transform) {
        hasUnsupportedTransform = true;
      }
    } else {
      // Check for .translate(X, Y) or .scale(Sx, Sy[, cx, cy])
      const translateMatch = afterMatch.match(/\.translate\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/);
      if (translateMatch) {
        const x = parseFloat(translateMatch[1]);
        const y = parseFloat(translateMatch[2]);
        if (isFinite(x) && isFinite(y)) {
          transform = { translate: { x, y } };
        }
      } else {
        const scaleMatch = afterMatch.match(/\.scale\s*\(\s*([^,)]+)(?:\s*,\s*([^,)]+))?(?:\s*,\s*([^,)]+))?(?:\s*,\s*([^)]+))?\s*\)/);
        if (scaleMatch) {
          const sx = parseFloat(scaleMatch[1]);
          const sy = scaleMatch[2] ? parseFloat(scaleMatch[2]) : sx;
          const cx = scaleMatch[3] ? parseFloat(scaleMatch[3]) : undefined;
          const cy = scaleMatch[4] ? parseFloat(scaleMatch[4]) : undefined;
          if (isFinite(sx) && isFinite(sy)) {
            transform = { scale: { x: sx, y: sy } };
            if (cx !== undefined && cy !== undefined && isFinite(cx) && isFinite(cy)) {
              transform.scale.cx = cx;
              transform.scale.cy = cy;
            }
          }
        }
      }
    }
    
    paths.push({
      pathString: pathStr,
      transform,
      hasUnsupportedTransform
    });
  }
  
  return paths;
}

/**
 * Normalize name for matching
 */
function normalizeName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract municipality ID from filename
 */
function extractMIDFromFilename(filename: string): string | null {
  const match = filename.match(/_(\d+)(?:\.js)?$/i);
  return match ? match[1] : null;
}

/**
 * Find JS file for municipality
 */
async function findJSFileForMunicipality(
  muni: MasterMunicipality,
  jsFiles: Map<string, string>
): Promise<string | null> {
  const mid = muni.id;
  const name = normalizeName(muni.name);
  
  for (const filename of jsFiles.keys()) {
    const fileMID = extractMIDFromFilename(filename);
    const fileName = basename(filename, '.js').replace(/_\d+$/, '');
    
    if (fileMID === mid || normalizeName(fileName) === name) {
      return jsFiles.get(filename) || null;
    }
  }
  
  return null;
}

/**
 * Recursively find all JS files
 */
async function findJSFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.js') {
        files.push(fullPath);
      }
    }
  }
  
  await walk(dir);
  return files;
}

/**
 * Compute comb detector metrics for a ring
 */
function computeCombMetrics(ring: Float32Array): { unique_x_ratio: number; unique_y_ratio: number } {
  const uniqueX = new Set<number>();
  const uniqueY = new Set<number>();
  const vertexCount = ring.length / 2;
  
  for (let i = 0; i < ring.length; i += 2) {
    uniqueX.add(ring[i]);
    uniqueY.add(ring[i + 1]);
  }
  
  return {
    unique_x_ratio: uniqueX.size / vertexCount,
    unique_y_ratio: uniqueY.size / vertexCount
  };
}

/**
 * Calculate polygon area
 */
function polygonArea(ring: Float32Array): number {
  if (ring.length < 6) return 0;
  let area = 0;
  for (let i = 0; i < ring.length - 2; i += 2) {
    area += ring[i] * ring[i + 3];
    area -= ring[i + 2] * ring[i + 1];
  }
  const x1 = ring[ring.length - 2];
  const y1 = ring[ring.length - 1];
  const x2 = ring[0];
  const y2 = ring[1];
  area += x1 * y2;
  area -= x2 * y1;
  return Math.abs(area) / 2;
}

/**
 * Calculate bbox for ring
 */
function ringBbox(ring: Float32Array): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxX = Math.max(maxX, ring[i]);
    maxY = Math.max(maxY, ring[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Calculate percentile
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.floor(sorted.length * p);
  return sorted[Math.min(index, sorted.length - 1)];
}

async function main(): Promise<void> {
  console.log('Map v2 Build: Processing geometry from master_municipalities.json + settlements_pack\n');

  // Create output directory
  await mkdir(DERIVED_DIR, { recursive: true });

  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  console.log(`  Loaded ${masterData.municipalities.length} municipalities`);

  // Find JS files
  console.log('Finding JS files...');
  const jsFilePaths = await findJSFiles(CACHE_DIR);
  const jsFiles = new Map<string, string>();
  for (const fullPath of jsFilePaths) {
    const filename = basename(fullPath);
    jsFiles.set(filename, fullPath);
  }
  console.log(`  Found ${jsFiles.size} JS files`);

  // Process municipalities
  const municipalitiesMeta: MunicipalityMeta[] = [];
  const settlementsMeta: SettlementMeta[] = [];
  const settlementsFeatures: Array<{ type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'Polygon'; coordinates: number[][][] } }> = [];
  const municipalityOutlines: Array<{ type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'Polygon'; coordinates: number[][][] } }> = [];

  // Sanity tracking
  let totalSettlements = 0;
  let settlementsJoined = 0;
  let settlementsWithGeometry = 0;
  const droppedByReason: Record<string, number> = {};
  let settlementsWithTransform = 0;
  let settlementsWithoutTransform = 0;
  let unsupportedTransformCount = 0;
  let suspectCombCount = 0;
  
  const allBboxWidths: number[] = [];
  const allBboxHeights: number[] = [];
  let globalMinX = Infinity, globalMinY = Infinity, globalMaxX = -Infinity, globalMaxY = -Infinity;

  console.log('\nProcessing municipalities...');

  for (const muni of masterData.municipalities) {
    const mid = muni.id;
    totalSettlements += muni.settlements.length;

    // Find JS file
    const jsFilePath = await findJSFileForMunicipality(muni, jsFiles);
    if (!jsFilePath) {
      // No JS file - all settlements get null geometry
      for (const sett of muni.settlements) {
          settlementsMeta.push({
            sid: sett.settlement_id,
            mid,
            name: sett.name,
            settlement_type: sett.settlement_type || "",
            is_urban_center: sett.is_urban_center || false,
            is_municipality_capital: sett.is_municipality_capital || false,
            total_population: sett.total_population,
            bosniaks: sett.bosniaks ?? 0,
            croats: sett.croats ?? 0,
            serbs: sett.serbs ?? 0,
            others: sett.others ?? 0,
            has_geometry: false,
            drop_reason: "no_js_file"
          });
        droppedByReason["no_js_file"] = (droppedByReason["no_js_file"] || 0) + 1;
      }
      municipalitiesMeta.push({
        mid,
        name: muni.name,
        capital_sid: muni.capital_sid,
        totals_by_group: muni.totals,
        total_settlements: muni.settlements.length,
        settlements_with_geometry: 0
      });
      continue;
    }

    // Extract paths from JS file
    const jsContent = await readFile(jsFilePath, 'utf8');
    const extractedPaths = extractPathsFromJS(jsContent);

    // Sort settlements by sid
    const sortedSettlements = [...muni.settlements].sort((a, b) => 
      parseInt(a.settlement_id) - parseInt(b.settlement_id)
    );

    // Join paths to settlements (strict count equality)
    let muniSettlementsWithGeometry = 0;
    const muniSettlementRings: Array<{ sid: string; ring: Float32Array; method: string; hullRatio: number | null }> = [];

    if (extractedPaths.length === sortedSettlements.length) {
      settlementsJoined += sortedSettlements.length;
      
      for (let i = 0; i < sortedSettlements.length; i++) {
        const sett = sortedSettlements[i];
        const extracted = extractedPaths[i];
        
        // Track transform usage
        if (extracted.hasUnsupportedTransform) {
          unsupportedTransformCount++;
          settlementsMeta.push({
            sid: sett.settlement_id,
            mid,
            name: sett.name,
            settlement_type: sett.settlement_type || "",
            is_urban_center: sett.is_urban_center || false,
            is_municipality_capital: sett.is_municipality_capital || false,
            total_population: sett.total_population,
            bosniaks: sett.bosniaks ?? 0,
            croats: sett.croats ?? 0,
            serbs: sett.serbs ?? 0,
            others: sett.others ?? 0,
            has_geometry: false,
            drop_reason: "unsupported_transform"
          });
          droppedByReason["unsupported_transform"] = (droppedByReason["unsupported_transform"] || 0) + 1;
          continue;
        }
        
        if (extracted.transform) {
          settlementsWithTransform++;
        } else {
          settlementsWithoutTransform++;
        }

        // Process geometry
        const ringResult = chooseSettlementRing(extracted.pathString);
        
        if (ringResult.ring) {
          // Apply transform if present
          let finalRing = ringResult.ring;
          if (extracted.transform) {
            finalRing = applyTransformToRing(finalRing, extracted.transform);
          }
          
          // Check comb detector
          const combMetrics = computeCombMetrics(finalRing);
          if (combMetrics.unique_x_ratio < 0.05 || combMetrics.unique_y_ratio < 0.05) {
            suspectCombCount++;
          }
          
          // Update global bounds
          const bbox = ringBbox(finalRing);
          globalMinX = Math.min(globalMinX, bbox[0]);
          globalMinY = Math.min(globalMinY, bbox[1]);
          globalMaxX = Math.max(globalMaxX, bbox[2]);
          globalMaxY = Math.max(globalMaxY, bbox[3]);
          
          allBboxWidths.push(bbox[2] - bbox[0]);
          allBboxHeights.push(bbox[3] - bbox[1]);
          
          muniSettlementsWithGeometry++;
          settlementsWithGeometry++;
          
          muniSettlementRings.push({
            sid: sett.settlement_id,
            ring: finalRing,
            method: ringResult.salvage_used || "ring",
            hullRatio: ringResult.hull_inflation_ratio
          });
          
          settlementsMeta.push({
            sid: sett.settlement_id,
            mid,
            name: sett.name,
            settlement_type: sett.settlement_type || "",
            is_urban_center: sett.is_urban_center || false,
            is_municipality_capital: sett.is_municipality_capital || false,
            total_population: sett.total_population,
            bosniaks: sett.bosniaks ?? 0,
            croats: sett.croats ?? 0,
            serbs: sett.serbs ?? 0,
            others: sett.others ?? 0,
            has_geometry: true,
            geometry_method: ringResult.salvage_used || "ring",
            hull_inflation_ratio: ringResult.hull_inflation_ratio
          });
        } else {
          const reason = ringResult.drop_reason || "unknown";
          settlementsMeta.push({
            sid: sett.settlement_id,
            mid,
            name: sett.name,
            settlement_type: sett.settlement_type || "",
            is_urban_center: sett.is_urban_center || false,
            is_municipality_capital: sett.is_municipality_capital || false,
            total_population: sett.total_population,
            bosniaks: sett.bosniaks ?? 0,
            croats: sett.croats ?? 0,
            serbs: sett.serbs ?? 0,
            others: sett.others ?? 0,
            has_geometry: false,
            drop_reason: reason
          });
          droppedByReason[reason] = (droppedByReason[reason] || 0) + 1;
        }
      }
    } else {
      // Count mismatch - don't join
      for (const sett of sortedSettlements) {
        settlementsMeta.push({
          sid: sett.settlement_id,
          mid,
          name: sett.name,
          settlement_type: sett.settlement_type || "",
          is_urban_center: sett.is_urban_center || false,
          is_municipality_capital: sett.is_municipality_capital || false,
          total_population: sett.total_population,
          bosniaks: sett.bosniaks ?? 0,
          croats: sett.croats ?? 0,
          serbs: sett.serbs ?? 0,
          others: sett.others ?? 0,
          has_geometry: false,
          drop_reason: "count_mismatch"
        });
        droppedByReason["count_mismatch"] = (droppedByReason["count_mismatch"] || 0) + 1;
      }
    }

    municipalitiesMeta.push({
      mid,
      name: muni.name,
      capital_sid: muni.capital_sid || null,
      totals_by_group: {
        bosniaks: muni.total_bosniaks || 0,
        croats: muni.total_croats || 0,
        serbs: muni.total_serbs || 0,
        others: muni.total_others || 0
      },
      total_settlements: muni.settlements.length,
      settlements_with_geometry: muniSettlementsWithGeometry
    });

    // Store rings for later normalization
    for (const { sid, ring, method, hullRatio } of muniSettlementRings) {
      settlementsFeatures.push({
        type: 'Feature',
        properties: { sid, mid, geometry_method: method, hull_inflation_ratio: hullRatio },
        geometry: {
          type: 'Polygon',
          coordinates: [ringToCoords(ring)]
        }
      });
    }
  }

  // Normalize coordinates (translate to 0,0)
  const offsetX = globalMinX;
  const offsetY = globalMinY;
  
  console.log('\nNormalizing coordinates...');
  console.log(`  Global bounds: [${globalMinX.toFixed(2)}, ${globalMinY.toFixed(2)}] to [${globalMaxX.toFixed(2)}, ${globalMaxY.toFixed(2)}]`);
  console.log(`  Offset: [${offsetX.toFixed(2)}, ${offsetY.toFixed(2)}]`);

  const normalizedFeatures = settlementsFeatures.map(f => {
    const coords = f.geometry.coordinates[0].map(([x, y]) => [x - offsetX, y - offsetY]);
    return {
      ...f,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [coords]
      }
    };
  });

  // Compute municipality outlines (convex hull of all settlements per municipality)
  console.log('\nComputing municipality outlines...');
  const muniRings = new Map<string, Float32Array[]>();
  for (const f of normalizedFeatures) {
    const mid = f.properties.mid as string;
    const coords = f.geometry.coordinates[0];
    const ring = new Float32Array(coords.flat());
    if (!muniRings.has(mid)) {
      muniRings.set(mid, []);
    }
    muniRings.get(mid)!.push(ring);
  }

  // Compute convex hull for each municipality
  for (const [mid, rings] of muniRings.entries()) {
    // Collect all points from all rings
    const allPoints: Array<[number, number]> = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        allPoints.push([ring[i], ring[i + 1]]);
      }
    }
    
    if (allPoints.length < 3) continue;
    
    // Simple convex hull (monotonic chain)
    allPoints.sort((a, b) => {
      if (a[0] !== b[0]) return a[0] - b[0];
      return a[1] - b[1];
    });
    
    const cross = (o: [number, number], a: [number, number], b: [number, number]): number => {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    
    const lower: Array<[number, number]> = [];
    for (let i = 0; i < allPoints.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], allPoints[i]) <= 0) {
        lower.pop();
      }
      lower.push(allPoints[i]);
    }
    
    const upper: Array<[number, number]> = [];
    for (let i = allPoints.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], allPoints[i]) <= 0) {
        upper.pop();
      }
      upper.push(allPoints[i]);
    }
    
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    
    if (hull.length >= 3) {
      const hullCoords = hull.map(([x, y]) => [x, y]);
      hullCoords.push(hullCoords[0]); // Close
      
      municipalityOutlines.push({
        type: 'Feature',
        properties: { mid },
        geometry: {
          type: 'Polygon',
          coordinates: [hullCoords]
        }
      });
    }
  }

  // Compute geometry sanity
  allBboxWidths.sort((a, b) => a - b);
  allBboxHeights.sort((a, b) => a - b);
  
  const geometrySanity: GeometrySanity = {
    total_settlements: totalSettlements,
    settlements_joined: settlementsJoined,
    settlements_with_geometry: settlementsWithGeometry,
    dropped_by_reason: droppedByReason,
    transform_usage: {
      settlements_with_transform: settlementsWithTransform,
      settlements_without_transform: settlementsWithoutTransform,
      unsupported_transform_count: unsupportedTransformCount
    },
    coordinate_stats: {
      global_min_x: globalMinX - offsetX,
      global_min_y: globalMinY - offsetY,
      global_max_x: globalMaxX - offsetX,
      global_max_y: globalMaxY - offsetY,
      max_abs_coord: Math.max(Math.abs(globalMaxX - offsetX), Math.abs(globalMaxY - offsetY)),
      bbox_width_percentiles: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99].map(p => percentile(allBboxWidths, p)),
      bbox_height_percentiles: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99].map(p => percentile(allBboxHeights, p))
    },
    comb_detector: {
      suspect_comb_count: suspectCombCount,
      suspect_comb_percent: totalSettlements > 0 ? (suspectCombCount / totalSettlements) * 100 : 0
    }
  };

  // Check for comb artifact
  if (geometrySanity.comb_detector.suspect_comb_percent > 5) {
    appendMistake({
      title: "Comb-like rings indicate transform or path parsing bug",
      mistake: "Generated rings where most vertices share the same x or y, producing \"comb/rectangle\" artifacts.",
      correctRule: "Track unique_x_ratio/unique_y_ratio, verify transform application, and treat widespread comb patterns as a build-time failure."
    });
  }

  // Write outputs
  console.log('\nWriting outputs...');

  await writeFile(
    resolve(DERIVED_DIR, 'municipalities_meta.json'),
    JSON.stringify(municipalitiesMeta, null, 2),
    'utf8'
  );

  await writeFile(
    resolve(DERIVED_DIR, 'settlements_meta.json'),
    JSON.stringify(settlementsMeta, null, 2),
    'utf8'
  );

  await writeFile(
    resolve(DERIVED_DIR, 'settlements_polygons.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: normalizedFeatures
    }, null, 2),
    'utf8'
  );

  await writeFile(
    resolve(DERIVED_DIR, 'municipality_outlines.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: municipalityOutlines
    }, null, 2),
    'utf8'
  );

  const mapBounds: MapBounds = {
    min_x: globalMinX - offsetX,
    min_y: globalMinY - offsetY,
    max_x: globalMaxX - offsetX,
    max_y: globalMaxY - offsetY,
    width: (globalMaxX - offsetX) - (globalMinX - offsetX),
    height: (globalMaxY - offsetY) - (globalMinY - offsetY)
  };

  await writeFile(
    resolve(DERIVED_DIR, 'map_bounds.json'),
    JSON.stringify(mapBounds, null, 2),
    'utf8'
  );

  await writeFile(
    resolve(DERIVED_DIR, 'geometry_sanity.json'),
    JSON.stringify(geometrySanity, null, 2),
    'utf8'
  );

  // Print summary
  console.log('\nBuild complete!');
  console.log(`  Total settlements: ${totalSettlements}`);
  console.log(`  Settlements joined: ${settlementsJoined}`);
  console.log(`  Settlements with geometry: ${settlementsWithGeometry}`);
  console.log(`  Transform usage: ${settlementsWithTransform} with, ${settlementsWithoutTransform} without`);
  console.log(`  Unsupported transforms: ${unsupportedTransformCount}`);
  console.log(`  Suspect comb count: ${suspectCombCount} (${geometrySanity.comb_detector.suspect_comb_percent.toFixed(2)}%)`);
  console.log(`  Dropped by reason:`, droppedByReason);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
