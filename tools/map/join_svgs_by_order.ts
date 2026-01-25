/**
 * Order-based SVG Join: Populate settlement.svg_path using deterministic order matching
 * 
 * Joins SVG paths from municipality-level Raphael.js files into master_municipalities.json
 * by matching paths in order with settlements sorted by settlement_id.
 * 
 * Inputs:
 *   - data/source/master_municipalities.json
 *   - data/source/settlements_pack.zip
 *   - data/source/svg_join_overrides.json (optional)
 * 
 * Outputs:
 *   - data/source/master_municipalities.json (updated in-place)
 *   - data/source/svg_join_order_report.json
 *   - data/source/svg_join_order_report.txt
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import AdmZip from 'adm-zip';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// Types
interface MasterMunicipality {
  municipality_id: string;
  name: string;
  capital_sid: string | null;
  totals: {
    total_population: number;
    bosniaks: number;
    croats: number;
    serbs: number;
    others: number;
  };
  settlements: MasterSettlement[];
}

interface MasterSettlement {
  settlement_id: string;
  name: string;
  census: {
    total_population: number;
    bosniaks: number | null;
    croats: number | null;
    serbs: number | null;
    others: number | null;
    [key: string]: unknown;
  };
  settlement_type: string;
  is_urban_center: boolean;
  is_municipality_capital: boolean;
  svg_path: string | null;
  mapping_note: string | null;
}

interface MasterData {
  version: string;
  source: {
    census: string;
    svg_pack: string;
  };
  municipalities: MasterMunicipality[];
}

interface MunicipalityOverride {
  file: string;
  mode: 'order';
  skip: boolean;
  settlement_order: 'sid_asc';
  manual_index_map: Array<{ sid: string; path_index: number }> | null;
}

interface OverridesFile {
  municipalities: Record<string, MunicipalityOverride>;
}

interface MunicipalityJoinResult {
  mid: string;
  name: string;
  js_file: string | null;
  settlements_count: number;
  paths_count: number;
  joined: boolean;
  reason_if_not: string | null;
  assigned_count: number;
  arc_paths_count: number;
}

interface JoinReport {
  totals: {
    municipalities_total: number;
    municipalities_with_js_file: number;
    municipalities_joined: number;
    municipalities_skipped_count_mismatch: number;
    municipalities_skipped_no_file: number;
    settlements_total: number;
    settlements_assigned: number;
    settlements_unassigned: number;
    total_paths_extracted: number;
    arc_paths_count: number;
  };
  per_municipality: MunicipalityJoinResult[];
  mismatches_sample: Array<{
    mid: string;
    name: string;
    js_file: string;
    settlements_count: number;
    paths_count: number;
  }>;
  no_file_sample: Array<{
    mid: string;
    name: string;
  }>;
}

// Constants
const MASTER_FILE = resolve('data/source/master_municipalities.json');
const SVG_PACK_FILE = resolve('data/source/settlements_pack.zip');
const CACHE_DIR = resolve('tools/map/.cache/settlements_pack');
const OVERRIDES_FILE = resolve('data/source/svg_join_overrides.json');
const REPORT_JSON = resolve('data/source/svg_join_order_report.json');
const REPORT_TXT = resolve('data/source/svg_join_order_report.txt');

/**
 * Normalize name: trim, collapse whitespace, lowercase, remove diacritics
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
 * Extract municipality ID from filename (format: "MunicipalityName_MID.js")
 */
function extractMIDFromFilename(filename: string): string | null {
  const match = filename.match(/_(\d+)(?:\.js)?$/i);
  return match ? match[1] : null;
}

/**
 * Extract municipality name from filename (format: "MunicipalityName_MID.js")
 */
function extractNameFromFilename(filename: string): string | null {
  const match = filename.match(/^([^_]+)_/);
  return match ? match[1].trim() : null;
}

/**
 * Extract ordered list of path strings from Raphael.js file
 * Matches R.path("...") and R.path('...') patterns, preserving order
 */
function extractPathsFromJS(content: string): string[] {
  const paths: string[] = [];
  
  // Match R.path("...") or R.path('...')
  // Handle escaped quotes inside strings
  const raphaelPathRegex = /R\.path\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g;
  
  let match;
  while ((match = raphaelPathRegex.exec(content)) !== null) {
    // match[2] is the path string (with escaped quotes)
    // Unescape the string
    const pathStr = match[2]
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    paths.push(pathStr);
  }
  
  return paths;
}

/**
 * Validate path string: must contain at least one moveto command
 */
function isValidPath(pathStr: string): boolean {
  if (!pathStr || !pathStr.trim()) return false;
  // Check for moveto commands (M or m)
  return /[Mm]/.test(pathStr);
}

/**
 * Count arc commands in path string
 */
function countArcCommands(pathStr: string): number {
  // Match A or a followed by whitespace or end, not part of a word
  const arcRegex = /\s+[Aa]\s+/g;
  const matches = pathStr.match(arcRegex);
  return matches ? matches.length : 0;
}

/**
 * Match municipality to JS file
 * Returns filename if found, null otherwise
 */
function matchMunicipalityToFile(
  muni: MasterMunicipality,
  jsFiles: Map<string, string> // filename -> full path
): string | null {
  const mid = muni.municipality_id;
  const name = normalizeName(muni.name);
  
  const candidates: Array<{ filename: string; priority: number }> = [];
  
  for (const filename of jsFiles.keys()) {
    const fileMID = extractMIDFromFilename(filename);
    const fileName = extractNameFromFilename(filename);
    
    if (fileMID === mid) {
      // Exact ID match - highest priority
      candidates.push({ filename, priority: 1 });
    } else if (fileName && normalizeName(fileName) === name) {
      // Name match - lower priority
      candidates.push({ filename, priority: 2 });
    }
  }
  
  if (candidates.length === 0) return null;
  
  // Sort by priority (lower is better), then by filename (lexicographic)
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.filename.localeCompare(b.filename);
  });
  
  return candidates[0].filename;
}

/**
 * Recursively find all JS files in directory
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
 * Load overrides file (create if missing)
 */
async function loadOverrides(): Promise<OverridesFile> {
  try {
    const content = await readFile(OVERRIDES_FILE, 'utf8');
    return JSON.parse(content) as OverridesFile;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      // File doesn't exist, create empty structure
      const empty: OverridesFile = { municipalities: {} };
      await mkdir(resolve('data/source'), { recursive: true });
      await writeFile(OVERRIDES_FILE, JSON.stringify(empty, null, 2), 'utf8');
      return empty;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  loadMistakes();
  assertNoRepeat('Order-based SVG join from municipality-level Raphael.js pack');
  loadLedger();
  assertLedgerFresh('Order-based SVG join from municipality-level Raphael.js pack');
  
  console.log('Order-based SVG Join: Wiring geometry into master_municipalities.json\n');
  
  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  
  const totalSettlements = masterData.municipalities.reduce((sum, m) => sum + m.settlements.length, 0);
  console.log(`  Loaded ${masterData.municipalities.length} municipalities`);
  console.log(`  Total settlements: ${totalSettlements}\n`);
  
  // Load overrides
  console.log('Loading overrides...');
  const overrides = await loadOverrides();
  console.log(`  Loaded ${Object.keys(overrides.municipalities).length} override(s)\n`);
  
  // Unzip and find JS files
  console.log('Unzipping SVG pack...');
  await mkdir(CACHE_DIR, { recursive: true });
  const zip = new AdmZip(SVG_PACK_FILE);
  zip.extractAllTo(CACHE_DIR, true);
  
  console.log('Finding JS files...');
  const jsFilePaths = await findJSFiles(CACHE_DIR);
  console.log(`  Found ${jsFilePaths.length} JS files`);
  
  // Build filename -> full path map
  const jsFiles = new Map<string, string>();
  for (const fullPath of jsFilePaths) {
    const relativePath = fullPath.replace(CACHE_DIR + '\\', '').replace(CACHE_DIR + '/', '');
    const filename = basename(relativePath);
    jsFiles.set(filename, fullPath);
  }
  
  // Check if SVG pack is municipality-level (trigger for mistake logging)
  let hasMultiPathFiles = false;
  if (jsFilePaths.length > 0) {
    // Sample first few files to check if they contain multiple paths
    for (let i = 0; i < Math.min(5, jsFilePaths.length); i++) {
      const sampleContent = await readFile(jsFilePaths[i], 'utf8');
      const paths = extractPathsFromJS(sampleContent);
      if (paths.length > 1) {
        hasMultiPathFiles = true;
        break;
      }
    }
  }
  
  if (hasMultiPathFiles) {
    appendMistake({
      title: 'SVG pack is municipality-level, requires order-based join',
      mistake: 'Assumed settlement-level SVG files with IDs, got municipality-level Raphael.js with no SIDs',
      correctRule: 'When SVG pack lacks settlement identifiers, use strict order-based join with count equality per municipality, and produce reports and overrides'
    });
  }
  
  // Prepare report
  const report: JoinReport = {
    totals: {
      municipalities_total: masterData.municipalities.length,
      municipalities_with_js_file: 0,
      municipalities_joined: 0,
      municipalities_skipped_count_mismatch: 0,
      municipalities_skipped_no_file: 0,
      settlements_total: totalSettlements,
      settlements_assigned: 0,
      settlements_unassigned: 0,
      total_paths_extracted: 0,
      arc_paths_count: 0
    },
    per_municipality: [],
    mismatches_sample: [],
    no_file_sample: []
  };
  
  // Process each municipality
  console.log('Processing municipalities...');
  
  for (const muni of masterData.municipalities) {
    const mid = muni.municipality_id;
    const override = overrides.municipalities[mid];
    
    // Check if skipped by override
    if (override?.skip) {
      report.per_municipality.push({
        mid,
        name: muni.name,
        js_file: null,
        settlements_count: muni.settlements.length,
        paths_count: 0,
        joined: false,
        reason_if_not: 'skipped_by_override',
        assigned_count: 0,
        arc_paths_count: 0
      });
      continue;
    }
    
    // Determine JS file
    let jsFilename: string | null = null;
    if (override?.file) {
      jsFilename = override.file;
    } else {
      jsFilename = matchMunicipalityToFile(muni, jsFiles);
    }
    
    if (!jsFilename || !jsFiles.has(jsFilename)) {
      report.totals.municipalities_skipped_no_file++;
      if (report.no_file_sample.length < 50) {
        report.no_file_sample.push({ mid, name: muni.name });
      }
      report.per_municipality.push({
        mid,
        name: muni.name,
        js_file: null,
        settlements_count: muni.settlements.length,
        paths_count: 0,
        joined: false,
        reason_if_not: 'no_js_file',
        assigned_count: 0,
        arc_paths_count: 0
      });
      continue;
    }
    
    report.totals.municipalities_with_js_file++;
    
    // Read JS file and extract paths
    const jsFilePath = jsFiles.get(jsFilename)!;
    const jsContent = await readFile(jsFilePath, 'utf8');
    const paths = extractPathsFromJS(jsContent);
    report.totals.total_paths_extracted += paths.length;
    
    // Get eligible settlements (all settlements, excluding "∑" aggregates which are already excluded upstream)
    const eligibleSettlements = muni.settlements.filter(s => {
      // Filter out any aggregates if they exist (shouldn't be in master, but safety check)
      return !s.name.includes('∑');
    });
    
    // Sort settlements by settlement_id (deterministic, stable)
    const sortedSettlements = [...eligibleSettlements].sort((a, b) => {
      const aNum = parseInt(a.settlement_id, 10) || 0;
      const bNum = parseInt(b.settlement_id, 10) || 0;
      return aNum - bNum;
    });
    
    const settlementsCount = sortedSettlements.length;
    const pathsCount = paths.length;
    
    let joined = false;
    let assignedCount = 0;
    let arcPathsCount = 0;
    let reasonIfNot: string | null = null;
    
    // Check if we should join
    if (override?.manual_index_map) {
      // Manual mapping mode
      const manualMap = override.manual_index_map;
      
      // Validate all path indices exist
      const maxIndex = Math.max(...manualMap.map(m => m.path_index), -1);
      if (maxIndex >= paths.length) {
        reasonIfNot = `manual_map_invalid_path_index: max_index=${maxIndex}, paths_count=${paths.length}`;
      } else {
        // Apply manual mapping
        const sidToIndex = new Map(manualMap.map(m => [m.sid, m.path_index]));
        
        for (const settlement of sortedSettlements) {
          const pathIndex = sidToIndex.get(settlement.settlement_id);
          if (pathIndex !== undefined) {
            const pathStr = paths[pathIndex];
            if (isValidPath(pathStr)) {
              settlement.svg_path = pathStr;
              assignedCount++;
              
              // Update mapping_note
              const noteParts: string[] = [];
              if (settlement.mapping_note) {
                noteParts.push(settlement.mapping_note);
              }
              noteParts.push(`svg_join=order; source=${jsFilename}; idx=${pathIndex}`);
              settlement.mapping_note = noteParts.join('; ');
              
              // Count arcs
              arcPathsCount += countArcCommands(pathStr);
            }
          }
        }
        
        joined = true;
      }
    } else if (pathsCount === settlementsCount) {
      // Order-based join: paths[i] -> settlements[i]
      for (let i = 0; i < pathsCount; i++) {
        const pathStr = paths[i];
        const settlement = sortedSettlements[i];
        
        if (isValidPath(pathStr)) {
          settlement.svg_path = pathStr;
          assignedCount++;
          
          // Update mapping_note
          const noteParts: string[] = [];
          if (settlement.mapping_note) {
            noteParts.push(settlement.mapping_note);
          }
          noteParts.push(`svg_join=order; source=${jsFilename}; idx=${i}`);
          settlement.mapping_note = noteParts.join('; ');
          
          // Count arcs
          arcPathsCount += countArcCommands(pathStr);
        }
      }
      
      joined = true;
      report.totals.municipalities_joined++;
    } else {
      // Count mismatch - do not join
      reasonIfNot = `count_mismatch: settlements=${settlementsCount}, paths=${pathsCount}`;
      report.totals.municipalities_skipped_count_mismatch++;
      
      if (report.mismatches_sample.length < 50) {
        report.mismatches_sample.push({
          mid,
          name: muni.name,
          js_file: jsFilename,
          settlements_count: settlementsCount,
          paths_count: pathsCount
        });
      }
    }
    
    report.totals.settlements_assigned += assignedCount;
    report.totals.arc_paths_count += arcPathsCount;
    
    report.per_municipality.push({
      mid,
      name: muni.name,
      js_file: jsFilename,
      settlements_count: settlementsCount,
      paths_count: pathsCount,
      joined,
      reason_if_not: reasonIfNot,
      assigned_count: assignedCount,
      arc_paths_count: arcPathsCount
    });
  }
  
  report.totals.settlements_unassigned = report.totals.settlements_total - report.totals.settlements_assigned;
  
  // Sort municipalities by id before writing (stable formatting)
  masterData.municipalities.sort((a, b) => {
    const aNum = parseInt(a.municipality_id, 10) || 0;
    const bNum = parseInt(b.municipality_id, 10) || 0;
    return aNum - bNum;
  });
  
  // Sort settlements within each municipality by id
  for (const muni of masterData.municipalities) {
    muni.settlements.sort((a, b) => {
      const aNum = parseInt(a.settlement_id, 10) || 0;
      const bNum = parseInt(b.settlement_id, 10) || 0;
      return aNum - bNum;
    });
  }
  
  // Write updated master
  console.log('\nWriting updated master data...');
  await writeFile(MASTER_FILE, JSON.stringify(masterData, null, 2), 'utf8');
  console.log(`  Updated ${MASTER_FILE}\n`);
  
  // Write reports
  console.log('Writing reports...');
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
  
  // Generate text report
  const txtLines: string[] = [];
  txtLines.push('Order-based SVG Join Report');
  txtLines.push('='.repeat(80));
  txtLines.push('');
  txtLines.push('Totals:');
  txtLines.push(`  Municipalities total: ${report.totals.municipalities_total}`);
  txtLines.push(`  Municipalities with JS file: ${report.totals.municipalities_with_js_file}`);
  txtLines.push(`  Municipalities joined: ${report.totals.municipalities_joined}`);
  txtLines.push(`  Municipalities skipped (count mismatch): ${report.totals.municipalities_skipped_count_mismatch}`);
  txtLines.push(`  Municipalities skipped (no file): ${report.totals.municipalities_skipped_no_file}`);
  txtLines.push(`  Settlements total: ${report.totals.settlements_total}`);
  txtLines.push(`  Settlements assigned: ${report.totals.settlements_assigned}`);
  txtLines.push(`  Settlements unassigned: ${report.totals.settlements_unassigned}`);
  txtLines.push(`  Total paths extracted: ${report.totals.total_paths_extracted}`);
  txtLines.push(`  Paths with arc commands: ${report.totals.arc_paths_count}`);
  txtLines.push('');
  
  // Top 30 municipalities by absolute delta
  const deltas = report.per_municipality
    .filter(m => m.js_file && !m.joined)
    .map(m => ({
      ...m,
      delta: Math.abs(m.paths_count - m.settlements_count)
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 30);
  
  if (deltas.length > 0) {
    txtLines.push('Top 30 municipalities by absolute delta (paths - settlements):');
    for (const m of deltas) {
      txtLines.push(`  ${m.name} (${m.mid}): ${m.settlements_count} settlements, ${m.paths_count} paths, delta=${m.delta}`);
    }
    txtLines.push('');
  }
  
  // Top 30 municipalities by unassigned settlements
  const unassigned = report.per_municipality
    .map(m => ({
      ...m,
      unassigned: m.settlements_count - m.assigned_count
    }))
    .filter(m => m.unassigned > 0)
    .sort((a, b) => b.unassigned - a.unassigned)
    .slice(0, 30);
  
  if (unassigned.length > 0) {
    txtLines.push('Top 30 municipalities by unassigned settlements:');
    for (const m of unassigned) {
      txtLines.push(`  ${m.name} (${m.mid}): ${m.unassigned} unassigned / ${m.settlements_count} total`);
    }
    txtLines.push('');
  }
  
  // Municipalities skipped due to no file
  if (report.no_file_sample.length > 0) {
    txtLines.push(`Municipalities skipped due to no JS file (showing ${Math.min(report.no_file_sample.length, 50)}):`);
    for (const m of report.no_file_sample) {
      txtLines.push(`  ${m.name} (${m.mid})`);
    }
    txtLines.push('');
  }
  
  await writeFile(REPORT_TXT, txtLines.join('\n'), 'utf8');
  
  console.log(`  Wrote ${REPORT_JSON}`);
  console.log(`  Wrote ${REPORT_TXT}\n`);
  
  console.log('Join complete!');
  console.log(`  Municipalities joined: ${report.totals.municipalities_joined} / ${report.totals.municipalities_total}`);
  console.log(`  Settlements assigned: ${report.totals.settlements_assigned} / ${report.totals.settlements_total}`);
  console.log(`  Paths with arcs: ${report.totals.arc_paths_count}`);
}

main().catch((err) => {
  console.error('Join failed:', err);
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
});
