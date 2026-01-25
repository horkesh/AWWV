/**
 * Determinism Guard Helper: Utility functions for ensuring deterministic outputs
 * 
 * This module provides helper functions for CLI tools that produce artifacts
 * to ensure determinism (no timestamps, stable sorting).
 * 
 * Usage:
 *   import { ensureNoTimestamps, ensureStableSort } from './engineering/determinism_guard';
 */

/**
 * Remove timestamp fields from an object (for artifact generation)
 */
export function removeTimestampFields<T extends Record<string, any>>(obj: T): Omit<T, 'generated_at' | 'created_at' | 'updated_at' | 'timestamp'> {
  const { generated_at, created_at, updated_at, timestamp, ...rest } = obj;
  return rest;
}

/**
 * Ensure an array is sorted deterministically (by a key function)
 */
export function ensureStableSort<T>(arr: T[], keyFn: (item: T) => string | number): T[] {
  return [...arr].sort((a, b) => {
    const keyA = keyFn(a);
    const keyB = keyFn(b);
    if (typeof keyA === 'string' && typeof keyB === 'string') {
      return keyA.localeCompare(keyB);
    }
    return (keyA as number) - (keyB as number);
  });
}

/**
 * Ensure object keys are sorted (for canonical JSON)
 */
export function ensureSortedKeys<T extends Record<string, any>>(obj: T): T {
  const sorted = Object.keys(obj).sort();
  const result = {} as T;
  for (const key of sorted) {
    result[key as keyof T] = obj[key];
  }
  return result;
}

/**
 * Validate that an object has no timestamp fields (throws if found)
 */
export function assertNoTimestamps(obj: any, path: string = ''): void {
  const timestampFields = ['generated_at', 'created_at', 'updated_at', 'timestamp'];
  for (const field of timestampFields) {
    if (field in obj) {
      throw new Error(`Timestamp field '${field}' found in ${path || 'object'}. Remove it for determinism.`);
    }
  }
  
  // Recursively check nested objects (but not arrays of primitives)
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertNoTimestamps(value, path ? `${path}.${key}` : key);
    }
  }
}
