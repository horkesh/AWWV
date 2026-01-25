/**
 * Generate Geometry Report: Create geometry_report.json with build statistics
 * 
 * Aggregates statistics from the map build pipeline and creates a report.
 * 
 * Outputs:
 *   - data/derived/geometry_report.json
 * 
 * Usage:
 *   tsx tools/map/generate_geometry_report.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
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

interface GeometryReport {
  counts: {
    total_features: number;
    polygons_kept: number;
    polygons_dropped: number;
    points_created: number;
    excel_aggregate_rows_filtered: number;
    polygons_without_meta: number;
    meta_without_polygons: number;
    municipalities_derived: number;
  };
  polygon_drop_reasons: Record<string, number>;
  join_stats: {
    polygons_without_meta: number;
    meta_without_polygons: number;
    crosswalk_matched?: number;
    crosswalk_unresolved?: number;
  };
  excel_stats: {
    aggregate_rows_filtered: number;
  };
  bounds: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
  crs: string;
}

// ============================================================================
// Constants
// ============================================================================

const DERIVED_DIR = resolve('data/derived');
const SVG_PATHS_PATH = resolve('data/derived/settlement_svgpaths.json');
const POLYGONS_PATH = resolve('data/derived/settlement_polygons_rekeyed.geojson');
const POINTS_PATH = resolve('data/derived/settlement_points_rekeyed.geojson');
const META_PATH = resolve('data/derived/settlements_meta.csv');
const OUTLINES_PATH = resolve('data/derived/municipality_outline_rekeyed.geojson');
const CROSSWALK_PATH = resolve('data/derived/sid_crosswalk.csv');
const JOIN_STATS_PATH = resolve('data/derived/join_stats.json');
const OUTPUT_PATH = resolve('data/derived/geometry_report.json');

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Generating geometry report...\n');
  
  try {
    // Load data
    const svgPathsContent = await readFile(SVG_PATHS_PATH, 'utf8');
    const svgPaths = JSON.parse(svgPathsContent) as Array<{ sid: string; d: string }>;
    
    // Try rekeyed first, fallback to original
    let polygonsContent: string;
    let pointsContent: string;
    try {
      polygonsContent = await readFile(POLYGONS_PATH, 'utf8');
      pointsContent = await readFile(POINTS_PATH, 'utf8');
    } catch {
      // Fallback to original files
      polygonsContent = await readFile(resolve('data/derived/settlement_polygons.geojson'), 'utf8');
      pointsContent = await readFile(resolve('data/derived/settlement_points.geojson'), 'utf8');
    }
    
    const polygonFC: turf.FeatureCollection<turf.Polygon> = JSON.parse(polygonsContent);
    const pointFC: turf.FeatureCollection<turf.Point> = JSON.parse(pointsContent);
    
    // Load meta
    const metaContent = await readFile(META_PATH, 'utf8');
    const metaLines = metaContent.split('\n').filter(l => l.trim());
    const metaSids = new Set<string>();
    
    // Parse CSV to get sids
    if (metaLines.length > 1) {
      const header = metaLines[0].split(',');
      const sidIdx = header.indexOf('sid');
      
      for (let i = 1; i < metaLines.length; i++) {
        const line = metaLines[i];
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
        
        if (sidIdx >= 0 && fields[sidIdx]) {
          const sid = fields[sidIdx].trim();
          if (sid) {
            metaSids.add(sid);
          }
        }
      }
    }
    
    // Load Excel stats
    let aggregateRowsFiltered = 0;
    try {
      const statsPath = resolve('data/derived/excel_meta_stats.json');
      const statsContent = await readFile(statsPath, 'utf8');
      const stats = JSON.parse(statsContent) as { aggregate_rows_filtered: number };
      aggregateRowsFiltered = stats.aggregate_rows_filtered;
    } catch {
      // Stats file might not exist, use 0
    }
    
    // Count polygons and points by sid
    const polygonSids = new Set<string>();
    const pointSids = new Set<string>();
    
    for (const feature of polygonFC.features) {
      const sid = feature.properties?.sid;
      if (sid && typeof sid === 'string') {
        polygonSids.add(sid);
      }
    }
    
    for (const feature of pointFC.features) {
      const sid = feature.properties?.sid;
      if (sid && typeof sid === 'string') {
        pointSids.add(sid);
      }
    }
    
    // Calculate bounds
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    
    for (const feature of polygonFC.features) {
      const bbox = turf.bbox(feature);
      minX = Math.min(minX, bbox[0]);
      minY = Math.min(minY, bbox[1]);
      maxX = Math.max(maxX, bbox[2]);
      maxY = Math.max(maxY, bbox[3]);
    }
    
    // Load outlines (try rekeyed first)
    let municipalitiesDerived = 0;
    try {
      const outlinesContent = await readFile(OUTLINES_PATH, 'utf8');
      const outlineFC: turf.FeatureCollection<turf.Polygon> = JSON.parse(outlinesContent);
      municipalitiesDerived = outlineFC.features.length;
    } catch {
      try {
        const outlinesContent = await readFile(resolve('data/derived/municipality_outline.geojson'), 'utf8');
        const outlineFC: turf.FeatureCollection<turf.Polygon> = JSON.parse(outlinesContent);
        municipalitiesDerived = outlineFC.features.length;
      } catch {
        // Outlines might not exist yet
      }
    }
    
    // Calculate join stats
    const polygonsWithoutMeta = Array.from(polygonSids).filter(sid => !metaSids.has(sid)).length;
    const metaWithoutPolygons = Array.from(metaSids).filter(sid => !polygonSids.has(sid)).length;
    
    // Load crosswalk stats
    let crosswalkMatched = 0;
    let crosswalkUnresolved = 0;
    try {
      const crosswalkContent = await readFile(CROSSWALK_PATH, 'utf8');
      const crosswalkLines = crosswalkContent.split('\n').filter(l => l.trim());
      crosswalkMatched = crosswalkLines.length - 1; // Subtract header
      
      const unresolvedPath = resolve('data/derived/sid_crosswalk_unresolved.csv');
      try {
        const unresolvedContent = await readFile(unresolvedPath, 'utf8');
        const unresolvedLines = unresolvedContent.split('\n').filter(l => l.trim());
        crosswalkUnresolved = unresolvedLines.length - 1; // Subtract header
      } catch {
        // Optional
      }
    } catch {
      // Crosswalk might not exist yet
    }
    
    // Load join stats if available
    let joinStatsData: any = null;
    try {
      const joinStatsContent = await readFile(JOIN_STATS_PATH, 'utf8');
      joinStatsData = JSON.parse(joinStatsContent);
    } catch {
      // Optional
    }
    
    // Calculate drop reasons (we don't track this in svgpath_to_geojson, so estimate)
    const polygonsDropped = svgPaths.length - polygonFC.features.length;
    const polygonDropReasons: Record<string, number> = {};
    if (polygonsDropped > 0) {
      polygonDropReasons['unknown'] = polygonsDropped;
    }
    
    // Create report
    const report: GeometryReport = {
      counts: {
        total_features: svgPaths.length,
        polygons_kept: polygonFC.features.length,
        polygons_dropped: polygonsDropped,
        points_created: pointFC.features.length,
        excel_aggregate_rows_filtered: aggregateRowsFiltered,
        polygons_without_meta: polygonsWithoutMeta,
        meta_without_polygons: metaWithoutPolygons,
        municipalities_derived: municipalitiesDerived
      },
      polygon_drop_reasons: polygonDropReasons,
      join_stats: {
        polygons_without_meta: polygonsWithoutMeta,
        meta_without_polygons: metaWithoutPolygons,
        crosswalk_matched: crosswalkMatched,
        crosswalk_unresolved: crosswalkUnresolved,
        ...(joinStatsData ? {
          polygons_total: joinStatsData.polygons_total,
          polygons_matched: joinStatsData.polygons_matched,
          polygons_unmatched: joinStatsData.polygons_unmatched,
          meta_total: joinStatsData.meta_total,
          meta_matched: joinStatsData.meta_matched,
          meta_without_polygons: joinStatsData.meta_without_polygons
        } : {})
      },
      excel_stats: {
        aggregate_rows_filtered: aggregateRowsFiltered
      },
      bounds: {
        min_x: isFinite(minX) ? minX : 0,
        min_y: isFinite(minY) ? minY : 0,
        max_x: isFinite(maxX) ? maxX : 0,
        max_y: isFinite(maxY) ? maxY : 0
      },
      crs: 'LOCAL_PIXELS_V2'
    };
    
    // Write report
    await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf8');
    
    console.log('Report generated:');
    console.log(`  Total features: ${report.counts.total_features}`);
    console.log(`  Polygons kept: ${report.counts.polygons_kept}`);
    console.log(`  Polygons dropped: ${report.counts.polygons_dropped}`);
    console.log(`  Points created: ${report.counts.points_created}`);
    console.log(`  Excel aggregate rows filtered: ${report.excel_stats.aggregate_rows_filtered}`);
    console.log(`  Polygons without meta: ${report.join_stats.polygons_without_meta}`);
    console.log(`  Meta without polygons: ${report.join_stats.meta_without_polygons}`);
    if (report.join_stats.crosswalk_matched !== undefined) {
      console.log(`  Crosswalk matched: ${report.join_stats.crosswalk_matched}`);
      console.log(`  Crosswalk unresolved: ${report.join_stats.crosswalk_unresolved}`);
    }
    console.log(`  Municipalities derived: ${report.counts.municipalities_derived}`);
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log('✓ Report generation complete');
  } catch (err) {
    console.error('Error generating report:', err);
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
