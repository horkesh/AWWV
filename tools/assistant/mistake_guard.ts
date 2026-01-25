/**
 * Mistake Guard: Prevents repeating known mistakes from ASSISTANT_MISTAKES.log
 * 
 * This module loads past mistakes and provides a guardrail function to check
 * if the current task context matches any known mistake patterns.
 * 
 * Usage:
 *   import { loadMistakes, assertNoRepeat } from "./assistant/mistake_guard";
 *   
 *   const mistakes = loadMistakes();
 *   assertNoRepeat("Rendering polygons on HTML canvas");
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Mistake {
  date: string;
  title: string;
  mistake: string;
  correctRule: string;
}

let cachedMistakes: Mistake[] | null = null;

// Track titles appended in this run to prevent duplicates
const appendedThisRun = new Set<string>();

/**
 * Parse the ASSISTANT_MISTAKES.log file into an array of Mistake objects
 */
export function loadMistakes(): Mistake[] {
  if (cachedMistakes !== null) {
    return cachedMistakes;
  }

  const logPath = resolve('docs/ASSISTANT_MISTAKES.log');
  
  try {
    const content = readFileSync(logPath, 'utf8');
    const mistakes: Mistake[] = [];
    
    // Split by entries (lines starting with [YYYY-MM-DD])
    const entryRegex = /\[(\d{4}-\d{2}-\d{2})\]\s*\nTITLE:\s*(.+?)\s*\nMISTAKE:\s*\n(.+?)\s*\nCORRECT RULE:\s*\n(.+?)(?=\n\[|\n*$)/gs;
    
    let match;
    while ((match = entryRegex.exec(content)) !== null) {
      mistakes.push({
        date: match[1],
        title: match[2].trim(),
        mistake: match[3].trim(),
        correctRule: match[4].trim()
      });
    }
    
    cachedMistakes = mistakes;
    return mistakes;
  } catch (err) {
    // If file doesn't exist or can't be read, return empty array
    // This allows the system to work even if the log file is missing
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      cachedMistakes = [];
      return [];
    }
    // For other errors, log and return empty
    console.warn(`Warning: Could not load mistake log: ${err instanceof Error ? err.message : String(err)}`);
    cachedMistakes = [];
    return [];
  }
}

/**
 * Check if the given context matches any known mistake patterns
 * 
 * @param context A short description of what the current task is doing
 */
export function assertNoRepeat(context: string): void {
  const mistakes = loadMistakes();
  const contextLower = context.toLowerCase();
  
  for (const mistake of mistakes) {
    // Simple keyword matching: check if context contains words from title or mistake description
    const titleWords = mistake.title.toLowerCase().split(/\s+/);
    const mistakeWords = mistake.mistake.toLowerCase().split(/\s+/).filter(w => w.length > 3); // Filter short words
    
    // Check if any significant words from title or mistake appear in context
    const titleMatch = titleWords.some(word => word.length > 3 && contextLower.includes(word));
    const mistakeMatch = mistakeWords.some(word => word.length > 3 && contextLower.includes(word));
    
    if (titleMatch || mistakeMatch) {
      console.warn(`KNOWN PAST MISTAKE DETECTED: ${mistake.title}`);
      console.warn(`RULE: ${mistake.correctRule}`);
      // Continue execution - this is a guardrail, not a blocker
    }
  }
}

/**
 * Reload mistakes from disk (useful if the log file was updated)
 */
export function reloadMistakes(): void {
  cachedMistakes = null;
  loadMistakes();
}

/**
 * Append a mistake entry to ASSISTANT_MISTAKES.log
 * 
 * Prevents duplicates:
 * - Within the same run: uses in-memory Set
 * - Across runs: scans existing log for matching title
 * 
 * @param entry The mistake entry to append
 */
export function appendMistake(entry: { title: string; mistake: string; correctRule: string }): void {
  const logPath = resolve('docs/ASSISTANT_MISTAKES.log');
  
  // Check if already appended this run
  if (appendedThisRun.has(entry.title)) {
    return;
  }
  
  // Check if title already exists in log file
  if (existsSync(logPath)) {
    try {
      const content = readFileSync(logPath, 'utf8');
      // Check for "TITLE: <title>" pattern
      const titlePattern = new RegExp(`TITLE:\\s*${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      if (titlePattern.test(content)) {
        // Already exists, skip
        appendedThisRun.add(entry.title);
        return;
      }
    } catch (err) {
      // If we can't read, proceed with append (file might be corrupted, but we'll try)
      console.warn(`Warning: Could not read mistake log to check duplicates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  // Generate date string (YYYY-MM-DD)
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  
  // Format entry - ensure blank line before new entry if file doesn't end with newline
  let prefix = '';
  if (existsSync(logPath)) {
    try {
      const content = readFileSync(logPath, 'utf8');
      // If file doesn't end with newline, add one for proper spacing
      if (content.length > 0 && !content.endsWith('\n')) {
        prefix = '\n';
      }
    } catch {
      // Ignore - will append anyway
    }
  }
  
  const entryText = `${prefix}[${dateStr}]
TITLE: ${entry.title}
MISTAKE:
${entry.mistake}
CORRECT RULE:
${entry.correctRule}

`;
  
  // Append to file
  try {
    appendFileSync(logPath, entryText, 'utf8');
    appendedThisRun.add(entry.title);
    // Invalidate cache so next loadMistakes() call will reload
    cachedMistakes = null;
  } catch (err) {
    console.error(`Error appending mistake to log: ${err instanceof Error ? err.message : String(err)}`);
    // Don't throw - this is non-critical
  }
}
