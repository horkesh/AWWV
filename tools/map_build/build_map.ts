import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import parseSVG from 'svg-path-parser';
import * as turf from '@turf/turf';
import booleanValid from '@turf/boolean-valid';

interface RawSettlementData {
  version?: string;
  notes?: string;
  settlements: Record<string, unknown> | unknown[];
  municipalities?: unknown;
}

interface SettlementIndex {
  version: string;
  sid_strategy: string;
  settlements: Array<{
    sid: string;
    source_id: string;
    mun_code: string;
    mun: string;
    name?: string;
    centroid?: { x: number; y: number };
    bbox?: { min_x: number; min_y: number; max_x: number; max_y: number };
    source_data?: unknown;
    geometry_quality?: string;
    geometry_fix_source?: string;
    geometry_fix_kind?: string;
  }>;
}

interface SettlementEdges {
  version: string;
  allow_self_loops_default: boolean;
  edges: Array<{
    a: string;
    b: string;
    one_way?: boolean;
  }>;
}

interface RawSettlementRecord {
  id: number;
  mun?: string;
  mun_code?: string;
  d?: string;
  [key: string]: unknown;
}

interface AuditRecord {
  sid: string;
  source_id: string;
  mun: string;
  mun_code: string;
  d_hash: string;
}

interface RawAuditReport {
  version: string;
  total_records: number;
  unique_sids: number;
  unique_source_ids: number;
  exact_duplicates: Array<{
    sid: string;
    records: AuditRecord[];
  }>;
  conflicting_duplicates: Array<{
    sid: string;
    records: AuditRecord[];
  }>;
  cross_municipality_source_ids: Array<{
    source_id: string;
    records: AuditRecord[];
  }>;
}

interface BuildReport {
  version: string;
  input_files: {
    settlements_data: string;
    municipality_index: string;
    polygon_fixes: string;
  };
  output_files: {
    settlements_index: string;
    settlement_edges: string;
    settlements_polygons: string;
    build_report: string;
    audit_report: string;
    polygon_failures: string;
    fallback_geometries: string;
  };
  stats: {
    total_raw_records: number;
    total_derived_records: number;
    exact_duplicates_collapsed_count: number;
    conflicting_duplicates_split_count: number;
    sid_strategy: string;
    variant_sid_mappings: Array<{ original_sid: string; variant_sid: string }>;
    pack_fixes_applied: number;
    local_fixes_applied: number;
    warnings: string[];
    errors: string[];
  };
}

interface PolygonFailure {
  sid: string;
  source_id: string;
  mun_code: string;
  mun: string;
  reason: string;
  d?: string;
  d_hash: string;
}

interface PolygonFailuresReport {
  version: string;
  total_failures: number;
  failures: PolygonFailure[];
}

interface FallbackGeometry {
  sid: string;
  source_id: string;
  mun_code: string;
  mun: string;
  geometry_fix_source: string;
  geometry_fix_kind: string;
  reason?: string;
}

interface FallbackGeometriesReport {
  version: string;
  total_fallbacks: number;
  fallbacks: FallbackGeometry[];
}

interface PolygonFix {
  settlement_id: number;
  name?: string;
  municipality?: string;
  fix: {
    type: string;
    apply_to?: string;
    notes?: string;
    replacement_d?: string;
  };
}

interface PolygonFixesPack {
  schema?: string;
  generated_from?: string;
  fix_policy?: string;
  count?: number;
  fixes: PolygonFix[];
}


const RAW_DIR = resolve('data/raw/map_kit_v1');
const DERIVED_DIR = resolve('data/derived');

function hashSvgPath(path: string | undefined): string {
  if (!path) return '';
  return createHash('sha256').update(path).digest('hex');
}

function truncateString(str: string, maxLength: number = 200): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * Extract all points from an SVG path
 */
function svgPathToPoints(svgPath: string): number[][] | null {
  if (!svgPath || !svgPath.trim()) return null;

  try {
    const commands = parseSVG(svgPath);
    parseSVG.makeAbsolute(commands);
    
    const points: number[][] = [];
    let startX = 0;
    let startY = 0;
    let hasMove = false;

    for (const cmd of commands) {
      const code = cmd.code.toUpperCase();

      switch (code) {
        case 'M': {
          const x = cmd.x!;
          const y = cmd.y!;
          startX = x;
          startY = y;
          hasMove = true;
          points.push([x, y]);
          break;
        }
        case 'L': {
          const x = cmd.x!;
          const y = cmd.y!;
          points.push([x, y]);
          break;
        }
        case 'H': {
          const x = cmd.x!;
          points.push([x, cmd.y0!]);
          break;
        }
        case 'V': {
          const y = cmd.y!;
          points.push([cmd.x0!, y]);
          break;
        }
        case 'Z': {
          // Close path - add start point if different
          if (points.length > 0 && 
              (points[points.length - 1][0] !== startX || 
               points[points.length - 1][1] !== startY)) {
            points.push([startX, startY]);
          }
          break;
        }
        case 'C':
        case 'S':
        case 'Q':
        case 'T':
        case 'A': {
          // For curves, use the end point
          const x = cmd.x!;
          const y = cmd.y!;
          points.push([x, y]);
          break;
        }
      }
    }

    if (points.length < 3) return null;
    return points;
  } catch (err) {
    return null;
  }
}

/**
 * Convert SVG path to GeoJSON polygon coordinates
 */
function svgPathToPolygon(svgPath: string): number[][][] | null {
  if (!svgPath || !svgPath.trim()) return null;

  try {
    // Use makeAbsolute to convert all commands to absolute coordinates
    const commands = parseSVG(svgPath);
    parseSVG.makeAbsolute(commands);
    
    const coordinates: number[][] = [];
    let startX = 0;
    let startY = 0;
    let hasMove = false;

    for (const cmd of commands) {
      const code = cmd.code.toUpperCase();

      switch (code) {
        case 'M': {
          const x = cmd.x!;
          const y = cmd.y!;
          if (hasMove && coordinates.length > 0) {
            // Close previous path
            if (coordinates.length > 0 && 
                (coordinates[coordinates.length - 1][0] !== startX || 
                 coordinates[coordinates.length - 1][1] !== startY)) {
              coordinates.push([startX, startY]);
            }
          }
          startX = x;
          startY = y;
          hasMove = true;
          coordinates.push([x, y]);
          break;
        }
        case 'L': {
          const x = cmd.x!;
          const y = cmd.y!;
          coordinates.push([x, y]);
          break;
        }
        case 'H': {
          const x = cmd.x!;
          coordinates.push([x, cmd.y0!]);
          break;
        }
        case 'V': {
          const y = cmd.y!;
          coordinates.push([cmd.x0!, y]);
          break;
        }
        case 'Z': {
          // Close path - use x0, y0 which should be the start point after makeAbsolute
          if (coordinates.length > 0 && 
              (coordinates[coordinates.length - 1][0] !== startX || 
               coordinates[coordinates.length - 1][1] !== startY)) {
            coordinates.push([startX, startY]);
          }
          break;
        }
        case 'C':
        case 'S':
        case 'Q':
        case 'T':
        case 'A': {
          // For curves, use the end point (x, y)
          // Note: This is a simplification - proper curve handling would require
          // approximating curves with line segments, but for adjacency detection
          // using endpoints should be sufficient
          const x = cmd.x!;
          const y = cmd.y!;
          coordinates.push([x, y]);
          break;
        }
      }
    }

    // Ensure path is closed
    if (coordinates.length > 0 && 
        (coordinates[coordinates.length - 1][0] !== coordinates[0][0] || 
         coordinates[coordinates.length - 1][1] !== coordinates[0][1])) {
      coordinates.push([coordinates[0][0], coordinates[0][1]]);
    }

    if (coordinates.length < 4) return null; // Need at least 4 points for a valid polygon (including closing point)

    return [coordinates];
  } catch (err) {
    return null;
  }
}


export function auditRawSettlements(
  rawSettlements: unknown[]
): RawAuditReport {
  const records: AuditRecord[] = [];
  const sidToRecords = new Map<string, AuditRecord[]>();
  const sourceIdToRecords = new Map<string, AuditRecord[]>();

  // Collect all records and generate sid
  for (const item of rawSettlements) {
    const record = item as RawSettlementRecord;
    if (!record || typeof record.id !== 'number') continue;

    const source_id = String(record.id);
    const mun = typeof record.mun === 'string' ? record.mun : '';
    const mun_code = typeof record.mun_code === 'string' ? record.mun_code : '';
    const d_hash = hashSvgPath(record.d);
    const sid = `${mun_code}:${source_id}`;

    const auditRecord: AuditRecord = { sid, source_id, mun, mun_code, d_hash };
    records.push(auditRecord);

    if (!sidToRecords.has(sid)) {
      sidToRecords.set(sid, []);
    }
    sidToRecords.get(sid)!.push(auditRecord);

    if (!sourceIdToRecords.has(source_id)) {
      sourceIdToRecords.set(source_id, []);
    }
    sourceIdToRecords.get(source_id)!.push(auditRecord);
  }

  // Categorize duplicate sids: exact vs conflicting
  const exactDuplicates: RawAuditReport['exact_duplicates'] = [];
  const conflictingDuplicates: RawAuditReport['conflicting_duplicates'] = [];

  for (const [sid, recordList] of sidToRecords.entries()) {
    if (recordList.length > 1) {
      // Check if all records are identical (same d_hash and mun metadata)
      const firstRecord = recordList[0];
      const allIdentical = recordList.every(
        (r) =>
          r.d_hash === firstRecord.d_hash &&
          r.mun === firstRecord.mun &&
          r.mun_code === firstRecord.mun_code
      );

      if (allIdentical) {
        exactDuplicates.push({ sid, records: recordList });
      } else {
        conflictingDuplicates.push({ sid, records: recordList });
      }
    }
  }

  // Find cross-municipality source_ids (warnings only)
  const crossMunicipalitySourceIds: RawAuditReport['cross_municipality_source_ids'] = [];
  for (const [source_id, recordList] of sourceIdToRecords.entries()) {
    if (recordList.length > 1) {
      const munCodes = new Set(recordList.map((r) => r.mun_code).filter((c) => c));
      if (munCodes.size > 1) {
        crossMunicipalitySourceIds.push({
          source_id,
          records: recordList
        });
      }
    }
  }

  const report: RawAuditReport = {
    version: '1.0.0',
    total_records: records.length,
    unique_sids: sidToRecords.size,
    unique_source_ids: sourceIdToRecords.size,
    exact_duplicates: exactDuplicates,
    conflicting_duplicates: conflictingDuplicates,
    cross_municipality_source_ids: crossMunicipalitySourceIds
  };

  return report;
}

interface PolygonFixesResult {
  fixesMap: Map<number, PolygonFix>;
  packFixIds: Set<number>;
  localFixIds: Set<number>;
}

/**
 * Load polygon fixes from pack and local files, with local overriding pack
 */
async function loadPolygonFixes(): Promise<PolygonFixesResult> {
  const fixesMap = new Map<number, PolygonFix>();
  const packFixIds = new Set<number>();
  const localFixIds = new Set<number>();
  
  // Load pack fixes
  const packFixesPath = resolve(RAW_DIR, 'settlement_polygon_fixes_pack_v1.json');
  try {
    const packContent = await readFile(packFixesPath, 'utf8');
    const packData = JSON.parse(packContent) as PolygonFixesPack;
    if (Array.isArray(packData.fixes)) {
      for (const fix of packData.fixes) {
        if (typeof fix.settlement_id === 'number') {
          fixesMap.set(fix.settlement_id, fix);
          packFixIds.add(fix.settlement_id);
        }
      }
    }
  } catch (err) {
    // Pack fixes are optional, just log warning
    process.stderr.write(`Warning: Could not load pack fixes: ${err}\n`);
  }
  
  // Load local fixes (overrides pack)
  const localFixesPath = resolve(RAW_DIR, 'settlement_polygon_fixes_local.json');
  try {
    const localContent = await readFile(localFixesPath, 'utf8');
    const localData = JSON.parse(localContent) as PolygonFixesPack | { fixes: Record<string, unknown> };
    
    // Handle array format (same as pack)
    if (Array.isArray((localData as PolygonFixesPack).fixes)) {
      for (const fix of (localData as PolygonFixesPack).fixes) {
        if (typeof fix.settlement_id === 'number') {
          // If this settlement_id was in pack, remove from pack set (local overrides)
          if (packFixIds.has(fix.settlement_id)) {
            packFixIds.delete(fix.settlement_id);
          }
          fixesMap.set(fix.settlement_id, fix);
          localFixIds.add(fix.settlement_id);
        }
      }
    }
    // Handle object format with sid keys (e.g., "20036:201049": { "action": "buffer0" })
    else if (localData.fixes && typeof localData.fixes === 'object' && !Array.isArray(localData.fixes)) {
      const fixesObj = localData.fixes as Record<string, { action?: string; fix?: PolygonFix['fix'] }>;
      for (const [sid, fixData] of Object.entries(fixesObj)) {
        // Parse sid format: "mun_code:settlement_id" to extract settlement_id
        const sidParts = sid.split(':');
        if (sidParts.length >= 2) {
          const settlementIdNum = parseInt(sidParts[1], 10);
          if (!isNaN(settlementIdNum)) {
            // Convert simplified format to PolygonFix format
            const polygonFix: PolygonFix = {
              settlement_id: settlementIdNum,
              fix: fixData.fix || {
                type: fixData.action === 'buffer0' ? 'buffer0_polygon_fix' : 'replacement_d',
                apply_to: 'best_available_subpath_polygon',
                notes: `Local fix for ${sid}`
              }
            };
            // If this settlement_id was in pack, remove from pack set (local overrides)
            if (packFixIds.has(settlementIdNum)) {
              packFixIds.delete(settlementIdNum);
            }
            fixesMap.set(settlementIdNum, polygonFix);
            localFixIds.add(settlementIdNum);
          }
        }
      }
    }
  } catch (err) {
    // Local fixes are optional, continue without error
  }
  
  return { fixesMap, packFixIds, localFixIds };
}

/**
 * Apply polygon fix to a settlement record's d field
 * Returns information about the fix applied for tracking
 */
function applyPolygonFix(record: RawSettlementRecord, fix: PolygonFix): {
  isReplacement: boolean;
  isFallback: boolean;
  fixKind: string;
} {
  if (fix.fix.type === 'replacement_d' && fix.fix.replacement_d) {
    record.d = fix.fix.replacement_d;
    return { isReplacement: true, isFallback: true, fixKind: 'replacement_d' };
  } else if (fix.fix.type === 'convex_hull_from_path') {
    // This fix type is handled during polygon processing, not here
    return { isReplacement: false, isFallback: true, fixKind: 'convex_hull_from_path' };
  } else if (fix.fix.type === 'buffer0_polygon_fix') {
    // This fix type is handled during polygon processing, not here
    // But we can mark it as needing special handling if needed
    return { isReplacement: false, isFallback: false, fixKind: 'buffer0_polygon_fix' };
  }
  // Add more fix types as needed
  return { isReplacement: false, isFallback: false, fixKind: fix.fix.type };
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const report: BuildReport = {
    version: '1.0.0',
    input_files: {
      settlements_data: resolve(RAW_DIR, 'map_data/bih_settlements_map_data.json'),
      municipality_index: resolve(RAW_DIR, 'map_data/bih_settlements_municipality_index.json'),
      polygon_fixes: resolve(RAW_DIR, 'settlement_polygon_fixes_pack_v1.json')
    },
    output_files: {
      settlements_index: resolve(DERIVED_DIR, 'settlements_index.json'),
      settlement_edges: resolve(DERIVED_DIR, 'settlement_edges.json'),
      settlements_polygons: resolve(DERIVED_DIR, 'settlements_polygons.geojson'),
      build_report: resolve(DERIVED_DIR, 'map_build_report.json'),
      audit_report: resolve(DERIVED_DIR, 'map_raw_audit_report.json'),
      polygon_failures: resolve(DERIVED_DIR, 'polygon_failures.json'),
      fallback_geometries: resolve(DERIVED_DIR, 'fallback_geometries.json')
    },
    stats: {
      total_raw_records: 0,
      total_derived_records: 0,
      exact_duplicates_collapsed_count: 0,
      conflicting_duplicates_split_count: 0,
      sid_strategy: 'mun_code:source_id',
      variant_sid_mappings: [],
      pack_fixes_applied: 0,
      local_fixes_applied: 0,
      warnings: [],
      errors: []
    }
  };

  await mkdir(DERIVED_DIR, { recursive: true });

  // Load raw data
  const settlementsRaw = JSON.parse(
    await readFile(report.input_files.settlements_data, 'utf8')
  ) as RawSettlementData;

  const municipalityIndex = JSON.parse(
    await readFile(report.input_files.municipality_index, 'utf8')
  ) as Record<string, number[]>;

  // Load polygon fixes (pack + local overlay)
  const polygonFixesResult = await loadPolygonFixes();
  const polygonFixesMap = polygonFixesResult.fixesMap;
  if (polygonFixesMap.size > 0) {
    process.stdout.write(`Loaded ${polygonFixesMap.size} polygon fix(es)\n`);
  }

  // Process settlements
  const rawSettlements = Array.isArray(settlementsRaw.settlements)
    ? settlementsRaw.settlements
    : Object.entries(settlementsRaw.settlements ?? {}).map(([id, data]) => ({
        id,
        ...(typeof data === 'object' && data ? data : {})
      }));

  // Audit raw settlements before processing
  const auditReport = auditRawSettlements(rawSettlements);
  report.stats.total_raw_records = auditReport.total_records;

  if (auditReport.exact_duplicates.length > 0) {
    report.stats.exact_duplicates_collapsed_count = auditReport.exact_duplicates.reduce(
      (sum, dup) => sum + dup.records.length - 1,
      0
    );
  }

  if (auditReport.conflicting_duplicates.length > 0) {
    report.stats.conflicting_duplicates_split_count = auditReport.conflicting_duplicates.reduce(
      (sum, dup) => sum + dup.records.length,
      0
    );
  }

  if (auditReport.cross_municipality_source_ids.length > 0) {
    report.stats.warnings.push(
      `Cross-municipality source_id duplicates (non-fatal): ${auditReport.cross_municipality_source_ids.length} source_id(s) appear under different mun_code values (resolved via sid)`
    );
  }

  // Build settlement index with sid as primary key
  const settlements: SettlementIndex['settlements'] = [];
  const sidToRecordMap = new Map<string, RawSettlementRecord>();
  const exactDuplicateSids = new Set(
    auditReport.exact_duplicates.map((dup) => dup.sid)
  );
  const conflictingDuplicateSids = new Set(
    auditReport.conflicting_duplicates.map((dup) => dup.sid)
  );

  // Reverse municipality index: source_id -> municipality_name
  const sourceIdToMunicipality = new Map<number, string>();
  for (const [municipalityName, settlementIds] of Object.entries(municipalityIndex)) {
    for (const sourceId of settlementIds) {
      sourceIdToMunicipality.set(sourceId, municipalityName);
    }
  }

  // Process all raw settlements
  for (const item of rawSettlements) {
    const record = item as RawSettlementRecord;
    if (!record || typeof record.id !== 'number') {
      report.stats.warnings.push(`Skipping settlement with invalid ID: ${JSON.stringify(item).substring(0, 100)}`);
      continue;
    }

    const source_id = String(record.id);
    const mun_code = typeof record.mun_code === 'string' ? record.mun_code : '';
    const mun = typeof record.mun === 'string' ? record.mun : sourceIdToMunicipality.get(record.id) ?? '';

    if (!mun_code) {
      report.stats.warnings.push(`Skipping settlement ${source_id} with no mun_code`);
      continue;
    }

    const baseSid = `${mun_code}:${source_id}`;
    const d_hash = hashSvgPath(record.d);
    let finalSid = baseSid;

    // Handle exact duplicates: keep first occurrence only
    if (exactDuplicateSids.has(baseSid)) {
      if (sidToRecordMap.has(baseSid)) {
        // Skip this exact duplicate (already have one)
        continue;
      }
      // Keep first occurrence
      finalSid = baseSid;
    }
    // Handle conflicting duplicates: generate variantSid
    else if (conflictingDuplicateSids.has(baseSid)) {
      const shortHash = d_hash.substring(0, 8);
      finalSid = `${baseSid}:${shortHash}`;
      report.stats.variant_sid_mappings.push({
        original_sid: baseSid,
        variant_sid: finalSid
      });
    }

    // Ensure no duplicate finalSid (shouldn't happen, but safety check)
    if (sidToRecordMap.has(finalSid)) {
      report.stats.errors.push(`Duplicate finalSid detected: ${finalSid}`);
      continue;
    }
    sidToRecordMap.set(finalSid, record);

    const settlement: SettlementIndex['settlements'][0] = {
      sid: finalSid,
      source_id,
      mun_code,
      mun,
      name: typeof record.name === 'string' ? record.name : undefined,
      source_data: record
    };

    settlements.push(settlement);
  }

  report.stats.total_derived_records = settlements.length;

  // Generate polygons from SVG paths
  const polygonFeatures: turf.Feature<turf.Polygon>[] = [];
  const sidToPolygonMap = new Map<string, turf.Feature<turf.Polygon>>();
  const polygonFailures: PolygonFailure[] = [];
  const fallbackGeometries: FallbackGeometry[] = [];
  const polygonStartTime = Date.now();
  const progressInterval = 250;

  process.stdout.write(`Generating polygons from SVG paths (${settlements.length} settlements)...\n`);
  for (let idx = 0; idx < settlements.length; idx++) {
    const settlement = settlements[idx];
    
    // Progress logging every N settlements
    if (idx > 0 && idx % progressInterval === 0) {
      const elapsed = ((Date.now() - polygonStartTime) / 1000).toFixed(1);
      const rate = (idx / ((Date.now() - polygonStartTime) / 1000)).toFixed(1);
      process.stdout.write(`  [${idx}/${settlements.length}] ${elapsed}s elapsed, ~${rate} settlements/s, current: ${settlement.sid}\n`);
    }
    const record = sidToRecordMap.get(settlement.sid);
    if (!record) {
      polygonFailures.push({
        sid: settlement.sid,
        source_id: settlement.source_id,
        mun_code: settlement.mun_code,
        mun: settlement.mun,
        reason: 'Record not found in sidToRecordMap',
        d_hash: ''
      });
      continue;
    }

    // Apply polygon fixes if available
    let fixApplied: { isReplacement: boolean; isFallback: boolean; fixKind: string } | null = null;
    let fixSource: 'pack' | 'local' | null = null;
    const sourceIdNum = parseInt(settlement.source_id, 10);
    if (!isNaN(sourceIdNum) && polygonFixesMap.has(sourceIdNum)) {
      const fix = polygonFixesMap.get(sourceIdNum)!;
      fixApplied = applyPolygonFix(record, fix);
      // Track which fixes were applied
      if (polygonFixesResult.packFixIds.has(sourceIdNum)) {
        report.stats.pack_fixes_applied++;
        fixSource = 'pack';
      } else if (polygonFixesResult.localFixIds.has(sourceIdNum)) {
        report.stats.local_fixes_applied++;
        fixSource = 'local';
      }
      
      // Track fallback geometries (replacement_d and convex_hull_from_path fixes)
      if (fixApplied.isFallback && fixSource) {
        const fixEntry = polygonFixesMap.get(sourceIdNum)!;
        fallbackGeometries.push({
          sid: settlement.sid,
          source_id: settlement.source_id,
          mun_code: settlement.mun_code,
          mun: settlement.mun,
          geometry_fix_source: fixSource,
          geometry_fix_kind: fixApplied.fixKind,
          reason: fixEntry.fix.notes || undefined
        });
        
        // Update settlement record with fallback metadata
        if (fixApplied.fixKind === 'replacement_d') {
          settlement.geometry_quality = 'fallback_replacement';
        } else if (fixApplied.fixKind === 'convex_hull_from_path') {
          settlement.geometry_quality = 'fallback_convex_hull';
        }
        settlement.geometry_fix_source = fixSource;
        settlement.geometry_fix_kind = fixApplied.fixKind;
      }
    }

    // Calculate d_hash after applying fixes
    const d_hash = hashSvgPath(record.d);

    if (!record.d || typeof record.d !== 'string' || record.d.trim().length === 0) {
      polygonFailures.push({
        sid: settlement.sid,
        source_id: settlement.source_id,
        mun_code: settlement.mun_code,
        mun: settlement.mun,
        reason: 'Missing or empty SVG path (d field)',
        d: undefined,
        d_hash
      });
      continue;
    }

    // Build polygon properties with fallback geometry metadata if applicable
    const polygonProperties: Record<string, unknown> = {
      sid: settlement.sid,
      source_id: settlement.source_id,
      mun_code: settlement.mun_code,
      mun: settlement.mun
    };
    
    let coords: number[][][] | null = null;
    
    // Handle convex_hull_from_path fix type
    if (fixApplied?.fixKind === 'convex_hull_from_path') {
      const points = svgPathToPoints(record.d);
      if (!points || points.length < 3) {
        polygonFailures.push({
          sid: settlement.sid,
          source_id: settlement.source_id,
          mun_code: settlement.mun_code,
          mun: settlement.mun,
          reason: 'Failed to extract points for convex hull',
          d: truncateString(record.d),
          d_hash
        });
        continue;
      }
      
      // Compute convex hull
      try {
        const pointFeature = turf.points(points);
        const hull = turf.convex(pointFeature);
        if (hull && hull.geometry.type === 'Polygon') {
          coords = hull.geometry.coordinates;
          if (fixSource) {
            polygonProperties.geometry_quality = 'fallback_convex_hull';
            polygonProperties.geometry_fix_source = fixSource;
            polygonProperties.geometry_fix_kind = 'convex_hull_from_path';
          }
        } else {
          polygonFailures.push({
            sid: settlement.sid,
            source_id: settlement.source_id,
            mun_code: settlement.mun_code,
            mun: settlement.mun,
            reason: 'Convex hull computation failed',
            d: truncateString(record.d),
            d_hash
          });
          continue;
        }
      } catch (err) {
        polygonFailures.push({
          sid: settlement.sid,
          source_id: settlement.source_id,
          mun_code: settlement.mun_code,
          mun: settlement.mun,
          reason: `Convex hull computation threw error: ${err instanceof Error ? err.message : String(err)}`,
          d: truncateString(record.d),
          d_hash
        });
        continue;
      }
    } else {
      // Normal path processing
      coords = svgPathToPolygon(record.d);
      if (!coords || coords.length === 0 || coords[0].length < 4) {
        polygonFailures.push({
          sid: settlement.sid,
          source_id: settlement.source_id,
          mun_code: settlement.mun_code,
          mun: settlement.mun,
          reason: 'Failed to parse SVG path or insufficient coordinates',
          d: truncateString(record.d),
          d_hash
        });
        continue;
      }
      
      if (fixApplied?.isReplacement && fixSource) {
        polygonProperties.geometry_quality = 'fallback_replacement';
        polygonProperties.geometry_fix_source = fixSource;
        polygonProperties.geometry_fix_kind = fixApplied.fixKind;
      }
    }
    
    let polygon = turf.polygon(coords, polygonProperties);

    // Validate polygon - if invalid, try buffer(0) fix
    if (!booleanValid(polygon)) {
      try {
        // Try cleaning the geometry first
        let cleaned = turf.cleanCoords(polygon);
        if (booleanValid(cleaned)) {
          polygon = cleaned as turf.Feature<turf.Polygon>;
        } else {
          // Apply buffer(0) to fix invalid geometries
          const buffered = turf.buffer(polygon, 0, { units: 'meters' });
          if (buffered && booleanValid(buffered)) {
            // Extract polygon from buffered result (might be MultiPolygon)
            if (buffered.geometry.type === 'Polygon') {
              polygon = buffered as turf.Feature<turf.Polygon>;
            } else if (buffered.geometry.type === 'MultiPolygon') {
              // Use the largest polygon from multipolygon
              const multiPoly = buffered as turf.Feature<turf.MultiPolygon>;
              let largestArea = 0;
              let largestPoly: turf.Feature<turf.Polygon> | null = null;
              for (const polyCoords of multiPoly.geometry.coordinates) {
                const poly = turf.polygon(polyCoords, polygon.properties);
                const area = turf.area(poly);
                if (area > largestArea) {
                  largestArea = area;
                  largestPoly = poly;
                }
              }
              if (largestPoly && booleanValid(largestPoly)) {
                polygon = largestPoly;
              } else {
                polygonFailures.push({
                  sid: settlement.sid,
                  source_id: settlement.source_id,
                  mun_code: settlement.mun_code,
                  mun: settlement.mun,
                  reason: 'MultiPolygon buffer(0) produced no valid largest polygon',
                  d: truncateString(record.d),
                  d_hash
                });
                continue;
              }
            } else {
              polygonFailures.push({
                sid: settlement.sid,
                source_id: settlement.source_id,
                mun_code: settlement.mun_code,
                mun: settlement.mun,
                reason: 'Buffer(0) produced non-Polygon, non-MultiPolygon geometry',
                d: truncateString(record.d),
                d_hash
              });
              continue;
            }
          } else {
            // Try simplifying as last resort
            try {
              const simplified = turf.simplify(polygon, { tolerance: 0.001, highQuality: false });
              if (booleanValid(simplified)) {
                polygon = simplified as turf.Feature<turf.Polygon>;
              } else {
                polygonFailures.push({
                  sid: settlement.sid,
                  source_id: settlement.source_id,
                  mun_code: settlement.mun_code,
                  mun: settlement.mun,
                  reason: 'Simplification did not produce valid polygon',
                  d: truncateString(record.d),
                  d_hash
                });
                continue;
              }
            } catch (simplifyErr) {
              polygonFailures.push({
                sid: settlement.sid,
                source_id: settlement.source_id,
                mun_code: settlement.mun_code,
                mun: settlement.mun,
                reason: `Simplification threw error: ${simplifyErr instanceof Error ? simplifyErr.message : String(simplifyErr)}`,
                d: truncateString(record.d),
                d_hash
              });
              continue;
            }
          }
        }
      } catch (err) {
        polygonFailures.push({
          sid: settlement.sid,
          source_id: settlement.source_id,
          mun_code: settlement.mun_code,
          mun: settlement.mun,
          reason: `Polygon validation/fix threw error: ${err instanceof Error ? err.message : String(err)}`,
          d: truncateString(record.d),
          d_hash
        });
        continue;
      }
    }

    // Final validation
    if (!booleanValid(polygon)) {
      polygonFailures.push({
        sid: settlement.sid,
        source_id: settlement.source_id,
        mun_code: settlement.mun_code,
        mun: settlement.mun,
        reason: 'Polygon failed final validation after all fix attempts',
        d: truncateString(record.d),
        d_hash
      });
      continue;
    }

    polygonFeatures.push(polygon);
    sidToPolygonMap.set(settlement.sid, polygon);
  }

  // Write polygon failures report
  const failuresReport: PolygonFailuresReport = {
    version: '1.0.0',
    total_failures: polygonFailures.length,
    failures: polygonFailures
  };
  await writeFile(
    report.output_files.polygon_failures,
    JSON.stringify(failuresReport, null, 2),
    'utf8'
  );

  // Write fallback geometries report
  const fallbackReport: FallbackGeometriesReport = {
    version: '1.0.0',
    total_fallbacks: fallbackGeometries.length,
    fallbacks: fallbackGeometries
  };
  await writeFile(
    report.output_files.fallback_geometries,
    JSON.stringify(fallbackReport, null, 2),
    'utf8'
  );
  
  if (fallbackGeometries.length > 0) {
    process.stdout.write(`\nFallback geometries: ${fallbackGeometries.length} settlement(s) using fallback fixes\n`);
    process.stdout.write(`  Written to: ${report.output_files.fallback_geometries}\n`);
  }

  // Report polygon generation failures
  if (polygonFailures.length > 0) {
    const failedSids = polygonFailures.map(f => f.sid);
    report.stats.errors.push(`Failed to generate valid polygons for ${polygonFailures.length} settlements`);
    report.stats.errors.push(`Failed sids: ${failedSids.join(', ')}`);
    process.stderr.write(`ERROR: Failed to generate polygons for ${polygonFailures.length} settlements:\n`);
    for (const failure of polygonFailures) {
      process.stderr.write(`  - ${failure.sid}: ${failure.reason}\n`);
    }
    process.stderr.write(`\nPolygon failures written to: ${report.output_files.polygon_failures}\n`);
    process.stderr.write(`Run 'npm run map:print-failures' to view a concise table\n`);
  }

  // Write settlements_polygons.geojson (even if some failed)
  const polygonsGeoJSON: turf.FeatureCollection<turf.Polygon> = {
    type: 'FeatureCollection',
    features: polygonFeatures
  };
  await writeFile(
    report.output_files.settlements_polygons,
    JSON.stringify(polygonsGeoJSON, null, 2),
    'utf8'
  );

  const polygonElapsed = ((Date.now() - polygonStartTime) / 1000).toFixed(1);
  process.stdout.write(`  [${settlements.length}/${settlements.length}] Polygon generation complete in ${polygonElapsed}s\n`);

  // Write outputs
  const settlementsIndex: SettlementIndex = {
    version: '1.0.0',
    sid_strategy: report.stats.sid_strategy,
    settlements
  };

  const settlementEdges: SettlementEdges = {
    version: '1.0.0',
    allow_self_loops_default: false,
    edges: [] // Adjacency will be generated by map:adj step
  };

  await writeFile(report.output_files.settlements_index, JSON.stringify(settlementsIndex, null, 2), 'utf8');
  await writeFile(report.output_files.settlement_edges, JSON.stringify(settlementEdges, null, 2), 'utf8');
  await writeFile(report.output_files.audit_report, JSON.stringify(auditReport, null, 2), 'utf8');
  await writeFile(report.output_files.build_report, JSON.stringify(report, null, 2), 'utf8');
  
  // Calculate total elapsed time
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Final summary
  process.stdout.write(`\nMap build complete (${totalElapsed}s total):\n`);
  process.stdout.write(`  Raw records: ${report.stats.total_raw_records}\n`);
  process.stdout.write(`  Derived records: ${report.stats.total_derived_records}\n`);
  process.stdout.write(`  Polygons generated: ${polygonFeatures.length}\n`);
  process.stdout.write(`  Exact duplicates collapsed: ${report.stats.exact_duplicates_collapsed_count}\n`);
  process.stdout.write(`  Conflicting duplicates split: ${report.stats.conflicting_duplicates_split_count}\n`);
  if (auditReport.cross_municipality_source_ids.length > 0) {
    process.stdout.write(`  Cross-municipality source_ids (resolved): ${auditReport.cross_municipality_source_ids.length}\n`);
  }
  if (report.stats.variant_sid_mappings.length > 0) {
    process.stdout.write(`  Variant sids generated: ${report.stats.variant_sid_mappings.length}\n`);
  }
  process.stdout.write(`  Note: Run 'npm run map:adj' to generate adjacency edges\n`);
  if (report.stats.warnings.length > 0) {
    process.stdout.write(`  Warnings: ${report.stats.warnings.length}\n`);
    for (const w of report.stats.warnings) {
      process.stdout.write(`    - ${w}\n`);
    }
  }
  if (report.stats.errors.length > 0) {
    process.stderr.write(`  Errors: ${report.stats.errors.length}\n`);
    for (const e of report.stats.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exitCode = 1;
  }

  // Exit with error if any polygons failed
  if (polygonFailures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write('Build failed with unhandled exception:\n');
  if (err instanceof Error) {
    process.stderr.write(`${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    process.stderr.write(`${String(err)}\n`);
    if (typeof err === 'object' && err !== null) {
      process.stderr.write(`${JSON.stringify(err, null, 2)}\n`);
    }
  }
  process.exitCode = 1;
  process.exit(1);
});
