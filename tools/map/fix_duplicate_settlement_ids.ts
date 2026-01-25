import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface MasterSettlement {
  settlement_id: string;
  name: string;
  total_population: number;
  bosniaks: number;
  croats: number;
  serbs: number;
  others: number;
  settlement_type: string;
  is_urban_center: boolean;
  svg_path: string | null;
  mapping_note: string | null;
}

interface MasterMunicipality {
  id: string;
  name: string;
  settlements: MasterSettlement[];
  [key: string]: unknown;
}

interface MasterMunicipalitiesData {
  metadata: unknown;
  municipalities: MasterMunicipality[];
}

interface SettlementLocation {
  mid: string;
  muniName: string;
  settlement: MasterSettlement;
  path: string; // JSON path for reference
}

interface RemapRecord {
  old_id: string;
  new_id: string;
  municipality_id: string;
  name: string;
}

/**
 * Normalize settlement name: trim, lowercase, remove diacritics
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics
}

/**
 * Check if two settlements are the same (same municipality and normalized name match)
 */
function isSameSettlement(
  loc1: SettlementLocation,
  loc2: SettlementLocation
): boolean {
  // Must be in same municipality
  if (loc1.mid !== loc2.mid) {
    return false;
  }

  // Normalized names must match
  const norm1 = normalizeName(loc1.settlement.name);
  const norm2 = normalizeName(loc2.settlement.name);
  if (norm1 !== norm2) {
    return false;
  }

  // OR census totals must be identical (all fields match)
  const censusMatch =
    loc1.settlement.total_population === loc2.settlement.total_population &&
    loc1.settlement.bosniaks === loc2.settlement.bosniaks &&
    loc1.settlement.croats === loc2.settlement.croats &&
    loc1.settlement.serbs === loc2.settlement.serbs &&
    loc1.settlement.others === loc2.settlement.others;

  return censusMatch;
}

/**
 * FNV-1a 32-bit hash function
 */
function fnv1a32(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash = hash >>> 0; // Convert to unsigned 32-bit
  }
  return hash;
}

/**
 * Generate deterministic unique settlement ID
 */
function generateNewSettlementId(
  mid: string,
  normalizedName: string,
  existingIds: Set<string>
): string {
  const hashInput = `${mid}:${normalizedName}`;
  const hash = fnv1a32(hashInput);
  let candidate = 900000000 + (hash % 90000000);

  // Ensure uniqueness
  let candidateStr = String(candidate);
  while (existingIds.has(candidateStr)) {
    candidate++;
    candidateStr = String(candidate);
    // Safety check to avoid infinite loop
    if (candidate > 999999999) {
      throw new Error(`Cannot generate unique ID for ${mid}:${normalizedName}`);
    }
  }

  return candidateStr;
}

/**
 * Merge two settlement objects (keep best data)
 */
function mergeSettlements(
  keep: MasterSettlement,
  merge: MasterSettlement
): MasterSettlement {
  const merged = { ...keep };

  // Prefer non-null svg_path
  if (!merged.svg_path && merge.svg_path) {
    merged.svg_path = merge.svg_path;
  }

  // Prefer non-null census fields (take most complete set)
  if (merged.total_population === 0 && merge.total_population > 0) {
    merged.total_population = merge.total_population;
    merged.bosniaks = merge.bosniaks;
    merged.croats = merge.croats;
    merged.serbs = merge.serbs;
    merged.others = merge.others;
  }

  // Combine mapping_note
  if (merge.mapping_note) {
    if (merged.mapping_note) {
      merged.mapping_note = `${merged.mapping_note} | ${merge.mapping_note}`;
    } else {
      merged.mapping_note = merge.mapping_note;
    }
  }

  return merged;
}

async function main(): Promise<void> {
  const sourceFile = resolve('data/source/master_municipalities.json');
  const remapFile = resolve('data/source/settlement_id_remap.json');

  console.log('Loading master_municipalities.json...');
  const data: MasterMunicipalitiesData = JSON.parse(
    await readFile(sourceFile, 'utf8')
  );

  // Build map of settlement_id -> locations
  const settlementMap = new Map<string, SettlementLocation[]>();
  const allSettlementIds = new Set<string>();

  for (const muni of data.municipalities) {
    for (const settlement of muni.settlements) {
      const sid = settlement.settlement_id;
      allSettlementIds.add(sid);

      if (!settlementMap.has(sid)) {
        settlementMap.set(sid, []);
      }

      settlementMap.get(sid)!.push({
        mid: muni.id,
        muniName: muni.name,
        settlement,
        path: `municipalities[${data.municipalities.indexOf(muni)}].settlements[${muni.settlements.indexOf(settlement)}]`
      });
    }
  }

  // Find duplicates
  const duplicates = new Map<string, SettlementLocation[]>();
  for (const [sid, locations] of settlementMap.entries()) {
    if (locations.length > 1) {
      duplicates.set(sid, locations);
    }
  }

  if (duplicates.size === 0) {
    console.log('No duplicate settlement IDs found.');
    process.exit(0);
  }

  console.log(`\nFound ${duplicates.size} duplicate settlement ID(s):\n`);

  const remaps: RemapRecord[] = [];
  let hasChanges = false;

  // Process each duplicate
  for (const [sid, locations] of duplicates.entries()) {
    console.log(`\nDuplicate settlement_id: ${sid}`);
    console.log(`  Found ${locations.length} occurrence(s):`);

    for (const loc of locations) {
      console.log(`    - Municipality: ${loc.mid} (${loc.muniName})`);
      console.log(`      Name: ${loc.settlement.name}`);
      console.log(`      Population: ${loc.settlement.total_population}`);
      console.log(`      SVG path: ${loc.settlement.svg_path ? 'present' : 'null'}`);
      console.log(`      Path: ${loc.path}`);
    }

    // Check if all are the same settlement
    // Group by municipality and normalized name to find same settlements
    const sameSettlements: SettlementLocation[] = [locations[0]];
    for (let i = 1; i < locations.length; i++) {
      if (isSameSettlement(locations[0], locations[i])) {
        sameSettlements.push(locations[i]);
      }
    }

    if (sameSettlements.length === locations.length) {
      // All are the same settlement - merge them
      console.log(`  → Same settlement detected (${sameSettlements.length} occurrences). Merging...`);

      // Merge all into first
      let merged = sameSettlements[0].settlement;
      for (let i = 1; i < sameSettlements.length; i++) {
        merged = mergeSettlements(merged, sameSettlements[i].settlement);
      }

      // Update first occurrence
      const muni1 = data.municipalities.find(m => m.id === sameSettlements[0].mid)!;
      const idx1 = muni1.settlements.indexOf(sameSettlements[0].settlement);
      muni1.settlements[idx1] = merged;

      // Remove other occurrences (in reverse order to maintain indices)
      const toRemove = sameSettlements.slice(1).sort((a, b) => {
        const muniA = data.municipalities.find(m => m.id === a.mid)!;
        const muniB = data.municipalities.find(m => m.id === b.mid)!;
        const idxA = muniA.settlements.indexOf(a.settlement);
        const idxB = muniB.settlements.indexOf(b.settlement);
        // Sort by municipality index first, then settlement index
        const muniIdxA = data.municipalities.indexOf(muniA);
        const muniIdxB = data.municipalities.indexOf(muniB);
        if (muniIdxA !== muniIdxB) {
          return muniIdxB - muniIdxA; // Reverse order
        }
        return idxB - idxA; // Reverse order
      });

      for (const loc of toRemove) {
        const muni = data.municipalities.find(m => m.id === loc.mid)!;
        const idx = muni.settlements.indexOf(loc.settlement);
        muni.settlements.splice(idx, 1);
      }

      hasChanges = true;
      console.log(`  ✓ Merged ${sameSettlements.length} occurrences into one, removed ${toRemove.length} duplicate(s).`);
      continue;
    }

    // Different settlements - need to remap
    console.log(`  → Different settlements. Remapping...`);

    // Keep first occurrence, remap the rest
    const [keepLoc, ...remapLocs] = locations;

    for (const remapLoc of remapLocs) {
      const normalizedName = normalizeName(remapLoc.settlement.name);
      const oldId = remapLoc.settlement.settlement_id; // Capture old ID before changing
      const newId = generateNewSettlementId(
        remapLoc.mid,
        normalizedName,
        allSettlementIds
      );

      console.log(`    Remapping: ${remapLoc.settlement.name} (${remapLoc.mid})`);
      console.log(`      Old ID: ${oldId}`);
      console.log(`      New ID: ${newId}`);

      // Record remap BEFORE changing the ID
      remaps.push({
        old_id: oldId,
        new_id: newId,
        municipality_id: remapLoc.mid,
        name: remapLoc.settlement.name
      });

      // Update settlement ID
      const muni = data.municipalities.find(m => m.id === remapLoc.mid)!;
      const idx = muni.settlements.indexOf(remapLoc.settlement);
      muni.settlements[idx].settlement_id = newId;

      // Add mapping note
      const note = `Remapped from ${oldId} due to duplicate ID`;
      if (muni.settlements[idx].mapping_note) {
        muni.settlements[idx].mapping_note = `${muni.settlements[idx].mapping_note} | ${note}`;
      } else {
        muni.settlements[idx].mapping_note = note;
      }

      allSettlementIds.add(newId);
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    console.log('\nNo changes needed (all duplicates are same settlement and will be handled by merge logic).');
    process.exit(0);
  }

  // Write corrected JSON
  console.log('\nWriting corrected master_municipalities.json...');
  await writeFile(
    sourceFile,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  // Write remap file if any remaps were made
  if (remaps.length > 0) {
    console.log(`Writing ${remaps.length} remap record(s) to settlement_id_remap.json...`);
    
    // Load existing remaps if file exists
    let existingRemaps: RemapRecord[] = [];
    try {
      const existing = JSON.parse(await readFile(remapFile, 'utf8'));
      if (Array.isArray(existing)) {
        existingRemaps = existing;
      }
    } catch (err) {
      // File doesn't exist or is invalid, start fresh
    }

    // Merge with existing (avoid duplicates)
    const remapMap = new Map<string, RemapRecord>();
    for (const remap of existingRemaps) {
      remapMap.set(remap.old_id, remap);
    }
    for (const remap of remaps) {
      remapMap.set(remap.old_id, remap);
    }

    const allRemaps = Array.from(remapMap.values());
    allRemaps.sort((a, b) => a.old_id.localeCompare(b.old_id));

    await writeFile(
      remapFile,
      JSON.stringify(allRemaps, null, 2),
      'utf8'
    );
  }

  console.log('\n✓ Fix complete!');
  console.log(`  - Fixed ${duplicates.size} duplicate settlement ID(s)`);
  if (remaps.length > 0) {
    console.log(`  - Created ${remaps.length} remap record(s)`);
  }
}

main().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
