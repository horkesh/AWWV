/**
 * Name Normalization: Deterministic name normalization for crosswalk matching
 * 
 * Provides functions to normalize settlement names for deterministic matching
 * between Excel metadata and SVG-derived geometry.
 * 
 * Usage:
 *   import { normalizeName, makeJoinKey } from './name_normalize';
 */

/**
 * Normalize a settlement name for deterministic matching
 * 
 * Rules:
 * - lowercase
 * - Unicode NFKD normalize, strip diacritics
 * - replace all non-letter/digit with space
 * - collapse whitespace
 * - trim
 * - DO NOT remove tokens like "selo" etc. (too risky)
 */
export function normalizeName(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  
  return input
    .toLowerCase()
    .normalize('NFKD') // Decompose to base + combining characters
    .replace(/[\u0300-\u036f]/g, '') // Strip diacritics
    .replace(/[^a-z0-9]/g, ' ') // Replace non-letter/digit with space
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}

/**
 * Create a deterministic join key from municipality ID and name
 * 
 * Format: `${mid}|${normalizeName(name)}`
 */
export function makeJoinKey(mid: string | number, name: string): string {
  const midStr = String(mid).trim();
  const normalizedName = normalizeName(name);
  return `${midStr}|${normalizedName}`;
}
