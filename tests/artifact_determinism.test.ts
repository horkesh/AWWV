import assert from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Test that derived artifacts contain no timestamps or wall-clock time fields.
 * This enforces the engine invariant: "Derived artifacts must contain no timestamps or wall-clock time."
 */
test('derived artifacts contain no timestamps', async () => {
  const derivedDir = resolve('data/derived');
  
  // Known derived artifacts that should never contain timestamps
  const artifactFiles = [
    'front_edges.json',
    'front_regions.json',
    'front_breaches.json',
    'control_flip_proposals.json',
    'settlements_index.json',
    'settlement_edges.json',
    'adjacency_report.json',
    'map_build_report.json',
    'map_raw_audit_report.json',
    'polygon_failures.json',
    'fallback_geometries.json',
    'orphans.json'
  ];
  
  // Forbidden field names
  const forbiddenFields = [
    'generated_at',
    'build_timestamp',
    'auditTimestamp',
    'audit_timestamp',
    'timestamp',
    'created_at',
    'updated_at'
  ];
  
  // ISO-8601 timestamp pattern (YYYY-MM-DDTHH:MM:SS)
  const isoTimestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  
  const errors: string[] = [];
  
  for (const artifactFile of artifactFiles) {
    const artifactPath = resolve(derivedDir, artifactFile);
    
    try {
      const content = await readFile(artifactPath, 'utf8');
      const json = JSON.parse(content);
      const serialized = JSON.stringify(json);
      
      // Check for forbidden field names
      for (const field of forbiddenFields) {
        if (serialized.includes(`"${field}"`)) {
          errors.push(`${artifactFile}: contains forbidden field "${field}"`);
        }
      }
      
      // Check for ISO-8601 timestamps
      if (isoTimestampPattern.test(serialized)) {
        errors.push(`${artifactFile}: contains ISO-8601 timestamp pattern`);
      }
      
    } catch (err) {
      // File doesn't exist - that's okay, skip it
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Other errors should be reported
        errors.push(`${artifactFile}: error reading file: ${err}`);
      }
    }
  }
  
  if (errors.length > 0) {
    assert.fail(`Found timestamps in derived artifacts:\n${errors.join('\n')}`);
  }
});
