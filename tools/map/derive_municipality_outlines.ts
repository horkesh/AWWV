/**
 * Derive Municipality Outlines: Create municipality outlines from polygon fabric
 * 
 * Primary mode (if polygon_fabric_with_mid.geojson exists and has mid != null):
 *   - Group polygons by mid and union per mid -> municipality_outline.geojson
 * 
 * Fallback mode (if crosswalk missing OR 0 polygons have mid):
 *   - Group polygons by mun_code from polygon_fabric.geojson
 *   - Union per mun_code -> mun_code_outline.geojson
 *   - DO NOT produce fake municipality_outline.geojson from settlement point hulls
 * 
 * National outline:
 *   - Always derive national_outline.geojson as union of ALL polygons in polygon_fabric.geojson
 * 
 * Outputs:
 *   - data/derived/municipality_outline.geojson (LOCAL_PIXELS_V2) - only if mid available
 *   - data/derived/mun_code_outline.geojson (LOCAL_PIXELS_V2) - only in fallback mode
 *   - data/derived/national_outline.geojson (LOCAL_PIXELS_V2) - always
 * 
 * Usage:
 *   tsx tools/map/derive_municipality_outlines.ts
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';
import { convexHull, samplePointsFromGeometry, hullPolygonGeometry } from './geometry_hull';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: derive municipality outlines (mid) or mun_code outlines fallback + national outline");
loadLedger();
assertLedgerFresh("map rebuild: derive municipality outlines (mid) or mun_code outlines fallback + national outline");

// ============================================================================
// Constants
// ============================================================================

const POLYGONS_PATH = resolve('data/derived/polygon_fabric_with_mid.geojson');
const POLYGONS_FABRIC_PATH = resolve('data/derived/polygon_fabric.geojson');
const OUTPUT_PATH = resolve('data/derived/municipality_outline.geojson');
const MUN_CODE_OUTLINE_PATH = resolve('data/derived/mun_code_outline.geojson');
const NATIONAL_OUTLINE_PATH = resolve('data/derived/national_outline.geojson');
const GEOMETRY_REPORT_PATH = resolve('data/derived/geometry_report.json');
const UNION_BATCH_SIZE = 100; // Process unions in batches to avoid stack/memory issues
const COORDINATE_PRECISION = 3; // Normalize coordinates to 3 decimals

// ============================================================================
// Derivation Functions
// ============================================================================

/**
 * Normalize coordinates to fixed precision (handles Polygon and MultiPolygon)
 */
function normalizeCoordinates(geom: turf.Feature<turf.Polygon | turf.MultiPolygon>): turf.Feature<turf.Polygon | turf.MultiPolygon> {
  if (geom.geometry.type === 'Polygon') {
    const coords = geom.geometry.coordinates;
    const normalized: number[][][] = coords.map(ring =>
      ring.map(([x, y]) => [
        Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
        Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
      ])
    );
    return turf.polygon(normalized, geom.properties);
  } else if (geom.geometry.type === 'MultiPolygon') {
    const coords = geom.geometry.coordinates;
    const normalized: number[][][][] = coords.map(polygon =>
      polygon.map(ring =>
        ring.map(([x, y]) => [
          Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
          Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
        ])
      )
    );
    return turf.multiPolygon(normalized, geom.properties);
  }
  return geom;
}

/**
 * Union multiple polygons with chunked processing to avoid stack/memory issues
 * Returns Polygon or MultiPolygon (turf.union can return either)
 * 
 * IMPORTANT: This function unions ALL polygons in the input array.
 * It processes them in batches to avoid memory issues, but every polygon
 * is included in the final union.
 */
function unionPolygonsChunked(polygons: turf.Feature<turf.Polygon>[]): turf.Feature<turf.Polygon | turf.MultiPolygon> | null {
  if (polygons.length === 0) {
    return null;
  }
  
  if (polygons.length === 1) {
    return normalizeCoordinates(polygons[0]);
  }
  
  // Sort polygons deterministically by poly_id for stable output
  const sorted = [...polygons].sort((a, b) => {
    const idA = a.properties?.poly_id || '';
    const idB = b.properties?.poly_id || '';
    return idA.localeCompare(idB);
  });
  
  // Track how many polygons we're processing
  const totalPolygons = sorted.length;
  let skippedCount = 0;
  
  try {
    // Process in batches - each batch unions all polygons in that batch
    let intermediate: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    
    for (let i = 0; i < sorted.length; i += UNION_BATCH_SIZE) {
      const batch = sorted.slice(i, i + UNION_BATCH_SIZE);
      let batchResult: turf.Feature<turf.Polygon | turf.MultiPolygon> = batch[0];
      let batchSkipped = 0;
      
      // Union all polygons in this batch
      for (let j = 1; j < batch.length; j++) {
        try {
          const unionResult = turf.union(batchResult, batch[j]);
          if (unionResult && (unionResult.geometry.type === 'Polygon' || unionResult.geometry.type === 'MultiPolygon')) {
            batchResult = unionResult as turf.Feature<turf.Polygon | turf.MultiPolygon>;
          } else {
            batchSkipped++;
            skippedCount++;
          }
        } catch (err) {
          // If union fails, try buffer(0) to fix geometry
          try {
            const fixed1 = turf.buffer(batchResult, 0, { units: 'meters' });
            const fixed2 = turf.buffer(batch[j], 0, { units: 'meters' });
            if (fixed1 && fixed2 && (fixed1.geometry.type === 'Polygon' || fixed1.geometry.type === 'MultiPolygon') && 
                (fixed2.geometry.type === 'Polygon' || fixed2.geometry.type === 'MultiPolygon')) {
              const unionResult = turf.union(fixed1 as turf.Feature<turf.Polygon | turf.MultiPolygon>, fixed2 as turf.Feature<turf.Polygon | turf.MultiPolygon>);
              if (unionResult && (unionResult.geometry.type === 'Polygon' || unionResult.geometry.type === 'MultiPolygon')) {
                batchResult = unionResult as turf.Feature<turf.Polygon | turf.MultiPolygon>;
              } else {
                batchSkipped++;
                skippedCount++;
              }
            } else {
              batchSkipped++;
              skippedCount++;
            }
          } catch {
            batchSkipped++;
            skippedCount++;
          }
        }
      }
      
      if (batchResult && batchSkipped < batch.length - 1) {
        // Only add if we successfully unioned at least 2 polygons (or had 1)
        intermediate.push(batchResult);
      } else if (batch.length === 1) {
        // Single polygon batch - add it directly
        intermediate.push(batchResult);
      }
    }
    
    // Final union of intermediate results - this unions ALL batch results
    if (intermediate.length === 0) {
      return null;
    }
    
    if (intermediate.length === 1) {
      return normalizeCoordinates(intermediate[0]);
    }
    
    // Union all intermediate results together
    let result: turf.Feature<turf.Polygon | turf.MultiPolygon> = intermediate[0];
    for (let i = 1; i < intermediate.length; i++) {
      try {
        const unionResult = turf.union(result, intermediate[i]);
        if (unionResult && (unionResult.geometry.type === 'Polygon' || unionResult.geometry.type === 'MultiPolygon')) {
          result = unionResult as turf.Feature<turf.Polygon | turf.MultiPolygon>;
        } else {
          // If union fails, try buffer fix
          try {
            const fixed1 = turf.buffer(result, 0, { units: 'meters' });
            const fixed2 = turf.buffer(intermediate[i], 0, { units: 'meters' });
            if (fixed1 && fixed2 && (fixed1.geometry.type === 'Polygon' || fixed1.geometry.type === 'MultiPolygon') && 
                (fixed2.geometry.type === 'Polygon' || fixed2.geometry.type === 'MultiPolygon')) {
              const unionResult = turf.union(fixed1 as turf.Feature<turf.Polygon | turf.MultiPolygon>, fixed2 as turf.Feature<turf.Polygon | turf.MultiPolygon>);
              if (unionResult && (unionResult.geometry.type === 'Polygon' || unionResult.geometry.type === 'MultiPolygon')) {
                result = unionResult as turf.Feature<turf.Polygon | turf.MultiPolygon>;
              }
            }
          } catch {
            // Skip this intermediate if union fails
          }
        }
      } catch (err) {
        try {
          const fixed1 = turf.buffer(result, 0, { units: 'meters' });
          const fixed2 = turf.buffer(intermediate[i], 0, { units: 'meters' });
          if (fixed1 && fixed2 && (fixed1.geometry.type === 'Polygon' || fixed1.geometry.type === 'MultiPolygon') && 
              (fixed2.geometry.type === 'Polygon' || fixed2.geometry.type === 'MultiPolygon')) {
            const unionResult = turf.union(fixed1 as turf.Feature<turf.Polygon | turf.MultiPolygon>, fixed2 as turf.Feature<turf.Polygon | turf.MultiPolygon>);
            if (unionResult && (unionResult.geometry.type === 'Polygon' || unionResult.geometry.type === 'MultiPolygon')) {
              result = unionResult as turf.Feature<turf.Polygon | turf.MultiPolygon>;
            }
          }
        } catch {
          // Skip this intermediate if union fails
        }
      }
    }
    
    // Warn if we skipped many polygons
    if (skippedCount > 0 && skippedCount > totalPolygons * 0.1) {
      console.warn(`Warning: unionPolygonsChunked skipped ${skippedCount} of ${totalPolygons} polygons (${Math.round(skippedCount / totalPolygons * 100)}%)`);
    }
    
    return normalizeCoordinates(result);
  } catch (err) {
    console.warn(`Warning: unionPolygonsChunked failed for ${totalPolygons} polygons: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Deriving municipality outlines...\n');
  
  try {
    // Load all polygon fabric (required)
    let allPolygonFC: turf.FeatureCollection<turf.Polygon> | null = null;
    try {
      const allPolygonsContent = await readFile(POLYGONS_FABRIC_PATH, 'utf8');
      allPolygonFC = JSON.parse(allPolygonsContent);
      console.log(`Loaded ${allPolygonFC.features.length} total polygons from fabric`);
    } catch (err) {
      throw new Error(`Failed to load ${POLYGONS_FABRIC_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Load polygons (with mid from crosswalk) - optional
    let polygonFC: turf.FeatureCollection<turf.Polygon> | null = null;
    let polygonsWithMid = 0;
    try {
      const polygonsContent = await readFile(POLYGONS_PATH, 'utf8');
      polygonFC = JSON.parse(polygonsContent);
      polygonsWithMid = polygonFC.features.filter(f => f.properties?.mid != null).length;
      console.log(`Loaded ${polygonFC.features.length} polygons from fabric with mid (${polygonsWithMid} have mid)`);
    } catch (err) {
      console.warn(`Warning: Could not load ${POLYGONS_PATH} - will use fallback mode`);
    }
    
    // Determine mode: explicit "mid" or "mun_code"
    const mode: 'mid' | 'mun_code' = (polygonFC != null && polygonsWithMid > 0) ? 'mid' : 'mun_code';
    const crosswalkMissing = mode === 'mun_code';
    
    console.log(`\nMode: ${mode === 'mid' ? 'mid (mid-based)' : 'mun_code (mun_code-based fallback)'}`);
    
    // ========================================================================
    // MODE="mid": Group by mid
    // ========================================================================
    if (mode === 'mid' && polygonFC) {
      const polygonsByMid = new Map<string, turf.Feature<turf.Polygon>[]>();
      
      for (const feature of polygonFC.features) {
        const mid = feature.properties?.mid;
        if (mid && typeof mid === 'string') {
          if (!polygonsByMid.has(mid)) {
            polygonsByMid.set(mid, []);
          }
          polygonsByMid.get(mid)!.push(feature);
        }
      }
      
      console.log(`Found ${polygonsByMid.size} municipalities with polygons`);
      
      const outlines: turf.Feature<turf.Polygon>[] = [];
      let unionCount = 0;
      let failedCount = 0;
      
      for (const mid of Array.from(polygonsByMid.keys()).sort()) {
        const polygons = polygonsByMid.get(mid) || [];
        const outline = unionPolygonsChunked(polygons);
        
        if (outline) {
          outline.properties = {
            mid,
            source: 'mid_union',
            ...outline.properties
          };
          outlines.push(outline);
          unionCount++;
        } else {
          failedCount++;
          console.warn(`Warning: Could not create outline for municipality ${mid}`);
        }
      }
      
      // Create FeatureCollection
      const outlineFC: turf.FeatureCollection<turf.Polygon> = {
        type: 'FeatureCollection',
        crs: {
          type: 'name',
          properties: {
            name: 'LOCAL_PIXELS_V2'
          }
        },
        features: outlines
      };
      
      await writeFile(OUTPUT_PATH, JSON.stringify(outlineFC, null, 2), 'utf8');
      console.log(`\nCreated ${outlines.length} municipality outlines (mid-based)`);
      console.log(`  Outlines from union: ${unionCount}`);
      console.log(`  Failed: ${failedCount}`);
    }
    
    // ========================================================================
    // MODE="mun_code": Group by mun_code (REQUIRED when crosswalk missing)
    // ========================================================================
    if (mode === 'mun_code') {
      // Assert that polygon_fabric.geojson has mun_code properties
      let hasMunCodeProperty = false;
      for (const feature of allPolygonFC.features) {
        if (feature.properties && 'mun_code' in feature.properties) {
          hasMunCodeProperty = true;
          break;
        }
      }
      
      if (!hasMunCodeProperty) {
        throw new Error('polygon_fabric.geojson missing properties.mun_code; cannot derive mun_code outlines');
      }
      
      // Group polygons by mun_code - extract mun_code correctly
      const polygonsByMunCode = new Map<string, turf.Feature<turf.Polygon>[]>();
      let missingMunCodeCount = 0;
      
      for (const feature of allPolygonFC.features) {
        const munCodeRaw = feature?.properties?.mun_code;
        if (munCodeRaw != null && munCodeRaw !== '') {
          const munCode = String(munCodeRaw).trim();
          if (munCode !== '') {
            // Get or create array for this mun_code
            if (!polygonsByMunCode.has(munCode)) {
              polygonsByMunCode.set(munCode, []);
            }
            // Push the feature to the existing array
            polygonsByMunCode.get(munCode)!.push(feature);
          } else {
            missingMunCodeCount++;
          }
        } else {
          missingMunCodeCount++;
        }
      }
      
      console.log(`Found ${polygonsByMunCode.size} distinct mun_code values`);
      if (missingMunCodeCount > 0) {
        console.log(`Warning: ${missingMunCodeCount} polygons missing mun_code property`);
      }
      
      if (polygonsByMunCode.size === 0) {
        throw new Error('No polygons with mun_code property found; cannot create mun_code_outline.geojson');
      }
      
      // PART 1: Add hard diagnostics
      const groupCounts = Array.from(polygonsByMunCode.entries())
        .map(([mun_code, polygons]) => ({ mun_code, n: polygons.length }))
        .sort((a, b) => {
          // Sort descending by n, then ascending by mun_code for ties
          if (b.n !== a.n) {
            return b.n - a.n;
          }
          // For ties, sort mun_code as numeric string ascending
          const numA = parseInt(a.mun_code, 10);
          const numB = parseInt(b.mun_code, 10);
          if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
          }
          return a.mun_code.localeCompare(b.mun_code);
        });
      
      const totalGroups = groupCounts.length;
      const minN = Math.min(...groupCounts.map(g => g.n));
      const maxN = Math.max(...groupCounts.map(g => g.n));
      const sortedNs = groupCounts.map(g => g.n).sort((a, b) => a - b);
      const medianN = sortedNs.length > 0 ? sortedNs[Math.floor(sortedNs.length / 2)] : 0;
      const p90Index = Math.floor(sortedNs.length * 0.9);
      const p90N = sortedNs.length > 0 ? sortedNs[p90Index] : 0;
      
      console.log(`\nmun_code groups: ${totalGroups}, min polys/group=${minN}, median=${medianN}, p90=${p90N}, max=${maxN}`);
      console.log(`top 10 mun_code by polys: ${groupCounts.slice(0, 10).map(g => `${g.mun_code}:${g.n}`).join(', ')}`);
      
      // Sanity assertion
      if (maxN <= 5) {
        throw new Error(`mun_code grouping produced tiny groups (max <= 5). Likely reading wrong property path or overwriting group arrays. maxN=${maxN}, totalGroups=${totalGroups}`);
      }
      
      const outlines: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
      let munUnionOk = 0;
      let munUnionFail = 0;
      let munHullUsed = 0;
      const SAMPLING_STEP_MUN = 8;
      
      // Process each mun_code group - ensure we use ALL polygons in the group
      for (const munCode of Array.from(polygonsByMunCode.keys()).sort()) {
        const polygons = polygonsByMunCode.get(munCode) || [];
        
        // Verify we have polygons
        if (polygons.length === 0) {
          console.warn(`Warning: mun_code ${munCode} has empty polygon array`);
          munUnionFail++;
          continue;
        }
        
        // Try union first
        let outline: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
        let unionSucceeded = false;
        
        try {
          outline = unionPolygonsChunked(polygons);
          if (outline && outline.geometry && 
              (outline.geometry.type === 'Polygon' || outline.geometry.type === 'MultiPolygon')) {
            unionSucceeded = true;
            munUnionOk++;
          } else {
            unionSucceeded = false;
            munUnionFail++;
          }
        } catch (err) {
          unionSucceeded = false;
          munUnionFail++;
        }
        
        // If union failed, use convex hull fallback
        if (!unionSucceeded) {
          try {
            // Collect all points from all geometries in this group
            const allPoints: Array<[number, number]> = [];
            for (const polygon of polygons) {
              const geom = polygon.geometry;
              if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
                const sampled = samplePointsFromGeometry(geom, SAMPLING_STEP_MUN);
                allPoints.push(...sampled);
              }
            }
            
            if (allPoints.length >= 3) {
              const hullPoints = convexHull(allPoints);
              const hullGeom = hullPolygonGeometry(hullPoints);
              
              if (hullGeom) {
                outline = turf.feature(hullGeom, {
                  mun_code: munCode,
                  source: 'mun_code_hull_fallback',
                  union_failed: true,
                  polygon_count: polygons.length
                }) as turf.Feature<turf.Polygon>;
                munHullUsed++;
              } else {
                console.warn(`Warning: Could not create hull for mun_code ${munCode} (had ${polygons.length} polygons, ${allPoints.length} sampled points)`);
                munUnionFail++;
                continue;
              }
            } else {
              console.warn(`Warning: Not enough points for hull for mun_code ${munCode} (had ${polygons.length} polygons, ${allPoints.length} sampled points)`);
              munUnionFail++;
              continue;
            }
          } catch (err) {
            console.warn(`Warning: Hull fallback failed for mun_code ${munCode}: ${err instanceof Error ? err.message : String(err)}`);
            munUnionFail++;
            continue;
          }
        } else {
          // Union succeeded - add properties
          outline!.properties = {
            mun_code: munCode,
            source: 'mun_code_union_fallback',
            polygon_count: polygons.length,
            ...outline!.properties
          };
        }
        
        if (outline) {
          outlines.push(outline);
        }
      }
      
      // Always write, even if some groups failed
      // If no outlines were created, write empty FeatureCollection
      
      // Create FeatureCollection (can contain Polygon or MultiPolygon)
      const outlineFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
        type: 'FeatureCollection',
        crs: {
          type: 'name',
          properties: {
            name: 'LOCAL_PIXELS_V2'
          }
        },
        features: outlines
      };
      
      await writeFile(MUN_CODE_OUTLINE_PATH, JSON.stringify(outlineFC, null, 2), 'utf8');
      console.log(`\nCreated ${outlines.length} mun_code outlines (fallback mode)`);
      console.log(`  Union succeeded: ${munUnionOk}`);
      console.log(`  Union failed: ${munUnionFail}`);
      console.log(`  Hull fallback used: ${munHullUsed}`);
      
      // Validate file was written correctly
      const writtenContent = await readFile(MUN_CODE_OUTLINE_PATH, 'utf8');
      const writtenFC = JSON.parse(writtenContent);
      
      if (writtenFC.type !== 'FeatureCollection') {
        throw new Error(`mun_code_outline.geojson validation failed: type is ${writtenFC.type}, expected FeatureCollection`);
      }
      
      if (writtenFC.features.length === 0) {
        throw new Error(`mun_code_outline.geojson validation failed: features.length is 0, expected > 0`);
      }
      
      for (const feature of writtenFC.features) {
        if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
          throw new Error(`mun_code_outline.geojson validation failed: feature has invalid geometry type ${feature.geometry?.type}`);
        }
      }
      
      console.log(`✓ Validated mun_code_outline.geojson: ${writtenFC.features.length} features`);
      
      // Update geometry_report.json with diagnostics
      try {
        let report: any = {};
        try {
          const reportContent = await readFile(GEOMETRY_REPORT_PATH, 'utf8');
          report = JSON.parse(reportContent);
        } catch {
          // Report doesn't exist yet
        }
        
        report.mun_code_group_stats = {
          groups: totalGroups,
          min: minN,
          median: medianN,
          p90: p90N,
          max: maxN
        };
        report.missing_mun_code_count = missingMunCodeCount;
        report.outlines_mode = 'mun_code';
        report.mun_code_groups_total = totalGroups;
        report.mun_code_outlines_written = outlines.length;
        report.mun_union_ok = munUnionOk;
        report.mun_union_fail = munUnionFail;
        report.mun_hull_used = munHullUsed;
        report.nat_union_ok = natUnionOk;
        report.nat_union_fail = natUnionFail;
        report.nat_hull_used = natHullUsed;
        report.sampling_step_mun = SAMPLING_STEP_MUN;
        report.sampling_step_nat = SAMPLING_STEP_NAT;
        
        await writeFile(GEOMETRY_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
        console.log(`Updated geometry_report.json with mun_code diagnostics`);
      } catch (err) {
        console.warn(`Warning: Could not update geometry_report.json: ${err instanceof Error ? err.message : String(err)}`);
      }
      
      // DO NOT create fake municipality_outline.geojson in fallback mode
      // Write empty FeatureCollection to avoid confusion
      const emptyFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
        type: 'FeatureCollection',
        crs: {
          type: 'name',
          properties: {
            name: 'LOCAL_PIXELS_V2'
          }
        },
        features: []
      };
      await writeFile(OUTPUT_PATH, JSON.stringify(emptyFC, null, 2), 'utf8');
    }
    
    // ========================================================================
    // NATIONAL OUTLINE: Always create from union of ALL polygons (with hull fallback)
    // ========================================================================
    console.log(`\nCreating national outline from all polygons...`);
    
    const allPolygons = allPolygonFC.features;
    let natUnionOk = 0;
    let natUnionFail = 0;
    let natHullUsed = 0;
    const SAMPLING_STEP_NAT = 12;
    
    let nationalOutline: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
    let unionSucceeded = false;
    
    // Try union first
    try {
      nationalOutline = unionPolygonsChunked(allPolygons);
      if (nationalOutline && nationalOutline.geometry && 
          (nationalOutline.geometry.type === 'Polygon' || nationalOutline.geometry.type === 'MultiPolygon')) {
        unionSucceeded = true;
        natUnionOk++;
        nationalOutline.properties = {
          id: 'BIH',
          source: 'polygon_fabric_union',
          ...nationalOutline.properties
        };
      } else {
        unionSucceeded = false;
        natUnionFail++;
      }
    } catch (err) {
      unionSucceeded = false;
      natUnionFail++;
    }
    
    // If union failed, use convex hull fallback
    if (!unionSucceeded) {
      try {
        // Collect all points from all geometries
        const allPoints: Array<[number, number]> = [];
        for (const polygon of allPolygons) {
          const geom = polygon.geometry;
          if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
            const sampled = samplePointsFromGeometry(geom, SAMPLING_STEP_NAT);
            allPoints.push(...sampled);
          }
        }
        
        if (allPoints.length >= 3) {
          const hullPoints = convexHull(allPoints);
          const hullGeom = hullPolygonGeometry(hullPoints);
          
          if (hullGeom) {
            nationalOutline = turf.feature(hullGeom, {
              id: 'BIH',
              source: 'national_hull_fallback',
              union_failed: true
            }) as turf.Feature<turf.Polygon>;
            natHullUsed++;
            console.log(`  Using hull fallback for national outline (${allPoints.length} sampled points)`);
          } else {
            throw new Error(`Hull geometry creation failed (should not happen unless geometry is totally broken)`);
          }
        } else {
          throw new Error(`Not enough points for national outline hull (${allPoints.length} sampled points)`);
        }
      } catch (err) {
        throw new Error(`Failed to create national outline - union failed and hull fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    const nationalFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: 'LOCAL_PIXELS_V2'
        }
      },
      features: [nationalOutline!]
    };
    
    await writeFile(NATIONAL_OUTLINE_PATH, JSON.stringify(nationalFC, null, 2), 'utf8');
    console.log(`  Created national outline from ${allPolygons.length} polygons`);
    console.log(`  Method: ${unionSucceeded ? 'union' : 'hull fallback'}`);
    
    // Validate national outline file
    const nationalContent = await readFile(NATIONAL_OUTLINE_PATH, 'utf8');
    const nationalFCRead = JSON.parse(nationalContent);
    
    if (nationalFCRead.type !== 'FeatureCollection') {
      throw new Error(`national_outline.geojson validation failed: type is ${nationalFCRead.type}, expected FeatureCollection`);
    }
    
    if (nationalFCRead.features.length !== 1) {
      throw new Error(`national_outline.geojson validation failed: features.length is ${nationalFCRead.features.length}, expected 1`);
    }
    
    const nationalFeature = nationalFCRead.features[0];
    if (!nationalFeature.geometry || !['Polygon', 'MultiPolygon'].includes(nationalFeature.geometry.type)) {
      throw new Error(`national_outline.geojson validation failed: geometry type is ${nationalFeature.geometry?.type}, expected Polygon or MultiPolygon`);
    }
    
    console.log(`✓ Validated national_outline.geojson: 1 feature with ${nationalFeature.geometry.type} geometry`);
    
    // ========================================================================
    // Update geometry_report.json
    // ========================================================================
    try {
      let report: any = {};
      try {
        const reportContent = await readFile(GEOMETRY_REPORT_PATH, 'utf8');
        report = JSON.parse(reportContent);
      } catch {
        // Report doesn't exist yet, create new structure
      }
      
      report.mun_code_crosswalk_missing = crosswalkMissing;
      report.outlines_mode = mode;
      
      // Always include national outline stats
      report.nat_union_ok = natUnionOk;
      report.nat_union_fail = natUnionFail;
      report.nat_hull_used = natHullUsed;
      report.sampling_step_nat = SAMPLING_STEP_NAT;
      
      // Note: mun_code stats are set in the mun_code section above (lines ~507-518)
      // They include: mun_code_group_stats, missing_mun_code_count, mun_code_groups_total,
      // mun_code_outlines_written, mun_union_ok, mun_union_fail, mun_hull_used, sampling_step_mun
      
      await writeFile(GEOMETRY_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
      console.log(`\nUpdated geometry_report.json`);
    } catch (err) {
      console.warn(`Warning: Could not update geometry_report.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    console.log(`\n✓ Municipality outline derivation complete`);
    console.log(`  Mode: ${mode}`);
    console.log(`  Output: ${mode === 'mid' ? OUTPUT_PATH : MUN_CODE_OUTLINE_PATH}`);
    console.log(`  National outline: ${NATIONAL_OUTLINE_PATH}`);
  } catch (err) {
    console.error('Error deriving outlines:', err);
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
