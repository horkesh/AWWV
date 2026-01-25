/**
 * Hull Inflation Report
 * 
 * Quantifies distortion from convex hull salvage by comparing
 * original ring geometry to salvaged hull geometry.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseSettlementRing, ringToCoords } from './geometry_pipeline';

/**
 * Calculate polygon area using shoelace formula
 */
function polygonArea(ring: Float32Array): number {
  if (ring.length < 6) return 0; // Need at least 3 points (6 values)
  let area = 0;
  for (let i = 0; i < ring.length - 2; i += 2) {
    const x1 = ring[i];
    const y1 = ring[i + 1];
    const x2 = ring[i + 2];
    const y2 = ring[i + 3];
    area += x1 * y2;
    area -= x2 * y1;
  }
  // Close the polygon
  const x1 = ring[ring.length - 2];
  const y1 = ring[ring.length - 1];
  const x2 = ring[0];
  const y2 = ring[1];
  area += x1 * y2;
  area -= x2 * y1;
  return Math.abs(area) / 2;
}

// Types
interface MasterMunicipality {
  municipality_id: string;
  name: string;
  settlements: Array<{
    settlement_id: string;
    name: string;
    svg_path: string | null;
  }>;
}

interface MasterData {
  version: string;
  municipalities: MasterMunicipality[];
}

interface SettlementMeta {
  sid: string;
  mid: string;
  name: string;
  has_geometry: boolean;
  geometry_method?: string;
  hull_inflation_ratio?: number | null;
}

interface SettlementInflation {
  sid: string;
  mid: string;
  name: string;
  orig_area: number;
  hull_area: number;
  area_ratio: number;
  orig_bbox_area: number;
  hull_bbox_area: number;
  bbox_area_ratio: number;
  orig_vertices: number;
  hull_vertices: number;
  vertex_ratio: number;
}

interface MunicipalityInflation {
  mid: string;
  name: string;
  count_salvaged: number;
  median_area_ratio: number;
  p90_area_ratio: number;
  max_area_ratio: number;
}

const EPS = 1e-6;
const MASTER_FILE = resolve('data/source/master_municipalities.json');
const SETTLEMENTS_META_FILE = resolve('data/derived/settlements_meta.json');
const DERIVED_DIR = resolve('data/derived');

/**
 * Compute bounding box area
 */
function bboxArea(ring: Float32Array): number {
  if (ring.length < 6) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxX = Math.max(maxX, ring[i]);
    maxY = Math.max(maxY, ring[i + 1]);
  }
  return (maxX - minX) * (maxY - minY);
}

/**
 * Count vertices (unique points)
 */
function countVertices(ring: Float32Array): number {
  const unique = new Set<string>();
  for (let i = 0; i < ring.length; i += 2) {
    unique.add(`${ring[i]},${ring[i + 1]}`);
  }
  return unique.size;
}

/**
 * Get original ring before salvage (re-run chooseSettlementRing but stop before salvage)
 * This is a simplified version that just gets the largest valid ring
 */
function getOriginalRing(svgPath: string): Float32Array | null {
  if (!svgPath || !svgPath.trim()) return null;
  
  // Use chooseSettlementRing but we need to access the ring before salvage
  // For now, we'll re-parse and get the largest ring candidate
  // This is a bit inefficient but ensures we get the original
  
  const result = chooseSettlementRing(svgPath);
  // If salvage_used is null, the ring is the original
  // If salvage_used is "convex_hull", we need to reconstruct the original
  
  // Actually, we can't easily get the original ring after salvage
  // We'll need to modify chooseSettlementRing to return both, or
  // we can parse again and get the largest valid ring before salvage
  
  // For this report, we'll parse the SVG again to get the original ring
  // by calling chooseSettlementRing logic but stopping before salvage
  
  // Since we can't easily get the original, we'll use a workaround:
  // If salvage_used is "convex_hull", we know the original failed render-valid
  // We'll need to store the original ring in the metadata or parse it separately
  
  // For now, let's assume we can get it by parsing again
  // This is not ideal but works for the report
  
  return result.ring; // This will be the hull if salvage was used
}

async function main(): Promise<void> {
  console.log('Generating hull inflation report...\n');
  
  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  
  // Load settlements metadata
  console.log('Loading settlements metadata...');
  const metaContent = await readFile(SETTLEMENTS_META_FILE, 'utf8');
  const settlementsMeta: SettlementMeta[] = JSON.parse(metaContent);
  
  const metaBySid = new Map<string, SettlementMeta>();
  for (const meta of settlementsMeta) {
    metaBySid.set(meta.sid, meta);
  }
  
  // Process settlements with convex_hull_salvage
  const inflationData: SettlementInflation[] = [];
  
  console.log('Processing settlements with hull salvage...');
  
  for (const muni of masterData.municipalities) {
    for (const settlement of muni.settlements) {
      const sid = settlement.settlement_id;
      const meta = metaBySid.get(sid);
      
      if (!meta || !meta.has_geometry) continue;
      if (meta.geometry_method !== 'convex_hull_salvage' && 
          meta.geometry_method !== 'convex_hull_salvage_high_inflation') continue;
      
      if (!settlement.svg_path) continue;
      
      // Re-parse to get original ring and hull
      const result = chooseSettlementRing(settlement.svg_path);
      
      // Check if this is a hull salvage case
      if (result.salvage_used !== "convex_hull_salvage" && 
          result.salvage_used !== "convex_hull_salvage_high_inflation") {
        continue;
      }
      
      if (!result.ring || !result.original_ring) continue;
      
      const hullRing = result.ring;
      const origRing = result.original_ring;
      
      const hullArea = polygonArea(hullRing);
      const origArea = polygonArea(origRing);
      const areaRatio = hullArea / Math.max(origArea, EPS);
      
      const hullBboxArea = bboxArea(hullRing);
      const origBboxArea = bboxArea(origRing);
      const bboxAreaRatio = hullBboxArea / Math.max(origBboxArea, EPS);
      
      const hullVertices = countVertices(hullRing);
      const origVertices = countVertices(origRing);
      const vertexRatio = hullVertices / Math.max(origVertices, 1);
      
      inflationData.push({
        sid,
        mid: muni.municipality_id,
        name: settlement.name,
        orig_area: origArea,
        hull_area: hullArea,
        area_ratio: areaRatio,
        orig_bbox_area: origBboxArea,
        hull_bbox_area: hullBboxArea,
        bbox_area_ratio: bboxAreaRatio,
        orig_vertices: origVertices,
        hull_vertices: hullVertices,
        vertex_ratio: vertexRatio
      });
    }
  }
  
  console.log(`  Found ${inflationData.length} settlements with hull salvage\n`);
  
  // Aggregate by municipality
  const muniInflation = new Map<string, {
    mid: string;
    name: string;
    ratios: number[];
  }>();
  
  for (const data of inflationData) {
    if (!muniInflation.has(data.mid)) {
      const muni = masterData.municipalities.find(m => m.municipality_id === data.mid);
      muniInflation.set(data.mid, {
        mid: data.mid,
        name: muni?.name || data.mid,
        ratios: []
      });
    }
    muniInflation.get(data.mid)!.ratios.push(data.area_ratio);
  }
  
  const municipalityAggregates: MunicipalityInflation[] = [];
  for (const [mid, data] of muniInflation.entries()) {
    const sorted = [...data.ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const max = Math.max(...sorted);
    
    municipalityAggregates.push({
      mid: data.mid,
      name: data.name,
      count_salvaged: sorted.length,
      median_area_ratio: median,
      p90_area_ratio: p90,
      max_area_ratio: max
    });
  }
  
  municipalityAggregates.sort((a, b) => b.p90_area_ratio - a.p90_area_ratio);
  
  // Write JSON report
  const jsonReport = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    summary: {
      total_salvaged: inflationData.length,
      median_area_ratio: inflationData.length > 0 
        ? [...inflationData].sort((a, b) => a.area_ratio - b.area_ratio)[Math.floor(inflationData.length / 2)].area_ratio
        : 0,
      p90_area_ratio: inflationData.length > 0
        ? [...inflationData].sort((a, b) => a.area_ratio - b.area_ratio)[Math.floor(inflationData.length * 0.9)].area_ratio
        : 0,
      max_area_ratio: inflationData.length > 0
        ? Math.max(...inflationData.map(d => d.area_ratio))
        : 0
    },
    settlements: inflationData.sort((a, b) => b.area_ratio - a.area_ratio),
    municipalities: municipalityAggregates
  };
  
  await writeFile(
    resolve(DERIVED_DIR, 'hull_inflation_report.json'),
    JSON.stringify(jsonReport, null, 2),
    'utf8'
  );
  
  // Write TXT report
  const txtLines: string[] = [];
  txtLines.push('Hull Inflation Report');
  txtLines.push('='.repeat(80));
  txtLines.push('');
  txtLines.push(`Generated: ${new Date().toISOString()}`);
  txtLines.push('');
  txtLines.push('Summary:');
  txtLines.push(`  Total salvaged settlements: ${jsonReport.summary.total_salvaged}`);
  txtLines.push(`  Median area ratio: ${jsonReport.summary.median_area_ratio.toFixed(2)}`);
  txtLines.push(`  P90 area ratio: ${jsonReport.summary.p90_area_ratio.toFixed(2)}`);
  txtLines.push(`  Max area ratio: ${jsonReport.summary.max_area_ratio.toFixed(2)}`);
  txtLines.push('');
  txtLines.push('Note: Area ratios >> 5 indicate serious distortion');
  txtLines.push('');
  txtLines.push('Top 50 Settlements by Area Ratio:');
  txtLines.push('-'.repeat(80));
  for (let i = 0; i < Math.min(50, inflationData.length); i++) {
    const d = inflationData[i];
    txtLines.push(`${i + 1}. ${d.name} (${d.sid}) - Ratio: ${d.area_ratio.toFixed(2)}, Area: ${d.orig_area.toFixed(2)} -> ${d.hull_area.toFixed(2)}`);
  }
  txtLines.push('');
  txtLines.push('Top 30 Municipalities by P90 Area Ratio:');
  txtLines.push('-'.repeat(80));
  for (let i = 0; i < Math.min(30, municipalityAggregates.length); i++) {
    const m = municipalityAggregates[i];
    txtLines.push(`${i + 1}. ${m.name} (${m.mid}) - P90: ${m.p90_area_ratio.toFixed(2)}, Count: ${m.count_salvaged}, Max: ${m.max_area_ratio.toFixed(2)}`);
  }
  
  await writeFile(
    resolve(DERIVED_DIR, 'hull_inflation_report.txt'),
    txtLines.join('\n'),
    'utf8'
  );
  
  console.log('  Wrote hull_inflation_report.json');
  console.log('  Wrote hull_inflation_report.txt');
  console.log('\nReport complete!');
}

main().catch((err) => {
  console.error('Report generation failed:', err);
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
});
