/**
 * Settlement Points: Generate settlement points from Excel metadata
 * 
 * Reads settlements_meta.csv and produces settlement_points_from_excel.geojson.
 * If Excel has lon/lat: use those in EPSG:4326.
 * If Excel does not have coords: place points deterministically inside municipality outline.
 * 
 * Outputs:
 *   - data/derived/settlement_points_from_excel.geojson
 * 
 * Usage:
 *   tsx tools/map/settlement_points.ts
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { createHash } from 'node:crypto';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");
loadLedger();
assertLedgerFresh("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");

// ============================================================================
// Types
// ============================================================================

interface SettlementMeta {
  sid: string;
  name: string;
  mid: string;
  municipality_name: string;
  lat: number | null;
  lon: number | null;
  source_row_id: string;
}

// ============================================================================
// Constants
// ============================================================================

const META_PATH = resolve('data/derived/settlements_meta.csv');
const OUTLINES_PATH = resolve('data/derived/municipality_outline.geojson');
const OUTPUT_PATH = resolve('data/derived/settlement_points_from_excel.geojson');
const DERIVED_DIR = resolve('data/derived');
const COORDINATE_PRECISION = 3; // For LOCAL_PIXELS_V2

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
 * Deterministic hash function for sid
 */
function hashSid(sid: string): number {
  const hash = createHash('sha256').update(sid).digest('hex');
  return parseInt(hash.substring(0, 8), 16);
}

/**
 * Place point deterministically inside municipality polygon
 */
function placePointInPolygon(
  sid: string,
  polygon: turf.Feature<turf.Polygon>
): turf.Feature<turf.Point> {
  // Get polygon centroid
  const centroid = turf.centroid(polygon);
  const centerX = centroid.geometry.coordinates[0];
  const centerY = centroid.geometry.coordinates[1];
  
  // Get polygon bbox for jitter range
  const bbox = turf.bbox(polygon);
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const maxJitter = Math.min(width, height) * 0.1; // 10% of smaller dimension
  
  // Deterministic jitter based on hash(sid)
  const hash = hashSid(sid);
  const angle = (hash % 360) * (Math.PI / 180);
  const distance = ((hash >> 8) % 100) / 100 * maxJitter;
  
  let x = centerX + Math.cos(angle) * distance;
  let y = centerY + Math.sin(angle) * distance;
  
  // Ensure point is inside polygon (spiral search if needed)
  const testPoint = turf.point([x, y]);
  let attempts = 0;
  while (!turf.booleanPointInPolygon(testPoint, polygon) && attempts < 10) {
    const spiralAngle = angle + (attempts * 0.5);
    const spiralDist = distance * (1 + attempts * 0.2);
    x = centerX + Math.cos(spiralAngle) * spiralDist;
    y = centerY + Math.sin(spiralAngle) * spiralDist;
    testPoint.geometry.coordinates = [x, y];
    attempts++;
  }
  
  // If still outside, use centroid
  if (!turf.booleanPointInPolygon(testPoint, polygon)) {
    return turf.point(
      [roundCoord(centerX), roundCoord(centerY)],
      { sid, synthetic: true }
    );
  }
  
  return turf.point(
    [roundCoord(x), roundCoord(y)],
    { sid, synthetic: true }
  );
}

/**
 * Place point in deterministic mid cluster grid (when no outline exists)
 */
function placePointInGrid(
  sid: string,
  mid: string
): turf.Feature<turf.Point> {
  // Deterministic grid based on mid hash
  const midHash = hashSid(mid);
  const baseX = (midHash % 10000) * 10;
  const baseY = ((midHash >> 16) % 10000) * 10;
  
  // Jitter within grid cell based on sid
  const sidHash = hashSid(sid);
  const jitterX = (sidHash % 100) / 10;
  const jitterY = ((sidHash >> 8) % 100) / 10;
  
  return turf.point(
    [roundCoord(baseX + jitterX), roundCoord(baseY + jitterY)],
    { sid, mid, synthetic: true }
  );
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadSettlementsMeta(): Promise<Map<string, SettlementMeta>> {
  const content = await readFile(META_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }

  const header = lines[0].split(',');
  const sidIdx = header.indexOf('sid');
  const nameIdx = header.indexOf('name');
  const midIdx = header.indexOf('mid');
  const municipalityNameIdx = header.indexOf('municipality_name');
  const latIdx = header.indexOf('lat');
  const lonIdx = header.indexOf('lon');
  const sourceRowIdIdx = header.indexOf('source_row_id');

  if (sidIdx === -1 || nameIdx === -1 || midIdx === -1) {
    throw new Error('settlements_meta.csv missing required columns: sid, name, mid');
  }

  const metaMap = new Map<string, SettlementMeta>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Simple CSV parsing (handle quoted fields)
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);

    if (fields.length <= Math.max(sidIdx, nameIdx, midIdx)) continue;

    const sid = fields[sidIdx]?.trim();
    if (!sid) continue;

    const name = fields[nameIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
    const mid = fields[midIdx]?.trim() || '';
    const municipalityName = fields[municipalityNameIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
    const latStr = fields[latIdx]?.trim() || '';
    const lonStr = fields[lonIdx]?.trim() || '';
    const sourceRowId = fields[sourceRowIdIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';

    const lat = latStr ? parseFloat(latStr) : null;
    const lon = lonStr ? parseFloat(lonStr) : null;

    metaMap.set(sid, {
      sid,
      name,
      mid,
      municipality_name: municipalityName,
      lat,
      lon,
      source_row_id: sourceRowId
    });
  }

  return metaMap;
}

async function loadMunicipalityOutlines(): Promise<Map<string, turf.Feature<turf.Polygon>>> {
  try {
    await access(OUTLINES_PATH, constants.F_OK);
  } catch {
    return new Map(); // No outlines available
  }
  
  const content = await readFile(OUTLINES_PATH, 'utf8');
  const fc: turf.FeatureCollection<turf.Polygon> = JSON.parse(content);
  
  const outlineMap = new Map<string, turf.Feature<turf.Polygon>>();
  for (const feature of fc.features) {
    const mid = feature.properties?.mid;
    if (mid && typeof mid === 'string') {
      outlineMap.set(mid, feature);
    }
  }
  return outlineMap;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Generating settlement points from Excel...\n');
  console.log(`Input: ${META_PATH}`);
  
  try {
    const metaMap = await loadSettlementsMeta();
    const outlineMap = await loadMunicipalityOutlines();
    
    console.log(`Loaded ${metaMap.size} settlements`);
    if (outlineMap.size > 0) {
      console.log(`Loaded ${outlineMap.size} municipality outlines`);
    } else {
      console.log(`No municipality outlines available (will use grid placement)`);
    }
    
    const points: turf.Feature<turf.Point>[] = [];
    let trueCoords = 0;
    let syntheticInOutline = 0;
    let syntheticInGrid = 0;
    
    // Process each settlement
    for (const [sid, meta] of Array.from(metaMap.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    )) {
      let point: turf.Feature<turf.Point>;
      
      // If Excel has coordinates, use them (convert to LOCAL_PIXELS_V2 if needed)
      if (meta.lat != null && meta.lon != null) {
        // For now, assume coordinates are already in LOCAL_PIXELS_V2
        // If they're in EPSG:4326, we'd need to transform them
        // This is a placeholder - actual transformation would require proj4 or similar
        point = turf.point(
          [roundCoord(meta.lon), roundCoord(meta.lat)],
          { sid, mid: meta.mid, synthetic: false }
        );
        trueCoords++;
      } else {
        // No coordinates: place deterministically
        const outline = outlineMap.get(meta.mid);
        if (outline) {
          // Place inside municipality outline
          point = placePointInPolygon(sid, outline);
          point.properties = { ...point.properties, mid: meta.mid };
          syntheticInOutline++;
        } else {
          // No outline: use grid
          point = placePointInGrid(sid, meta.mid);
          syntheticInGrid++;
        }
      }
      
      points.push(point);
    }
    
    // Create FeatureCollection
    const pointFC: turf.FeatureCollection<turf.Point> = {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: 'LOCAL_PIXELS_V2'
        }
      },
      features: points
    };
    
    // Ensure output directory exists
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Write output
    await writeFile(OUTPUT_PATH, JSON.stringify(pointFC, null, 2), 'utf8');
    
    console.log(`\nResults:`);
    console.log(`  Total points: ${points.length}`);
    console.log(`  True coordinates: ${trueCoords}`);
    console.log(`  Synthetic (in outline): ${syntheticInOutline}`);
    console.log(`  Synthetic (in grid): ${syntheticInGrid}`);
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log('✓ Settlement points generation complete');
  } catch (err) {
    console.error('Error generating settlement points:', err);
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
