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
  key?: string; // Optional de-duplication key
  title: string;
  mistake: string;
  correctRule: string;
  correctBehaviorGoingForward?: string; // If present, indicates issue is fixed and enforced
}

let cachedMistakes: Mistake[] | null = null;

// Track titles appended in this run to prevent duplicates
const appendedThisRun = new Set<string>();

// Track titles warned about in this run to prevent spam
const warnedTitlesThisRun = new Set<string>();

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
    // Updated regex to optionally capture Key: line and CORRECT BEHAVIOR GOING FORWARD
    const entryRegex = /\[(\d{4}-\d{2}-\d{2})\]\s*\n(?:Key:\s*(.+?)\s*\n)?TITLE:\s*(.+?)\s*\nMISTAKE:\s*\n(.+?)\s*\nCORRECT RULE:\s*\n(.+?)(?:\s*\nCORRECT BEHAVIOR GOING FORWARD:\s*\n(.+?))?(?=\n\[|\n*$)/gs;
    
    let match;
    while ((match = entryRegex.exec(content)) !== null) {
      const key = match[2] ? match[2].trim() : undefined;
      const correctBehavior = match[6] ? match[6].trim() : undefined;
      mistakes.push({
        date: match[1],
        key: key,
        title: match[3].trim(),
        mistake: match[4].trim(),
        correctRule: match[5].trim(),
        correctBehaviorGoingForward: correctBehavior
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
    // Skip warnings for mistakes that have been fixed and have "CORRECT BEHAVIOR GOING FORWARD" entries
    if (mistake.correctBehaviorGoingForward) {
      continue; // Issue is fixed and enforced, no need to warn
    }
    
    // Skip if we've already warned about this title in this run
    if (warnedTitlesThisRun.has(mistake.title)) {
      continue;
    }
    
    // Simple keyword matching: check if context contains words from title or mistake description
    const titleWords = mistake.title.toLowerCase().split(/\s+/);
    const mistakeWords = mistake.mistake.toLowerCase().split(/\s+/).filter(w => w.length > 3); // Filter short words
    
    // Check if any significant words from title or mistake appear in context
    const titleMatch = titleWords.some(word => word.length > 3 && contextLower.includes(word));
    const mistakeMatch = mistakeWords.some(word => word.length > 3 && contextLower.includes(word));
    
    if (titleMatch || mistakeMatch) {
      console.warn(`KNOWN PAST MISTAKE DETECTED: ${mistake.title}`);
      console.warn(`RULE: ${mistake.correctRule}`);
      warnedTitlesThisRun.add(mistake.title); // Mark as warned to prevent spam
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
 * Structured mistake entry format
 */
export interface StructuredMistakeEntry {
  key?: string; // Optional de-duplication key
  date: string; // YYYY-MM-DD
  title: string;
  description: string; // Maps to MISTAKE field
  correctiveAction: string; // Maps to CORRECT RULE field
}

/**
 * Mistake entry for recordMistakeOnce and warnIfUnrecorded
 */
export interface MistakeEntry {
  date: string;          // YYYY-MM-DD (supplied by caller, not generated)
  title: string;         // short title
  description: string;    // what happened
  correct_behavior: string; // what to do going forward
}

/**
 * Append a mistake entry to ASSISTANT_MISTAKES.log
 * 
 * Supports two formats:
 * 1. Legacy: raw string entry (backward compatible)
 * 2. New: structured object entry with optional Key field
 * 
 * Prevents duplicates:
 * - Within the same run: uses in-memory Set (by title or key)
 * - Across runs: scans existing log for matching title or key
 * 
 * @param entry Either a raw string entry (legacy) or a structured object entry
 * @param date Optional date string in YYYY-MM-DD format. Only used for legacy string entries.
 *             For determinism, callers should pass the date explicitly.
 */
export function appendMistake(
  entry: string | { title: string; mistake: string; correctRule: string } | StructuredMistakeEntry,
  date?: string
): void {
  const logPath = resolve('docs/ASSISTANT_MISTAKES.log');
  
  // Normalize entry to structured format
  let structured: StructuredMistakeEntry;
  let dedupeKey: string | undefined;
  
  if (typeof entry === 'string') {
    // Legacy string format - parse it (basic parsing, assumes standard format)
    // For backward compatibility, we'll try to extract fields, but this is fragile
    // Better to use structured format
    console.warn('Warning: appendMistake called with raw string. Consider using structured object format.');
    // For now, treat as title-only entry (minimal parsing)
    structured = {
      date: date || new Date().toISOString().split('T')[0],
      title: entry.substring(0, 100), // Truncate for safety
      description: entry,
      correctiveAction: 'See mistake log entry'
    };
    dedupeKey = undefined;
  } else if ('key' in entry && 'date' in entry && 'title' in entry && 'description' in entry && 'correctiveAction' in entry) {
    // New structured format with all fields
    structured = entry as StructuredMistakeEntry;
    dedupeKey = structured.key;
  } else {
    // Legacy object format (title, mistake, correctRule)
    const legacyEntry = entry as { title: string; mistake: string; correctRule: string };
    structured = {
      date: date || new Date().toISOString().split('T')[0],
      title: legacyEntry.title,
      description: legacyEntry.mistake,
      correctiveAction: legacyEntry.correctRule
    };
    dedupeKey = undefined;
  }
  
  // Check if already appended this run (by key if present, else by title)
  const dedupeIdentifier = dedupeKey || structured.title;
  if (appendedThisRun.has(dedupeIdentifier)) {
    return;
  }
  
  // Check if key or title already exists in log file
  if (existsSync(logPath)) {
    try {
      const content = readFileSync(logPath, 'utf8');
      
      // If key is provided, check for duplicate key first
      if (dedupeKey) {
        const keyPattern = new RegExp(`Key:\\s*${dedupeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        if (keyPattern.test(content)) {
          console.warn(`Warning: Mistake with key "${dedupeKey}" already exists in log. Skipping duplicate entry.`);
          appendedThisRun.add(dedupeIdentifier);
          return;
        }
      }
      
      // Check for duplicate title (fallback if no key)
      const titlePattern = new RegExp(`TITLE:\\s*${structured.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      if (titlePattern.test(content)) {
        // Already exists, skip
        appendedThisRun.add(dedupeIdentifier);
        return;
      }
    } catch (err) {
      // If we can't read, proceed with append (file might be corrupted, but we'll try)
      console.warn(`Warning: Could not read mistake log to check duplicates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
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
  
  // Build entry text with optional Key line
  let entryText = `${prefix}[${structured.date}]
`;
  if (dedupeKey) {
    entryText += `Key: ${dedupeKey}
`;
  }
  entryText += `TITLE: ${structured.title}
MISTAKE:
${structured.description}
CORRECT RULE:
${structured.correctiveAction}

`;
  
  // Append to file
  try {
    appendFileSync(logPath, entryText, 'utf8');
    appendedThisRun.add(dedupeIdentifier);
    // Invalidate cache so next loadMistakes() call will reload
    cachedMistakes = null;
  } catch (err) {
    console.warn(`Warning: Could not append mistake to log: ${err instanceof Error ? err.message : String(err)}`);
    // Don't throw - this is non-critical
  }
}

/**
 * Check if a mistake entry with the given title already exists in the log
 */
function titleExistsInLog(title: string): boolean {
  const logPath = resolve('docs/ASSISTANT_MISTAKES.log');
  
  if (!existsSync(logPath)) {
    return false;
  }
  
  try {
    const content = readFileSync(logPath, 'utf8');
    // Check for exact title match (case-insensitive)
    const titlePattern = new RegExp(`TITLE:\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    return titlePattern.test(content);
  } catch (err) {
    // If we can't read, assume it doesn't exist (safer to append than skip)
    return false;
  }
}

/**
 * Record a mistake once - appends to log only if title doesn't already exist
 * 
 * @param entry Mistake entry to record
 * @returns true if entry was appended, false if it already existed
 */
export function recordMistakeOnce(entry: MistakeEntry): boolean {
  const logPath = resolve('docs/ASSISTANT_MISTAKES.log');
  
  // Check if already recorded (by title)
  if (titleExistsInLog(entry.title)) {
    return false;
  }
  
  // Check if already appended this run
  if (appendedThisRun.has(entry.title)) {
    return false;
  }
  
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
  
  // Build entry text in strict format
  const entryText = `${prefix}[${entry.date}]
TITLE: ${entry.title}
MISTAKE:
${entry.description}
CORRECT RULE:
${entry.correct_behavior}

`;
  
  // Append to file
  try {
    appendFileSync(logPath, entryText, 'utf8');
    appendedThisRun.add(entry.title);
    // Invalidate cache so next loadMistakes() call will reload
    cachedMistakes = null;
    return true;
  } catch (err) {
    console.warn(`Warning: Could not append mistake to log: ${err instanceof Error ? err.message : String(err)}`);
    // Don't throw - this is non-critical
    return false;
  }
}

/**
 * Warn if a condition is true and the mistake is not yet recorded
 * 
 * @param condition If true, check if mistake needs to be recorded
 * @param entry Mistake entry to record if condition is true and not already recorded
 * @param context Optional context string for warning messages
 */
export function warnIfUnrecorded(condition: boolean, entry: MistakeEntry, context?: string): void {
  if (!condition) {
    return; // Condition is false, do nothing
  }
  
  const alreadyRecorded = titleExistsInLog(entry.title);
  
  if (!alreadyRecorded) {
    // Not recorded yet - warn and record
    const contextStr = context ? ` [${context}]` : '';
    console.warn(`CONFIRMED MISTAKE (recording): ${entry.title}${contextStr}`);
    recordMistakeOnce(entry);
  } else {
    // Already recorded - only warn if context is provided
    if (context) {
      // Only warn once per run per title
      if (!warnedTitlesThisRun.has(entry.title)) {
        console.warn(`Known mistake already recorded: ${entry.title} [${context}]`);
        warnedTitlesThisRun.add(entry.title);
      }
    }
  }
}
