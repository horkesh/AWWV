/**
 * Derived State Guard: Detects derived/computed state being serialized
 * 
 * This script performs grep-based checks to ensure derived state fields
 * are not included in state serialization.
 * 
 * Usage:
 *   tsx tools/engineering/check_derived_state.ts
 * 
 * Exit code: 0 if all checks pass, 1 if violations found
 */

import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { readFileSync } from 'node:fs';

loadMistakes();
assertNoRepeat('Audit determinism risks and invariant enforcement points without restructuring architecture');
import { resolve } from 'node:path';
import { glob } from 'glob';

const SERIALIZE_FILE = resolve('src/state/serialize.ts');

// Known derived field patterns (fields that should not be serialized)
// These are computed from other state, not stored
const DERIVED_FIELD_PATTERNS = [
  /front_edges/g, // Computed from front_segments + settlement graph
  /front_regions/g, // Computed from front_edges
  /supply_reachability/g, // Computed from supply sources + adjacency
  /territorial_valuation/g, // Computed from control + graph
  /negotiation_pressure/g, // Computed from exhaustion + sustainability
  /exhaustion_totals/g, // Computed from exhaustion state
  /formation_fatigue/g, // Computed from formations + front activity
  /militia_fatigue/g, // Computed from militia pools + activity
  /commitment_report/g, // Computed from posture + commitment
  /control_flip_proposals/g, // Computed from breaches + state
  /breaches/g, // Computed from front edges + state
];

interface Violation {
  file: string;
  line: number;
  field: string;
  context: string;
}

const violations: Violation[] = [];

/**
 * Check serialize.ts for derived field serialization
 */
function checkSerializeFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    // Look for derived field patterns in serialization code
    for (const pattern of DERIVED_FIELD_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const line = lines[lineNum - 1] || '';
        
        // Skip if in comment
        if (line.trim().startsWith('//') || line.includes('//')) {
          continue;
        }
        
        // Check if this is in a serialization context (not just a function name)
        const beforeMatch = content.substring(Math.max(0, match.index - 50), match.index);
        const afterMatch = content.substring(match.index, Math.min(content.length, match.index + 50));
        
        // If it's in a property access or object literal, it's a violation
        if (beforeMatch.includes('.') || beforeMatch.includes(':') || beforeMatch.includes('[')) {
          violations.push({
            file: filePath,
            line: lineNum,
            field: match[0],
            context: line.trim().substring(0, 100)
          });
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      console.warn(`Warning: Could not read ${filePath}`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log('Checking for derived state serialization...\n');
  
  // Check serialize.ts
  checkSerializeFile(SERIALIZE_FILE);
  
  // Report violations
  if (violations.length > 0) {
    console.error('❌ Found derived state fields in serialization:\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    Field: ${v.field}`);
      console.error(`    Context: ${v.context}`);
      console.error('');
    }
    console.error('Derived state should not be serialized. Compute it from canonical state instead.\n');
    process.exit(1);
  } else {
    console.log('✅ No derived state serialization detected.\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
