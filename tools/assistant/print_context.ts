/**
 * Print Context CLI: Display project context summary
 * 
 * Prints:
 *   - Project ledger summary (current phase, top non-negotiables, top next tasks)
 *   - Last 5 mistake log entries (titles only)
 * 
 * Usage:
 *   tsx tools/assistant/print_context.ts
 *   npm run context
 */

import { getLedgerSummary } from './project_ledger_guard';
import { loadMistakes } from './mistake_guard';

function main(): void {
  console.log('='.repeat(80));
  console.log('AWWV Project Context Summary');
  console.log('='.repeat(80));
  console.log();
  
  // Print ledger summary
  console.log('PROJECT LEDGER SUMMARY');
  console.log('-'.repeat(80));
  try {
    const summary = getLedgerSummary();
    console.log(summary);
  } catch (err) {
    console.error('Error loading project ledger:', err instanceof Error ? err.message : String(err));
  }
  
  console.log();
  console.log('-'.repeat(80));
  console.log();
  
  // Print last 5 mistake log entries
  console.log('LAST 5 MISTAKE LOG ENTRIES (Titles Only)');
  console.log('-'.repeat(80));
  try {
    const mistakes = loadMistakes();
    const lastFive = mistakes.slice(-5).reverse(); // Most recent first
    
    if (lastFive.length === 0) {
      console.log('  (no mistakes logged)');
    } else {
      lastFive.forEach((mistake, idx) => {
        console.log(`  ${idx + 1}. [${mistake.date}] ${mistake.title}`);
      });
    }
  } catch (err) {
    console.error('Error loading mistake log:', err instanceof Error ? err.message : String(err));
  }
  
  console.log();
  console.log('-'.repeat(80));
  console.log();
  console.log('For full details, see:');
  console.log('  - docs/PROJECT_LEDGER.md');
  console.log('  - docs/ASSISTANT_MISTAKES.log');
  console.log();
}

main();
