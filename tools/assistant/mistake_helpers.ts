/**
 * Mistake Log Helpers: Standardized functions for appending mistake log entries
 * 
 * Provides helper functions that generate deterministic keys and format entries
 * consistently. All functions are non-throwing (warnings only).
 * 
 * Usage:
 *   import { recordDataIssue, recordAssumptionInvalidated, recordToolingIssue } from "./assistant/mistake_helpers";
 *   
 *   recordDataIssue({
 *     area: "settlement_metadata",
 *     issue: "duplicate_sid",
 *     date: "2026-01-26",
 *     title: "Duplicate settlement IDs detected",
 *     description: "Found 5 settlements with duplicate SID values",
 *     correctiveAction: "Generate deterministic remapped IDs and record in issues report"
 *   });
 */

import { appendMistake, StructuredMistakeEntry } from './mistake_guard';

/**
 * Generate a deterministic mistake key from parts
 * 
 * @param parts Array of string parts to join (e.g., ["data", "settlement", "duplicate_sid"])
 * @returns Deterministic key string (e.g., "data.settlement.duplicate_sid")
 */
export function makeMistakeKey(parts: string[]): string {
  // Filter out empty parts and trim all parts
  const filtered = parts
    .map(p => String(p).trim())
    .filter(p => p.length > 0);
  
  if (filtered.length === 0) {
    console.warn('Warning: makeMistakeKey called with all empty parts, returning empty key');
    return '';
  }
  
  // Join with "." separator
  return filtered.join('.');
}

/**
 * Record a data issue in the mistake log
 * 
 * @param params Object with area, issue, date, title, description, correctiveAction
 */
export function recordDataIssue(params: {
  area: string;
  issue: string;
  date: string;
  title: string;
  description: string;
  correctiveAction: string;
}): void {
  try {
    const key = makeMistakeKey(['data', params.area, params.issue]);
    const entry: StructuredMistakeEntry = {
      key,
      date: params.date,
      title: params.title,
      description: params.description,
      correctiveAction: params.correctiveAction
    };
    appendMistake(entry);
  } catch (err) {
    console.warn(`Warning: Could not record data issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record an invalidated assumption in the mistake log
 * 
 * @param params Object with area, issue, date, title, description, correctiveAction
 */
export function recordAssumptionInvalidated(params: {
  area: string;
  issue: string;
  date: string;
  title: string;
  description: string;
  correctiveAction: string;
}): void {
  try {
    const key = makeMistakeKey(['assumption', params.area, params.issue]);
    const entry: StructuredMistakeEntry = {
      key,
      date: params.date,
      title: params.title,
      description: params.description,
      correctiveAction: params.correctiveAction
    };
    appendMistake(entry);
  } catch (err) {
    console.warn(`Warning: Could not record invalidated assumption: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record a tooling issue in the mistake log
 * 
 * @param params Object with area, issue, date, title, description, correctiveAction
 */
export function recordToolingIssue(params: {
  area: string;
  issue: string;
  date: string;
  title: string;
  description: string;
  correctiveAction: string;
}): void {
  try {
    const key = makeMistakeKey(['tooling', params.area, params.issue]);
    const entry: StructuredMistakeEntry = {
      key,
      date: params.date,
      title: params.title,
      description: params.description,
      correctiveAction: params.correctiveAction
    };
    appendMistake(entry);
  } catch (err) {
    console.warn(`Warning: Could not record tooling issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}
