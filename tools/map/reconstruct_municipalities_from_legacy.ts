/**
 * Reconstruct Municipality Borders from Legacy Settlement-Derived Outlines
 *
 * Loads municipality outlines from the legacy ZIP file and creates a complete
 * municipality border GeoJSON layer. This is an approved reconstruction step.
 *
 * Inputs:
 *   - data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.zip
 *   - data/derived/settlements_meta.csv (for municipality IDs and names)
 *
 * Outputs:
 *   - data/derived/municipality_borders_reconstructed.geojson
 *   - data/derived/municipality_reconstruction_report.json
 *
 * Usage:
 *   tsx tools/map/reconstruct_municipalities_from_legacy.ts
 *   npm run map:reconstruct:muni
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import AdmZip from 'adm-zip';
import parseSVG from 'svg-path-parser';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Reconstruct municipality borders from settlement-derived outlines under amended rules");
loadLedger();
assertLedgerFresh("Reconstruct municipality borders from settlement-derived outlines under amended rules");

// ============================================================================
// Types
// ============================================================================

interface ReconstructionReport {
  total_municipalities: number;
  reconstructed: number;
  geometry_fixes_applied: {
    ring_closure: number;
    fragment_union: number;
  };
  unresolved_id_count: number;
  unresolved_ids: string[];
  notes: string[];
}

interface MunicipalityLookup {
  munid_5: string;
  name: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const ZIP_PATH = resolve('data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.zip');
const META_PATH = resolve('data/derived/settlements_meta.csv');
const OUTPUT_GEOJSON = resolve('data/derived/municipality_borders_reconstructed.geojson');
const OUTPUT_REPORT = resolve('data/derived/municipality_reconstruction_report.json');
const COORDINATE_PRECISION = 3; // LOCAL_PIXELS_V2

// ============================================================================
// Municipality ID Lookup Table
// ============================================================================

/**
 * Explicit lookup table for municipalities where legacy outline lacks munid_5.
 * This is authored in-code for this script.
 */
const MUNICIPALITY_ID_LOOKUP: Record<string, string> = {
  // Add entries here if needed when legacy outlines lack munid_5
  // Format: "municipality_name": "munid_5"
};

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
 * Round all coordinates in a geometry
 */
function roundGeometry(geom: turf.Polygon | turf.MultiPolygon): turf.Polygon | turf.MultiPolygon {
  if (geom.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geom.coordinates.map(ring =>
        ring.map(coord => [roundCoord(coord[0]), roundCoord(coord[1])])
      )
    };
  } else {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map(poly =>
        poly.map(ring =>
          ring.map(coord => [roundCoord(coord[0]), roundCoord(coord[1])])
        )
      )
    };
  }
}

/**
 * Close a ring if it's not already closed
 */
function closeRing(ring: number[][]): number[][] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring;
  }
  return [...ring, [first[0], first[1]]];
}

/**
 * Check if a ring is closed
 */
function isRingClosed(ring: number[][]): boolean {
  if (ring.length < 2) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
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
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Load municipality metadata from CSV
 */
async function loadMunicipalityMetadata(): Promise<Map<string, MunicipalityLookup>> {
  const content = await readFile(META_PATH, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }

  const header = parseCSVLine(lines[0]);
  const midIdx = header.indexOf('mid');
  const nameIdx = header.indexOf('municipality_name');
  const munid5Idx = header.indexOf('munid_5');

  if (midIdx === -1 && munid5Idx === -1) {
    throw new Error('settlements_meta.csv missing municipality ID column (mid or munid_5)');
  }

  const lookup = new Map<string, MunicipalityLookup>();

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length <= Math.max(midIdx >= 0 ? midIdx : -1, munid5Idx >= 0 ? munid5Idx : -1, nameIdx >= 0 ? nameIdx : -1)) {
      continue;
    }
    
    const mid = midIdx >= 0 ? values[midIdx] : null;
    const munid5 = munid5Idx >= 0 ? values[munid5Idx] : null;
    const name = nameIdx >= 0 ? values[nameIdx] : null;

    // Use munid_5 if available, otherwise mid
    const id = munid5 || mid;
    if (!id) continue;

    // Only add if not already present (first occurrence wins)
    if (!lookup.has(id)) {
      lookup.set(id, {
        munid_5: id,
        name: name || null
      });
    }
  }

  return lookup;
}

/**
 * Convert SVG path to polygon coordinates
 */
function svgPathToPolygon(svgPath: string): turf.Polygon | null {
  try {
    const commands = parseSVG(svgPath);
    parseSVG.makeAbsolute(commands);

    const rings: number[][][] = [];
    let currentRing: number[][] = [];
    let currentX = 0;
    let currentY = 0;

    for (const cmd of commands) {
      if (cmd.code === 'M' || cmd.code === 'm') {
        if (currentRing.length > 0) {
          // Close previous ring
          if (currentRing.length > 0 && (currentRing[0][0] !== currentRing[currentRing.length - 1][0] || currentRing[0][1] !== currentRing[currentRing.length - 1][1])) {
            currentRing.push([currentRing[0][0], currentRing[0][1]]);
          }
          rings.push(currentRing);
        }
        currentRing = [];
        currentX = cmd.x ?? 0;
        currentY = cmd.y ?? 0;
        currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
      } else if (cmd.code === 'L' || cmd.code === 'l') {
        currentX = cmd.x ?? currentX;
        currentY = cmd.y ?? currentY;
        currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
      } else if (cmd.code === 'Z' || cmd.code === 'z') {
        // Close path
        if (currentRing.length > 0 && (currentRing[0][0] !== currentRing[currentRing.length - 1][0] || currentRing[0][1] !== currentRing[currentRing.length - 1][1])) {
          currentRing.push([currentRing[0][0], currentRing[0][1]]);
        }
      } else if (cmd.code === 'C' || cmd.code === 'c') {
        // Cubic bezier - approximate with endpoint
        currentX = cmd.x ?? currentX;
        currentY = cmd.y ?? currentY;
        currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
      } else if (cmd.code === 'Q' || cmd.code === 'q') {
        // Quadratic bezier - approximate with endpoint
        currentX = cmd.x ?? currentX;
        currentY = cmd.y ?? currentY;
        currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
      }
    }

    // Close last ring
    if (currentRing.length > 0) {
      if (currentRing.length > 0 && (currentRing[0][0] !== currentRing[currentRing.length - 1][0] || currentRing[0][1] !== currentRing[currentRing.length - 1][1])) {
        currentRing.push([currentRing[0][0], currentRing[0][1]]);
      }
      rings.push(currentRing);
    }

    if (rings.length === 0 || rings[0].length < 3) {
      return null;
    }

    return {
      type: 'Polygon',
      coordinates: rings
    };
  } catch (err) {
    console.warn(`Failed to parse SVG path: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract HTML file from ZIP and parse municipality outlines
 */
function extractMunicipalityOutlinesFromZip(zip: AdmZip): Map<string, string[]> {
  // Find HTML file in ZIP
  let htmlEntry = null;
  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.html')) {
      htmlEntry = entry;
      break;
    }
  }

  if (!htmlEntry) {
    throw new Error('No HTML file found in ZIP');
  }

  const htmlContent = htmlEntry.getData().toString('utf8');
  
  // Extract MUNICIPALITY_DISSOLVED_OUTLINES constant
  const outlinesMatch = htmlContent.match(/(?:const|let|var)\s+MUNICIPALITY_DISSOLVED_OUTLINES\s*=\s*(\{[\s\S]*?\});/);
  
  if (!outlinesMatch) {
    throw new Error('Could not find MUNICIPALITY_DISSOLVED_OUTLINES constant in HTML');
  }

  const outlinesJson = outlinesMatch[1];
  let parsedOutlines: Record<string, string[]>;
  
  try {
    parsedOutlines = JSON.parse(outlinesJson);
  } catch (err) {
    throw new Error(`Failed to parse MUNICIPALITY_DISSOLVED_OUTLINES JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Convert to Map
  const outlinesMap = new Map<string, string[]>();
  for (const [munName, paths] of Object.entries(parsedOutlines)) {
    if (Array.isArray(paths)) {
      outlinesMap.set(munName, paths);
    }
  }

  return outlinesMap;
}

/**
 * Extract municipality ID from feature properties
 */
function extractMunicipalityId(feature: turf.Feature): string | null {
  const props = feature.properties || {};
  return props.munid_5 || props.munID || props.mun_id || props.mid || props.municipality_id || null;
}

/**
 * Extract municipality name from feature properties
 */
function extractMunicipalityName(feature: turf.Feature): string | null {
  const props = feature.properties || {};
  return props.name || props.municipality_name || props.municipality || null;
}

/**
 * Normalize name for matching (lowercase, remove diacritics, trim)
 */
function normalizeNameForMatching(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Union multiple geometries deterministically
 */
function unionGeometries(geometries: Array<turf.Polygon | turf.MultiPolygon>): turf.Polygon | turf.MultiPolygon | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];

  // Sort geometries by bbox for deterministic order
  const sorted = [...geometries].sort((a, b) => {
    const bboxA = turf.bbox(turf.feature(a));
    const bboxB = turf.bbox(turf.feature(b));
    if (bboxA[0] !== bboxB[0]) return bboxA[0] - bboxB[0];
    if (bboxA[1] !== bboxB[1]) return bboxA[1] - bboxB[1];
    if (bboxA[2] !== bboxB[2]) return bboxA[2] - bboxB[2];
    return bboxA[3] - bboxB[3];
  });

  let result = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    try {
      const unioned = turf.union(turf.feature(result), turf.feature(sorted[i]));
      if (unioned && unioned.geometry) {
        result = unioned.geometry as turf.Polygon | turf.MultiPolygon;
      } else {
        // If union fails, combine as MultiPolygon
        if (result.type === 'Polygon') {
          result = {
            type: 'MultiPolygon',
            coordinates: [result.coordinates, sorted[i].type === 'Polygon' ? sorted[i].coordinates : sorted[i].coordinates[0]]
          };
        } else {
          result = {
            type: 'MultiPolygon',
            coordinates: [
              ...result.coordinates,
              ...(sorted[i].type === 'Polygon' ? [sorted[i].coordinates] : sorted[i].coordinates)
            ]
          };
        }
      }
    } catch (err) {
      // Fallback: combine as MultiPolygon
      if (result.type === 'Polygon') {
        result = {
          type: 'MultiPolygon',
          coordinates: [result.coordinates, sorted[i].type === 'Polygon' ? sorted[i].coordinates : sorted[i].coordinates[0]]
        };
      } else {
        result = {
          type: 'MultiPolygon',
          coordinates: [
            ...result.coordinates,
            ...(sorted[i].type === 'Polygon' ? [sorted[i].coordinates] : sorted[i].coordinates)
          ]
        };
      }
    }
  }

  return result;
}

/**
 * Fix geometry: close rings, validate
 */
function fixGeometry(geom: turf.Polygon | turf.MultiPolygon, report: ReconstructionReport): turf.Polygon | turf.MultiPolygon | null {
  if (geom.type === 'Polygon') {
    const fixedRings = geom.coordinates.map(ring => {
      if (!isRingClosed(ring)) {
        report.geometry_fixes_applied.ring_closure++;
        return closeRing(ring);
      }
      return ring;
    });

    // Validate: check for finite coordinates
    for (const ring of fixedRings) {
      for (const coord of ring) {
        if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
          return null;
        }
      }
    }

    return {
      type: 'Polygon',
      coordinates: fixedRings
    };
  } else {
    const fixedPolygons = geom.coordinates.map(poly =>
      poly.map(ring => {
        if (!isRingClosed(ring)) {
          report.geometry_fixes_applied.ring_closure++;
          return closeRing(ring);
        }
        return ring;
      })
    );

    // Validate: check for finite coordinates
    for (const poly of fixedPolygons) {
      for (const ring of poly) {
        for (const coord of ring) {
          if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
            return null;
          }
        }
      }
    }

    return {
      type: 'MultiPolygon',
      coordinates: fixedPolygons
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Reconstructing municipality borders from legacy settlement-derived outlines...\n');

  // Load ZIP
  console.log('Loading legacy ZIP file...');
  const zip = new AdmZip(ZIP_PATH);
  const outlinesMap = extractMunicipalityOutlinesFromZip(zip);
  console.log(`Found ${outlinesMap.size} municipality outline(s) in ZIP\n`);

  if (outlinesMap.size === 0) {
    throw new Error('No municipality outlines found in ZIP');
  }

  // Load municipality metadata
  console.log('Loading municipality metadata...');
  const municipalityLookup = await loadMunicipalityMetadata();
  console.log(`Loaded ${municipalityLookup.size} municipality entries\n`);

  // Process all municipality outlines
  const municipalityFeatures = new Map<string, Array<turf.Polygon>>();
  const municipalityNames = new Map<string, string | null>();

  console.log('Processing municipality outlines...');
  for (const [munName, paths] of outlinesMap.entries()) {
    // Find munid_5 for this municipality name
    let munid_5: string | null = null;

    // Try lookup table first
    if (MUNICIPALITY_ID_LOOKUP[munName]) {
      munid_5 = MUNICIPALITY_ID_LOOKUP[munName];
    } else {
      // Try to match by name in metadata (normalized for diacritics/case)
      const normalizedMunName = normalizeNameForMatching(munName);
      for (const [id, lookup] of municipalityLookup.entries()) {
        if (lookup.name && normalizeNameForMatching(lookup.name) === normalizedMunName) {
          munid_5 = id;
          break;
        }
      }
    }

    if (!munid_5) {
      console.warn(`Skipping municipality without ID match: ${munName}`);
      continue;
    }

    // Convert SVG paths to polygons
    const polygons: turf.Polygon[] = [];
    for (const path of paths) {
      const polygon = svgPathToPolygon(path);
      if (polygon) {
        polygons.push(polygon);
      }
    }

    if (polygons.length === 0) {
      console.warn(`No valid polygons for municipality: ${munName}`);
      continue;
    }

    if (!municipalityFeatures.has(munid_5)) {
      municipalityFeatures.set(munid_5, []);
      municipalityNames.set(munid_5, municipalityLookup.get(munid_5)?.name || munName);
    }

    municipalityFeatures.get(munid_5)!.push(...polygons);
  }

  console.log(`Found features for ${municipalityFeatures.size} municipalities\n`);

  // Build reconstruction report
  const report: ReconstructionReport = {
    total_municipalities: municipalityLookup.size,
    reconstructed: 0,
    geometry_fixes_applied: {
      ring_closure: 0,
      fragment_union: 0
    },
    unresolved_id_count: 0,
    unresolved_ids: [],
    notes: [
      'Borders are reconstructed from settlement outlines and are not surveyed.',
      'This layer supersedes drzava-derived municipality geometry.'
    ]
  };

  // Process each municipality
  const outputFeatures: Array<turf.Feature<turf.Polygon | turf.MultiPolygon>> = [];
  let featureIndex = 0;

  // Sort municipalities by ID for deterministic output
  const sortedMunicipalityIds = Array.from(municipalityFeatures.keys()).sort();

  for (const munid_5 of sortedMunicipalityIds) {
    const polygons = municipalityFeatures.get(munid_5)!;
    const name = municipalityNames.get(munid_5);

    // Union multiple polygons if needed
    let finalGeometry: turf.Polygon | turf.MultiPolygon | null = null;

    if (polygons.length === 1) {
      finalGeometry = polygons[0];
    } else {
      report.geometry_fixes_applied.fragment_union += polygons.length - 1;
      finalGeometry = unionGeometries(polygons);
    }

    if (!finalGeometry) {
      console.warn(`Failed to process geometry for municipality ${munid_5}`);
      continue;
    }

    // Fix geometry (close rings, validate)
    const fixedGeometry = fixGeometry(finalGeometry, report);
    if (!fixedGeometry) {
      console.warn(`Failed to fix geometry for municipality ${munid_5}`);
      continue;
    }

    // Round coordinates
    const roundedGeometry = roundGeometry(fixedGeometry);

    // Create output feature
    const outputFeature: turf.Feature<turf.Polygon | turf.MultiPolygon> = {
      type: 'Feature',
      geometry: roundedGeometry,
      properties: {
        munid_5: munid_5,
        name: name || null,
        source: 'reconstructed_from_settlement_outlines',
        reconstruction_method: 'settlement_outline_union',
        legacy_source_file: 'settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5',
        feature_index: featureIndex++
      }
    };

    outputFeatures.push(outputFeature);
    report.reconstructed++;
  }

  // Check for unresolved municipalities
  for (const [id, lookup] of municipalityLookup.entries()) {
    if (!municipalityFeatures.has(id)) {
      report.unresolved_ids.push(id);
    }
  }
  report.unresolved_id_count = report.unresolved_ids.length;
  report.unresolved_ids.sort(); // Deterministic sort

  // Create output GeoJSON
  const outputGeoJSON: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: {
        name: 'LOCAL_PIXELS_V2'
      }
    },
    features: outputFeatures
  };

  // Write outputs
  console.log('\nWriting outputs...');
  await writeFile(OUTPUT_GEOJSON, JSON.stringify(outputGeoJSON, null, 2), 'utf8');
  await writeFile(OUTPUT_REPORT, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n✓ Reconstruction complete!`);
  console.log(`  - Reconstructed: ${report.reconstructed} municipalities`);
  console.log(`  - Ring closures: ${report.geometry_fixes_applied.ring_closure}`);
  console.log(`  - Fragment unions: ${report.geometry_fixes_applied.fragment_union}`);
  console.log(`  - Unresolved IDs: ${report.unresolved_id_count}`);
  console.log(`\n  Output: ${OUTPUT_GEOJSON}`);
  console.log(`  Report: ${OUTPUT_REPORT}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
