/**
 * Re-key Geometry: Re-key geometry artifacts to canonical Excel settlement IDs
 * 
 * Reads the crosswalk and re-keys polygon and point features to use canonical
 * Excel settlement IDs (sid_excel) instead of HTML IDs.
 * 
 * Outputs:
 *   - data/derived/settlement_polygons_rekeyed.geojson
 *   - data/derived/settlement_points_rekeyed.geojson
 *   - data/derived/join_stats.json
 * 
 * Usage:
 *   tsx tools/map/rekey_geometry.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: crosswalk excel settlement ids to svg polygons, rekey geojson, build inspector html");
loadLedger();
assertLedgerFresh("map rebuild: crosswalk excel settlement ids to svg polygons, rekey geojson, build inspector html");

// ============================================================================
// Types
// ============================================================================

interface CrosswalkEntry {
  sid_excel: string;
  mid: string;
  sid_html: string;
}

interface JoinStats {
  polygons_total: number;
  polygons_matched: number;
  polygons_unmatched: number;
  meta_total: number;
  meta_matched: number;
  meta_without_polygons: number;
}

// ============================================================================
// Constants
// ============================================================================

const CROSSWALK_PATH = resolve('data/derived/sid_crosswalk.csv');
const POLYGONS_INPUT_PATH = resolve('data/derived/settlement_polygons.geojson');
const POINTS_INPUT_PATH = resolve('data/derived/settlement_points.geojson');
const META_PATH = resolve('data/derived/settlements_meta.csv');
const POLYGONS_OUTPUT_PATH = resolve('data/derived/settlement_polygons_rekeyed.geojson');
const POINTS_OUTPUT_PATH = resolve('data/derived/settlement_points_rekeyed.geojson');
const JOIN_STATS_PATH = resolve('data/derived/join_stats.json');
const DERIVED_DIR = resolve('data/derived');

const COORDINATE_PRECISION = 3; // LOCAL_PIXELS_V2: 3 decimals

// ============================================================================
// Utilities
// ============================================================================

/**
 * Round coordinate to fixed precision
 */
function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

/**
 * Round all coordinates in a feature
 */
function roundFeatureCoords<T extends turf.Feature>(feature: T): T {
  if (feature.geometry.type === 'Point') {
    const coords = feature.geometry.coordinates;
    return {
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates: [roundCoord(coords[0]), roundCoord(coords[1])]
      }
    } as T;
  } else if (feature.geometry.type === 'Polygon') {
    return {
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates: feature.geometry.coordinates.map(ring =>
          ring.map(coord => [roundCoord(coord[0]), roundCoord(coord[1])])
        )
      }
    } as T;
  }
  return feature;
}

/**
 * Parse CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  
  return fields;
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadCrosswalk(): Promise<Map<string, CrosswalkEntry>> {
  try {
    const content = await readFile(CROSSWALK_PATH, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    if (lines.length < 2) {
      // Empty crosswalk (no matches) - return empty map
      console.warn('Warning: Crosswalk file is empty or has no matches. All polygons will be marked as unmatched.');
      return new Map();
    }
    
    const header = parseCSVLine(lines[0]);
    const sidExcelIdx = header.indexOf('sid_excel');
    const midIdx = header.indexOf('mid');
    const sidHtmlIdx = header.indexOf('sid_html');
    
    if (sidExcelIdx === -1 || midIdx === -1 || sidHtmlIdx === -1) {
      throw new Error('sid_crosswalk.csv missing required columns: sid_excel, mid, sid_html');
    }
    
    const crosswalk = new Map<string, CrosswalkEntry>();
    
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      
      if (fields.length <= Math.max(sidExcelIdx, midIdx, sidHtmlIdx)) continue;
      
      const sidHtml = fields[sidHtmlIdx]?.trim();
      const sidExcel = fields[sidExcelIdx]?.trim();
      const mid = fields[midIdx]?.trim();
      
      if (!sidHtml || !sidExcel || !mid) continue;
      
      crosswalk.set(sidHtml, {
        sid_excel: sidExcel,
        mid,
        sid_html: sidHtml
      });
    }
    
    return crosswalk;
  } catch (err) {
    // File doesn't exist or can't be read - return empty map
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      console.warn('Warning: Crosswalk file not found. All polygons will be marked as unmatched.');
      return new Map();
    }
    throw err;
  }
}

async function loadMetaSids(): Promise<Set<string>> {
  const content = await readFile(META_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    return new Set();
  }
  
  const header = parseCSVLine(lines[0]);
  const sidIdx = header.indexOf('sid');
  
  if (sidIdx === -1) {
    return new Set();
  }
  
  const sids = new Set<string>();
  
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length > sidIdx) {
      const sid = fields[sidIdx]?.trim();
      if (sid) {
        sids.add(sid);
      }
    }
  }
  
  return sids;
}

// ============================================================================
// Re-keying
// ============================================================================

async function rekeyGeometry(): Promise<JoinStats> {
  const crosswalk = await loadCrosswalk();
  const metaSids = await loadMetaSids();
  
  console.log(`Loaded crosswalk with ${crosswalk.size} mappings`);
  console.log(`Loaded ${metaSids.size} Excel settlement IDs\n`);
  
  // Load polygons and points
  const polygonsContent = await readFile(POLYGONS_INPUT_PATH, 'utf8');
  const pointsContent = await readFile(POINTS_INPUT_PATH, 'utf8');
  
  const polygonFC: turf.FeatureCollection<turf.Polygon> = JSON.parse(polygonsContent);
  const pointFC: turf.FeatureCollection<turf.Point> = JSON.parse(pointsContent);
  
  console.log(`Loaded ${polygonFC.features.length} polygons`);
  console.log(`Loaded ${pointFC.features.length} points\n`);
  
  // Re-key polygons
  const rekeyedPolygons: turf.Feature<turf.Polygon>[] = [];
  let polygonsMatched = 0;
  let polygonsUnmatched = 0;
  
  for (const feature of polygonFC.features) {
    const originalSid = feature.properties?.sid || feature.properties?.id;
    const sidStr = originalSid ? String(originalSid) : null;
    
    if (!sidStr) {
      // No ID, skip
      continue;
    }
    
    const crosswalkEntry = crosswalk.get(sidStr);
    
    if (crosswalkEntry) {
      // Matched: use canonical Excel sid
      const rekeyed = roundFeatureCoords({
        ...feature,
        properties: {
          ...feature.properties,
          sid: crosswalkEntry.sid_excel,
          sid_html: sidStr,
          mid: crosswalkEntry.mid,
          unmatched: false
        }
      });
      
      // Safety check: ensure no ∑ in properties
      const propsStr = JSON.stringify(rekeyed.properties);
      if (propsStr.includes('∑')) {
        throw new Error(`Aggregate symbol (∑) detected in rekeyed polygon properties for sid ${crosswalkEntry.sid_excel}`);
      }
      
      rekeyedPolygons.push(rekeyed);
      polygonsMatched++;
    } else {
      // Unmatched: keep but mark
      const rekeyed = roundFeatureCoords({
        ...feature,
        properties: {
          ...feature.properties,
          sid_html: sidStr,
          unmatched: true
        }
      });
      
      // Safety check
      const propsStr = JSON.stringify(rekeyed.properties);
      if (propsStr.includes('∑')) {
        throw new Error(`Aggregate symbol (∑) detected in unmatched polygon properties for sid_html ${sidStr}`);
      }
      
      rekeyedPolygons.push(rekeyed);
      polygonsUnmatched++;
    }
  }
  
  // Re-key points
  const rekeyedPoints: turf.Feature<turf.Point>[] = [];
  
  for (const feature of pointFC.features) {
    const originalSid = feature.properties?.sid || feature.properties?.id;
    const sidStr = originalSid ? String(originalSid) : null;
    
    if (!sidStr) {
      continue;
    }
    
    const crosswalkEntry = crosswalk.get(sidStr);
    
    if (crosswalkEntry) {
      const rekeyed = roundFeatureCoords({
        ...feature,
        properties: {
          ...feature.properties,
          sid: crosswalkEntry.sid_excel,
          sid_html: sidStr,
          mid: crosswalkEntry.mid,
          unmatched: false
        }
      });
      
      const propsStr = JSON.stringify(rekeyed.properties);
      if (propsStr.includes('∑')) {
        throw new Error(`Aggregate symbol (∑) detected in rekeyed point properties for sid ${crosswalkEntry.sid_excel}`);
      }
      
      rekeyedPoints.push(rekeyed);
    } else {
      const rekeyed = roundFeatureCoords({
        ...feature,
        properties: {
          ...feature.properties,
          sid_html: sidStr,
          unmatched: true
        }
      });
      
      const propsStr = JSON.stringify(rekeyed.properties);
      if (propsStr.includes('∑')) {
        throw new Error(`Aggregate symbol (∑) detected in unmatched point properties for sid_html ${sidStr}`);
      }
      
      rekeyedPoints.push(rekeyed);
    }
  }
  
  // Sort for determinism
  rekeyedPolygons.sort((a, b) => {
    const sidA = a.properties?.sid || '';
    const sidB = b.properties?.sid || '';
    if (sidA !== sidB) return sidA.localeCompare(sidB);
    const sidHtmlA = String(a.properties?.sid_html || '');
    const sidHtmlB = String(b.properties?.sid_html || '');
    return sidHtmlA.localeCompare(sidHtmlB);
  });
  
  rekeyedPoints.sort((a, b) => {
    const sidA = a.properties?.sid || '';
    const sidB = b.properties?.sid || '';
    if (sidA !== sidB) return sidA.localeCompare(sidB);
    const sidHtmlA = String(a.properties?.sid_html || '');
    const sidHtmlB = String(b.properties?.sid_html || '');
    return sidHtmlA.localeCompare(sidHtmlB);
  });
  
  // Calculate stats
  const matchedExcelSids = new Set<string>();
  for (const entry of crosswalk.values()) {
    matchedExcelSids.add(entry.sid_excel);
  }
  
  const metaWithPolygons = new Set<string>();
  for (const polygon of rekeyedPolygons) {
    const sid = polygon.properties?.sid;
    if (sid && typeof sid === 'string' && !polygon.properties?.unmatched) {
      metaWithPolygons.add(sid);
    }
  }
  
  const metaWithoutPolygons = Array.from(metaSids).filter(sid => !metaWithPolygons.has(sid)).length;
  
  const stats: JoinStats = {
    polygons_total: rekeyedPolygons.length,
    polygons_matched: polygonsMatched,
    polygons_unmatched: polygonsUnmatched,
    meta_total: metaSids.size,
    meta_matched: matchedExcelSids.size,
    meta_without_polygons: metaWithoutPolygons
  };
  
  // Create FeatureCollections with canonical JSON key order
  const polygonFCRekeyed: turf.FeatureCollection<turf.Polygon> = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: {
        name: 'LOCAL_PIXELS_V2'
      }
    },
    features: rekeyedPolygons
  };
  
  const pointFCRekeyed: turf.FeatureCollection<turf.Point> = {
    type: 'FeatureCollection',
    features: rekeyedPoints
  };
  
  // Write outputs
  await writeFile(POLYGONS_OUTPUT_PATH, JSON.stringify(polygonFCRekeyed, null, 2), 'utf8');
  await writeFile(POINTS_OUTPUT_PATH, JSON.stringify(pointFCRekeyed, null, 2), 'utf8');
  await writeFile(JOIN_STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
  
  return stats;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Re-keying geometry to canonical Excel settlement IDs...\n');
  
  try {
    await mkdir(DERIVED_DIR, { recursive: true });
    
    const stats = await rekeyGeometry();
    
    console.log('\nResults:');
    console.log(`  Polygons total: ${stats.polygons_total}`);
    console.log(`  Polygons matched: ${stats.polygons_matched}`);
    console.log(`  Polygons unmatched: ${stats.polygons_unmatched}`);
    console.log(`  Meta total: ${stats.meta_total}`);
    console.log(`  Meta matched: ${stats.meta_matched}`);
    console.log(`  Meta without polygons: ${stats.meta_without_polygons}`);
    console.log(`\nOutput:`);
    console.log(`  Polygons: ${POLYGONS_OUTPUT_PATH}`);
    console.log(`  Points: ${POINTS_OUTPUT_PATH}`);
    console.log(`  Join stats: ${JOIN_STATS_PATH}`);
    console.log('✓ Geometry re-keying complete');
  } catch (err) {
    console.error('Error re-keying geometry:', err);
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) {
        console.error(err.stack);
      }
    }
    process.exit(1);
  }
}

main();
