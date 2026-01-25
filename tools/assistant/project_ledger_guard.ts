/**
 * Project Ledger Guard: Loads and validates against PROJECT_LEDGER.md
 * 
 * This module loads the project ledger and provides guardrail functions to check
 * if the current task context aligns with the current phase and non-negotiables.
 * 
 * Usage:
 *   import { loadLedger, getLedgerSummary, assertLedgerFresh } from "./assistant/project_ledger_guard";
 *   
 *   loadLedger();
 *   assertLedgerFresh("Rendering polygons on HTML canvas");
 *   const summary = getLedgerSummary();
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LedgerData {
  currentPhase: string;
  nonNegotiables: string[];
  allowedWork: string[];
  disallowedWork: string[];
  nextTasks: string[];
}

let cachedLedger: LedgerData | null = null;

/**
 * Parse the PROJECT_LEDGER.md file into a LedgerData object
 */
export function loadLedger(): LedgerData {
  if (cachedLedger !== null) {
    return cachedLedger;
  }

  const ledgerPath = resolve('docs/PROJECT_LEDGER.md');
  
  try {
    const content = readFileSync(ledgerPath, 'utf8');
    const ledger: LedgerData = {
      currentPhase: '',
      nonNegotiables: [],
      allowedWork: [],
      disallowedWork: [],
      nextTasks: []
    };
    
    // Extract current phase
    const phaseMatch = content.match(/## Current Phase\s*\n\s*\*\*Phase:\*\*\s*(.+?)\s*\n/);
    if (phaseMatch) {
      ledger.currentPhase = phaseMatch[1].trim();
    }
    
    // Extract non-negotiables (numbered list items)
    const nonNegotiableRegex = /^\d+\.\s+(.+?)$/gm;
    const nonNegotiableSection = content.match(/## Non-negotiables\s*\n([\s\S]*?)(?=\n## |$)/);
    if (nonNegotiableSection) {
      const matches = nonNegotiableSection[1].matchAll(nonNegotiableRegex);
      for (const match of matches) {
        ledger.nonNegotiables.push(match[1].trim());
      }
    }
    
    // Extract allowed work (✅ items)
    const allowedSection = content.match(/### ✅ Allowed in Current Phase\s*\n([\s\S]*?)(?=\n### |$)/);
    if (allowedSection) {
      const allowedMatches = allowedSection[1].matchAll(/^-\s+(.+?)$/gm);
      for (const match of allowedMatches) {
        ledger.allowedWork.push(match[1].trim());
      }
    }
    
    // Extract disallowed work (❌ items)
    const disallowedSection = content.match(/### ❌ Disallowed in Current Phase\s*\n([\s\S]*?)(?=\n## |$)/);
    if (disallowedSection) {
      const disallowedMatches = disallowedSection[1].matchAll(/^-\s+(.+?)$/gm);
      for (const match of disallowedMatches) {
        ledger.disallowedWork.push(match[1].trim());
      }
    }
    
    // Extract next tasks (numbered list, top 5)
    const nextTasksSection = content.match(/## Next Tasks \(Top 5\)\s*\n([\s\S]*?)(?=\n## |$)/);
    if (nextTasksSection) {
      const taskMatches = nextTasksSection[1].matchAll(/^\d+\.\s+\*\*(.+?)\*\*\s*-\s*(.+?)$/gm);
      for (const match of taskMatches) {
        ledger.nextTasks.push(`${match[1].trim()}: ${match[2].trim()}`);
      }
    }
    
    cachedLedger = ledger;
    return ledger;
  } catch (err) {
    // If file doesn't exist or can't be read, return empty structure
    // This allows the system to work even if the ledger file is missing
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      cachedLedger = {
        currentPhase: 'UNKNOWN',
        nonNegotiables: [],
        allowedWork: [],
        disallowedWork: [],
        nextTasks: []
      };
      return cachedLedger;
    }
    // For other errors, log and return empty
    console.warn(`Warning: Could not load project ledger: ${err instanceof Error ? err.message : String(err)}`);
    cachedLedger = {
      currentPhase: 'UNKNOWN',
      nonNegotiables: [],
      allowedWork: [],
      disallowedWork: [],
      nextTasks: []
    };
    return cachedLedger;
  }
}

/**
 * Get a short string summary of the ledger
 * Returns: current phase, top 8 non-negotiables, top 5 next tasks
 */
export function getLedgerSummary(): string {
  const ledger = loadLedger();
  
  const parts: string[] = [];
  
  parts.push(`Current Phase: ${ledger.currentPhase || 'UNKNOWN'}`);
  parts.push('');
  parts.push('Top Non-Negotiables:');
  const topNonNegotiables = ledger.nonNegotiables.slice(0, 8);
  if (topNonNegotiables.length === 0) {
    parts.push('  (none listed)');
  } else {
    topNonNegotiables.forEach((item, idx) => {
      parts.push(`  ${idx + 1}. ${item}`);
    });
  }
  
  parts.push('');
  parts.push('Top Next Tasks:');
  const topTasks = ledger.nextTasks.slice(0, 5);
  if (topTasks.length === 0) {
    parts.push('  (none listed)');
  } else {
    topTasks.forEach((task, idx) => {
      parts.push(`  ${idx + 1}. ${task}`);
    });
  }
  
  return parts.join('\n');
}

/**
 * Check if the given context aligns with the current phase
 * Warns (console.warn) if:
 *   - context implies a disallowed phase action
 *   - ledger current phase is missing
 * 
 * @param context A short description of what the current task is doing
 */
export function assertLedgerFresh(context: string): void {
  const ledger = loadLedger();
  const contextLower = context.toLowerCase();
  
  // Warn if phase is missing
  if (!ledger.currentPhase || ledger.currentPhase === 'UNKNOWN') {
    console.warn('WARNING: Project ledger current phase is missing or unknown');
    return;
  }
  
  // Check if context matches any disallowed work patterns
  for (const disallowed of ledger.disallowedWork) {
    const disallowedLower = disallowed.toLowerCase();
    // Simple keyword matching: check if context contains significant words from disallowed work
    const disallowedWords = disallowedLower.split(/\s+/).filter(w => w.length > 3);
    const matches = disallowedWords.some(word => contextLower.includes(word));
    
    if (matches) {
      console.warn(`WARNING: Context may imply disallowed work: "${disallowed}"`);
      console.warn(`Current phase: ${ledger.currentPhase}`);
      console.warn(`Context: ${context}`);
      // Continue execution - this is a guardrail, not a blocker
    }
  }
}

/**
 * Reload ledger from disk (useful if the ledger file was updated)
 */
export function reloadLedger(): void {
  cachedLedger = null;
  loadLedger();
}
