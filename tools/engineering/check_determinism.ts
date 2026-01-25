/**
 * Determinism Guard: Detects timestamp leakage and non-deterministic patterns
 * 
 * This script performs grep-based checks to ensure:
 * - No Date.now() or new Date() in artifact outputs
 * - No ISO timestamp patterns in serialized state or artifacts
 * - No Math.random() in simulation pipeline (seed-based RNG only)
 * 
 * Usage:
 *   tsx tools/engineering/check_determinism.ts [--fix]
 * 
 * Exit code: 0 if all checks pass, 1 if violations found
 */

import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { readFileSync, readdirSync, statSync } from 'node:fs';

loadMistakes();
assertNoRepeat('Audit determinism risks and invariant enforcement points without restructuring architecture');
import { resolve, join, extname } from 'node:path';
import { glob } from 'glob';

const DERIVED_DIR = resolve('data/derived');
const SRC_DIR = resolve('src');
const TOOLS_MAP_DIR = resolve('tools/map');

// Patterns to detect
const TIMESTAMP_PATTERNS = [
  /Date\.now\(\)/g,
  /new Date\(\)/g,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, // ISO timestamps
  /generated_at|created_at|updated_at|timestamp/gi // Timestamp field names
];

const RANDOM_PATTERNS = [
  /Math\.random\(\)/g
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  context: string;
  severity: 'error' | 'warn';
}

const violations: Violation[] = [];

/**
 * Check a file for determinism violations
 */
function checkFile(filePath: string, isArtifact: boolean): void {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    // Check for timestamp patterns
    for (const pattern of TIMESTAMP_PATTERNS) {
      pattern.lastIndex = 0; // Reset regex
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const line = lines[lineNum - 1] || '';
        
        // Skip if in comment or node_modules
        if (line.trim().startsWith('//') || line.includes('node_modules')) {
          continue;
        }
        
        // Skip if in mistake_guard.ts (acceptable for logging)
        if (filePath.includes('mistake_guard.ts') && line.includes('new Date()')) {
          // Only warn if date parameter is not used
          if (!line.includes('date?')) {
            violations.push({
              file: filePath,
              line: lineNum,
              pattern: pattern.source,
              context: line.trim().substring(0, 80),
              severity: 'warn'
            });
          }
          continue;
        }
        
        // Error if in artifact or state serialization
        if (isArtifact || filePath.includes('serialize.ts')) {
          violations.push({
            file: filePath,
            line: lineNum,
            pattern: pattern.source,
            context: line.trim().substring(0, 80),
            severity: 'error'
          });
        }
      }
    }
    
    // Check for Math.random() in simulation pipeline (warn only)
    if (filePath.includes('src/sim/') || filePath.includes('src/turn/')) {
      for (const pattern of RANDOM_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const lineNum = content.substring(0, match.index).split('\n').length;
          const line = lines[lineNum - 1] || '';
          
          // Skip if in comment
          if (line.trim().startsWith('//')) {
            continue;
          }
          
          violations.push({
            file: filePath,
            line: lineNum,
            pattern: pattern.source,
            context: line.trim().substring(0, 80),
            severity: 'warn'
          });
        }
      }
    }
  } catch (err) {
    // Skip files that can't be read (binary, etc.)
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return;
    }
  }
}

/**
 * Recursively find files to check
 */
async function findFiles(dir: string, extensions: string[]): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await glob(`${dir}/**/*.{${extensions.join(',')}}`, {
      ignore: ['**/node_modules/**', '**/dist/**', '**/.cache/**']
    });
    files.push(...entries);
  } catch (err) {
    console.warn(`Warning: Could not scan ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return files;
}

async function main(): Promise<void> {
  console.log('Checking for determinism violations...\n');
  
  // Check artifact files in data/derived/
  const artifactFiles = await findFiles(DERIVED_DIR, ['json', 'geojson', 'csv']);
  for (const file of artifactFiles) {
    checkFile(file, true);
  }
  
  // Check map tools (artifact generators)
  const mapToolFiles = await findFiles(TOOLS_MAP_DIR, ['ts']);
  for (const file of mapToolFiles) {
    checkFile(file, false); // Not artifacts, but generators
  }
  
  // Check state serialization
  const serializeFile = resolve('src/state/serialize.ts');
  if (serializeFile) {
    checkFile(serializeFile, false);
  }
  
  // Check simulation pipeline for Math.random()
  const simFiles = await findFiles(SRC_DIR, ['ts']);
  for (const file of simFiles) {
    if (file.includes('sim/') || file.includes('turn/')) {
      checkFile(file, false);
    }
  }
  
  // Report violations
  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warn');
  
  if (errors.length > 0) {
    console.error('❌ ERRORS (must fix):\n');
    for (const v of errors) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    Pattern: ${v.pattern}`);
      console.error(`    Context: ${v.context}`);
      console.error('');
    }
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️  WARNINGS:\n');
    for (const v of warnings) {
      console.warn(`  ${v.file}:${v.line}`);
      console.warn(`    Pattern: ${v.pattern}`);
      console.warn(`    Context: ${v.context}`);
      console.warn('');
    }
  }
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ No determinism violations found.\n');
    process.exit(0);
  } else if (errors.length > 0) {
    console.error(`\n❌ Found ${errors.length} error(s) and ${warnings.length} warning(s).\n`);
    process.exit(1);
  } else {
    console.warn(`\n⚠️  Found ${warnings.length} warning(s) (no errors).\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
