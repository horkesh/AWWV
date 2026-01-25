/**
 * SVG Join Script: Wire SVG geometry into master_municipalities.json
 * 
 * Joins SVG paths from settlements_pack.zip into the cleaned authority master
 * by matching on settlement_id or municipality_id + normalized name.
 * 
 * Inputs:
 *   - data/source/master_municipalities.json
 *   - data/source/settlements_pack.zip
 * 
 * Outputs:
 *   - data/source/master_municipalities.json (updated in-place)
 *   - data/source/svg_join_report.json
 *   - data/source/svg_join_report.txt
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import AdmZip from 'adm-zip';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
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

interface SVGEntry {
  svg_source: string;
  d_concat: string;
  path_count: number;
  derived_keys: string[];
}

interface JoinReport {
  totals: {
    svg_files: number;
    settlements_total: number;
    settlements_matched: number;
    matched_by_sid: number;
    matched_by_midname: number;
    unmatched_settlements: number;
  };
  collisions_resolved: Array<{
    key: string;
    svg_count: number;
    selected: string;
    reason: string;
  }>;
  conflicts_rejected: Array<{
    svg_source: string;
    key: string;
    matched_sids: string[];
    assigned_to: string;
  }>;
  unmatched_settlements_sample: Array<{
    mid: string;
    sid: string;
    name: string;
    tried_keys: string[];
  }>;
  unused_svg_sample: Array<{
    svg_source: string;
    derived_keys: string[];
  }>;
  arc_command_stats: {
    count_with_arc: number;
  };
}

// Constants
const MASTER_FILE = resolve('data/source/master_municipalities.json');
const SVG_PACK_FILE = resolve('data/source/settlements_pack.zip');
const CACHE_DIR = resolve('tools/map/.cache/settlements_pack');
const REPORT_JSON = resolve('data/source/svg_join_report.json');
const REPORT_TXT = resolve('data/source/svg_join_report.txt');

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
 * Extract integer SID from filename
 */
function extractSIDFromFilename(filename: string): string | null {
  // Look for sequences of digits that could be SIDs (>= 1)
  const matches = filename.match(/\d{6,}/g);
  if (matches && matches.length > 0) {
    // Return the first long sequence (likely SID)
    const candidate = matches[0];
    if (parseInt(candidate, 10) >= 1) {
      return candidate;
    }
  }
  return null;
}

/**
 * Extract path d attributes from SVG/JS content
 */
function extractPathD(content: string): string[] {
  const paths: string[] = [];
  
  // Try SVG format first: <path d="...">
  const svgPathRegex = /<path\s+[^>]*d\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = svgPathRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  
  // Try Raphael.js format: R.path("...")
  const raphaelPathRegex = /R\.path\s*\(\s*["']([^"']+)["']\s*\)/gi;
  while ((match = raphaelPathRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  
  return paths;
}

/**
 * Extract title or metadata from SVG/JS content
 */
function extractSVGMetadata(content: string, filename: string): { title?: string; sid?: string; name?: string; mid?: string } {
  const result: { title?: string; sid?: string; name?: string; mid?: string } = {};
  
  // Extract <title> from SVG
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  }
  
  // Extract MID from filename (format: "MunicipalityName_MID.js")
  const filenameMatch = filename.match(/_(\d+)(?:\.js|\.svg)?$/i);
  if (filenameMatch) {
    result.mid = filenameMatch[1];
  }
  
  // Try to extract SID from title or metadata
  if (result.title) {
    const sidMatch = result.title.match(/\d{6,}/);
    if (sidMatch) {
      result.sid = sidMatch[0];
    }
  }
  
  // Try to extract SID from content (look for settlement IDs in comments or strings)
  if (!result.sid) {
    const sidMatch = content.match(/settlement[_\s]*id[_\s]*[:=]\s*["']?(\d{6,})/i);
    if (sidMatch) {
      result.sid = sidMatch[1];
    }
  }
  
  return result;
}

/**
 * Derive keys from SVG/JS filename and content
 */
function deriveSVGKeys(filename: string, content: string): string[] {
  const keys: string[] = [];
  const baseName = basename(filename, extname(filename));
  
  // Extract SID from filename
  const sid = extractSIDFromFilename(filename);
  if (sid) {
    keys.push(`sid:${sid}`);
  }
  
  // Extract metadata
  const metadata = extractSVGMetadata(content, filename);
  if (metadata.sid) {
    keys.push(`sid:${metadata.sid}`);
  }
  
  // Extract MID from filename (format: "MunicipalityName_MID.js")
  if (metadata.mid) {
    keys.push(`mid:${metadata.mid}`);
    
    // Try to extract settlement name from filename (before the underscore)
    const nameMatch = filename.match(/^([^_]+)_/);
    if (nameMatch) {
      const settlementName = nameMatch[1].trim();
      if (settlementName) {
        keys.push(`midname:${metadata.mid}:${normalizeName(settlementName)}`);
      }
    }
  }
  
  return keys;
}

/**
 * Recursively find all SVG/JS files in directory
 */
async function findSVGFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.svg' || ext === '.js') {
          files.push(fullPath);
        }
      }
    }
  }
  
  await walk(dir);
  return files;
}

/**
 * Build SVG index from unzipped pack
 */
async function buildSVGIndex(): Promise<Map<string, SVGEntry[]>> {
  console.log('Unzipping SVG pack...');
  
  // Clean cache directory
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Directory might already exist
  }
  
  // Unzip
  const zip = new AdmZip(SVG_PACK_FILE);
  zip.extractAllTo(CACHE_DIR, true);
  
  console.log('Finding SVG/JS files...');
  const svgFiles = await findSVGFiles(CACHE_DIR);
  console.log(`  Found ${svgFiles.length} files`);
  
  const index = new Map<string, SVGEntry[]>();
  let arcCount = 0;
  
  for (const svgFile of svgFiles) {
    const content = await readFile(svgFile, 'utf8');
    const paths = extractPathD(content);
    
    if (paths.length === 0) continue;
    
    // Check for arc commands (A or a followed by numbers, not just "a" in a word)
    const dConcat = paths.join(' | ');
    if (dConcat.match(/\s+[Aa]\s+/) || dConcat.match(/^[Aa]\s+/) || dConcat.match(/\s+[Aa]$/)) {
      arcCount++;
    }
    
    const relativePath = svgFile.replace(CACHE_DIR + '\\', '').replace(CACHE_DIR + '/', '');
    
    const entry: SVGEntry = {
      svg_source: relativePath,
      d_concat: dConcat,
      path_count: paths.length,
      derived_keys: deriveSVGKeys(relativePath, content)
    };
    
    // Add to index by each key
    for (const key of entry.derived_keys) {
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)!.push(entry);
    }
  }
  
  console.log(`  Indexed ${index.size} unique keys`);
  console.log(`  SVGs with arc commands: ${arcCount}`);
  
  return index;
}

/**
 * Resolve collision: multiple SVGs for same key
 */
function resolveCollision(entries: SVGEntry[]): SVGEntry {
  // Sort by: path_count (desc), d_concat length (desc), svg_source (asc)
  entries.sort((a, b) => {
    if (b.path_count !== a.path_count) {
      return b.path_count - a.path_count;
    }
    if (b.d_concat.length !== a.d_concat.length) {
      return b.d_concat.length - a.d_concat.length;
    }
    return a.svg_source.localeCompare(b.svg_source);
  });
  
  return entries[0];
}

async function main(): Promise<void> {
  loadMistakes();
  assertNoRepeat('SVG join into master municipalities');
  loadLedger();
  assertLedgerFresh('SVG join into master municipalities');
  
  console.log('SVG Join: Wiring geometry into master_municipalities.json\n');
  
  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  
  const totalSettlements = masterData.municipalities.reduce((sum, m) => sum + m.settlements.length, 0);
  console.log(`  Loaded ${masterData.municipalities.length} municipalities`);
  console.log(`  Total settlements: ${totalSettlements}\n`);
  
  // Build SVG index
  const svgIndex = await buildSVGIndex();
  console.log('');
  
  // Count unique SVG files
  const uniqueSVGFiles = new Set<string>();
  for (const entries of svgIndex.values()) {
    for (const entry of entries) {
      uniqueSVGFiles.add(entry.svg_source);
    }
  }
  
  // Prepare matching
  const report: JoinReport = {
    totals: {
      svg_files: uniqueSVGFiles.size,
      settlements_total: totalSettlements,
      settlements_matched: 0,
      matched_by_sid: 0,
      matched_by_midname: 0,
      unmatched_settlements: 0
    },
    collisions_resolved: [],
    conflicts_rejected: [],
    unmatched_settlements_sample: [],
    unused_svg_sample: [],
    arc_command_stats: {
      count_with_arc: 0
    }
  };
  
  const usedSVGs = new Map<string, string>(); // svg_source -> assigned_sid
  const settlementMatches = new Map<string, { entry: SVGEntry; method: 'sid' | 'midname' }>();
  const svgToSettlements = new Map<string, string[]>(); // Track which settlements want same SVG
  
  // First pass: collect all potential matches
  console.log('Matching settlements to SVGs...');
  
  for (const muni of masterData.municipalities) {
    for (const settlement of muni.settlements) {
      const sid = settlement.settlement_id;
      const mid = muni.municipality_id;
      const name = settlement.name;
      
      const sidKey = `sid:${sid}`;
      const midNameKey = `midname:${mid}:${normalizeName(name)}`;
      
      let matched = false;
      
      // Try SID first
      if (svgIndex.has(sidKey)) {
        const entries = svgIndex.get(sidKey)!;
        
        // Resolve collision if multiple SVGs for same key
        const selected = entries.length > 1 ? resolveCollision(entries) : entries[0];
        
        if (entries.length > 1) {
          report.collisions_resolved.push({
            key: sidKey,
            svg_count: entries.length,
            selected: selected.svg_source,
            reason: `path_count=${selected.path_count}, length=${selected.d_concat.length}, source=${selected.svg_source}`
          });
        }
        
        // Track this SVG usage
        if (!svgToSettlements.has(selected.svg_source)) {
          svgToSettlements.set(selected.svg_source, []);
        }
        svgToSettlements.get(selected.svg_source)!.push(sid);
        
        settlementMatches.set(sid, { entry: selected, method: 'sid' });
        matched = true;
      } else if (svgIndex.has(midNameKey)) {
        // Try midname fallback
        const entries = svgIndex.get(midNameKey)!;
        
        const selected = entries.length > 1 ? resolveCollision(entries) : entries[0];
        
        if (entries.length > 1) {
          report.collisions_resolved.push({
            key: midNameKey,
            svg_count: entries.length,
            selected: selected.svg_source,
            reason: `path_count=${selected.path_count}, length=${selected.d_concat.length}, source=${selected.svg_source}`
          });
        }
        
        if (!svgToSettlements.has(selected.svg_source)) {
          svgToSettlements.set(selected.svg_source, []);
        }
        svgToSettlements.get(selected.svg_source)!.push(sid);
        
        settlementMatches.set(sid, { entry: selected, method: 'midname' });
        matched = true;
      }
      
      if (!matched) {
        // Try matching by MID only (for municipality-level files)
        const midKey = `mid:${mid}`;
        if (svgIndex.has(midKey)) {
          // This is a municipality-level file, not settlement-level
          // We'll skip it for now as we need settlement-level matching
        }
      }
    }
  }
  
  // Handle conflicts: one SVG matching multiple settlements
  for (const [svgSource, sids] of svgToSettlements.entries()) {
    if (sids.length > 1) {
      // Multiple settlements want same SVG - assign to lowest SID
      sids.sort((a, b) => {
        const aNum = parseInt(a, 10) || 0;
        const bNum = parseInt(b, 10) || 0;
        return aNum - bNum;
      });
      
      const assignedSid = sids[0];
      const entry = settlementMatches.get(assignedSid)!.entry;
      
      // Remove matches for other SIDs
      for (let i = 1; i < sids.length; i++) {
        const otherSid = sids[i];
        const otherMatch = settlementMatches.get(otherSid);
        if (otherMatch) {
          settlementMatches.delete(otherSid);
          report.conflicts_rejected.push({
            svg_source: svgSource,
            key: otherMatch.method === 'sid' ? `sid:${otherSid}` : `midname:...`,
            matched_sids: sids,
            assigned_to: assignedSid
          });
        }
      }
      
      usedSVGs.set(svgSource, assignedSid);
    } else {
      usedSVGs.set(svgSource, sids[0]);
    }
  }
  
  // Update totals
  for (const match of settlementMatches.values()) {
    if (match.method === 'sid') {
      report.totals.matched_by_sid++;
    } else {
      report.totals.matched_by_midname++;
    }
  }
  
  // Update master data
  console.log('Updating master data...');
  let arcCount = 0;
  
  for (const muni of masterData.municipalities) {
    for (const settlement of muni.settlements) {
      const sid = settlement.settlement_id;
      const match = settlementMatches.get(sid);
      
      if (match) {
        settlement.svg_path = match.entry.d_concat;
        
        // Update mapping_note
        const noteParts: string[] = [];
        if (settlement.mapping_note) {
          noteParts.push(settlement.mapping_note);
        }
        noteParts.push(`svg_join=${match.method}`);
        settlement.mapping_note = noteParts.join('; ');
        
        // Check for arc commands
        if (match.entry.d_concat.match(/\s+[Aa]\s+/) || match.entry.d_concat.match(/^[Aa]\s+/) || 
            match.entry.d_concat.match(/\s+[Aa]$/)) {
          arcCount++;
        }
      } else {
        // Unmatched
        const mid = muni.municipality_id;
        const name = settlement.name;
        const triedKeys = [`sid:${sid}`, `midname:${mid}:${normalizeName(name)}`];
        
        if (report.unmatched_settlements_sample.length < 100) {
          report.unmatched_settlements_sample.push({
            mid,
            sid,
            name,
            tried_keys: triedKeys
          });
        }
      }
    }
  }
  
  report.totals.settlements_matched = settlementMatches.size;
  report.totals.unmatched_settlements = totalSettlements - settlementMatches.size;
  report.arc_command_stats.count_with_arc = arcCount;
  
  // Find unused SVGs - need to collect all unique SVG files
  const allSVGEntries = new Map<string, SVGEntry>();
  
  // Walk the cache directory to find all SVG files
  const allSVGFiles = await findSVGFiles(CACHE_DIR);
  for (const svgFile of allSVGFiles) {
    const relativePath = svgFile.replace(CACHE_DIR + '\\', '').replace(CACHE_DIR + '/', '');
    
    if (!allSVGEntries.has(relativePath)) {
      // Try to find entry in index
      let foundEntry: SVGEntry | null = null;
      for (const entries of svgIndex.values()) {
        for (const entry of entries) {
          if (entry.svg_source === relativePath) {
            foundEntry = entry;
            break;
          }
        }
        if (foundEntry) break;
      }
      
      if (foundEntry) {
        allSVGEntries.set(relativePath, foundEntry);
      }
    }
  }
  
  for (const [svgSource, entry] of allSVGEntries.entries()) {
    if (!usedSVGs.has(svgSource)) {
      if (report.unused_svg_sample.length < 100) {
        report.unused_svg_sample.push({
          svg_source: svgSource,
          derived_keys: entry.derived_keys
        });
      }
    }
  }
  
  // Write updated master
  await writeFile(MASTER_FILE, JSON.stringify(masterData, null, 2), 'utf8');
  console.log(`  Updated ${MASTER_FILE}\n`);
  
  // Write reports
  console.log('Writing reports...');
  await writeFile(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
  
  // Generate text report
  const txtLines: string[] = [];
  txtLines.push('SVG Join Report');
  txtLines.push('='.repeat(80));
  txtLines.push('');
  txtLines.push('Totals:');
  txtLines.push(`  SVG files: ${report.totals.svg_files}`);
  txtLines.push(`  Settlements total: ${report.totals.settlements_total}`);
  txtLines.push(`  Settlements matched: ${report.totals.settlements_matched}`);
  txtLines.push(`    - Matched by SID: ${report.totals.matched_by_sid}`);
  txtLines.push(`    - Matched by midname: ${report.totals.matched_by_midname}`);
  txtLines.push(`  Unmatched settlements: ${report.totals.unmatched_settlements}`);
  txtLines.push(`  SVGs with arc commands: ${report.arc_command_stats.count_with_arc}`);
  txtLines.push('');
  
  if (report.collisions_resolved.length > 0) {
    txtLines.push(`Collisions resolved: ${report.collisions_resolved.length}`);
    txtLines.push('');
  }
  
  if (report.conflicts_rejected.length > 0) {
    txtLines.push(`Conflicts rejected: ${report.conflicts_rejected.length}`);
    txtLines.push('');
  }
  
  // Top municipalities by unmatched count
  const muniUnmatched = new Map<string, number>();
  for (const muni of masterData.municipalities) {
    let unmatched = 0;
    for (const settlement of muni.settlements) {
      if (!settlementMatches.has(settlement.settlement_id)) {
        unmatched++;
      }
    }
    if (unmatched > 0) {
      muniUnmatched.set(muni.name, unmatched);
    }
  }
  
  const topMunicipalities = Array.from(muniUnmatched.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  
  if (topMunicipalities.length > 0) {
    txtLines.push('Top 30 municipalities by unmatched settlement count:');
    for (const [name, count] of topMunicipalities) {
      txtLines.push(`  ${name}: ${count}`);
    }
    txtLines.push('');
  }
  
  await writeFile(REPORT_TXT, txtLines.join('\n'), 'utf8');
  
  console.log(`  Wrote ${REPORT_JSON}`);
  console.log(`  Wrote ${REPORT_TXT}\n`);
  
  console.log('Join complete!');
  console.log(`  Matched: ${report.totals.settlements_matched} / ${report.totals.settlements_total}`);
  console.log(`  Unmatched: ${report.totals.unmatched_settlements}`);
  console.log(`  SVGs with arcs: ${report.arc_command_stats.count_with_arc}`);
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
