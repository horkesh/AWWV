import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface PolygonFailure {
  sid: string;
  source_id: string;
  mun_code: string;
  mun: string;
  reason: string;
  d?: string;
  d_hash: string;
}

interface PolygonFailuresReport {
  version: string;
  total_failures: number;
  failures: PolygonFailure[];
}

interface FallbackGeometry {
  sid: string;
  source_id: string;
  mun_code: string;
  mun: string;
  geometry_fix_source: string;
  geometry_fix_kind: string;
  reason?: string;
}

interface FallbackGeometriesReport {
  version: string;
  total_fallbacks: number;
  fallbacks: FallbackGeometry[];
}

type FixStrategy = 
  | 'buffer0_polygon_fix'
  | 'convex_hull_from_path'
  | 'replacement_d'
  | 'unknown';

interface FailureWithSuggestion {
  failure: PolygonFailure;
  suggestedStrategy: FixStrategy;
  priority: number;
}

/**
 * Analyze failure reason and suggest fix strategy
 */
function suggestFixStrategy(reason: string): { strategy: FixStrategy; priority: number } {
  const lowerReason = reason.toLowerCase();
  
  // Simplification issues: try convex_hull_from_path (buffer0 already attempted)
  if (lowerReason.includes('simplification')) {
    return { strategy: 'convex_hull_from_path', priority: 1 };
  }
  
  // Invalid geometry, self-intersection, ring issues: try buffer0 first, then convex hull
  if (lowerReason.includes('invalid') || 
      lowerReason.includes('self-intersection') || 
      lowerReason.includes('ring') ||
      lowerReason.includes('buffer')) {
    // buffer0 is usually already tried, so suggest convex_hull_from_path
    return { strategy: 'convex_hull_from_path', priority: 1 };
  }
  
  // Empty, missing, degenerate: go straight to replacement as last resort
  if (lowerReason.includes('empty') || 
      lowerReason.includes('missing') || 
      lowerReason.includes('degenerate') ||
      lowerReason.includes('insufficient')) {
    return { strategy: 'replacement_d', priority: 3 };
  }
  
  // Failed to parse: might work with convex hull
  if (lowerReason.includes('failed to parse') || 
      lowerReason.includes('parse')) {
    return { strategy: 'convex_hull_from_path', priority: 2 };
  }
  
  // Unknown - default to convex_hull_from_path
  return { strategy: 'convex_hull_from_path', priority: 2 };
}

async function main(): Promise<void> {
  const failuresPath = resolve('data/derived/polygon_failures.json');
  const fallbacksPath = resolve('data/derived/fallback_geometries.json');
  
  // Load failures
  let failuresReport: PolygonFailuresReport;
  try {
    const failuresContent = await readFile(failuresPath, 'utf8');
    failuresReport = JSON.parse(failuresContent) as PolygonFailuresReport;
  } catch (err) {
    process.stderr.write(`Error reading ${failuresPath}: ${err}\n`);
    process.stderr.write('Run "npm run map:build" first to generate polygon_failures.json\n');
    process.exitCode = 1;
    return;
  }
  
  // Load fallbacks (optional)
  let fallbacksReport: FallbackGeometriesReport | null = null;
  try {
    const fallbacksContent = await readFile(fallbacksPath, 'utf8');
    fallbacksReport = JSON.parse(fallbacksContent) as FallbackGeometriesReport;
  } catch (err) {
    // Fallbacks might not exist yet, that's okay
  }
  
  // Analyze failures and suggest fixes
  const failuresWithSuggestions: FailureWithSuggestion[] = failuresReport.failures.map(failure => {
    const suggestion = suggestFixStrategy(failure.reason);
    return {
      failure,
      suggestedStrategy: suggestion.strategy,
      priority: suggestion.priority
    };
  });
  
  // Sort by priority (lower = better), then by sid
  failuresWithSuggestions.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.failure.sid.localeCompare(b.failure.sid);
  });
  
  // Print header
  process.stdout.write('\n=== Polygon Fix Queue ===\n\n');
  
  // Print failure list with suggestions
  process.stdout.write('Remaining Failures (ranked by suggested fix priority):\n\n');
  
  for (const item of failuresWithSuggestions) {
    const { failure, suggestedStrategy } = item;
    process.stdout.write(`  ${failure.sid.padEnd(15)} | ${failure.mun_code.padEnd(6)} | ${failure.mun.padEnd(25)} | ${failure.reason}\n`);
    process.stdout.write(`  ${' '.repeat(15)} | ${' '.repeat(6)} | ${' '.repeat(25)} → Suggested: ${suggestedStrategy}\n`);
    process.stdout.write('\n');
  }
  
  // Print totals
  process.stdout.write('\n--- Summary ---\n');
  process.stdout.write(`Remaining failures: ${failuresReport.total_failures}\n`);
  
  // Print fallback statistics
  if (fallbacksReport) {
    process.stdout.write(`\nCurrent fallback geometries: ${fallbacksReport.total_fallbacks}\n`);
    
    const byType = new Map<string, number>();
    for (const fb of fallbacksReport.fallbacks) {
      const count = byType.get(fb.geometry_fix_kind) || 0;
      byType.set(fb.geometry_fix_kind, count + 1);
    }
    
    for (const [kind, count] of Array.from(byType.entries()).sort()) {
      process.stdout.write(`  - ${kind}: ${count}\n`);
    }
  } else {
    process.stdout.write('\nNo fallback geometries yet (run map:build to see stats)\n');
  }
  
  // Print suggested fix breakdown
  const suggestionCounts = new Map<FixStrategy, number>();
  for (const item of failuresWithSuggestions) {
    const count = suggestionCounts.get(item.suggestedStrategy) || 0;
    suggestionCounts.set(item.suggestedStrategy, count + 1);
  }
  
  process.stdout.write(`\nSuggested fixes breakdown:\n`);
  for (const [strategy, count] of Array.from(suggestionCounts.entries()).sort((a, b) => {
    // Sort by priority: convex_hull first, then buffer0, then replacement_d
    const order: Record<string, number> = {
      'convex_hull_from_path': 1,
      'buffer0_polygon_fix': 2,
      'replacement_d': 3,
      'unknown': 4
    };
    return (order[a[0]] || 99) - (order[b[0]] || 99);
  })) {
    process.stdout.write(`  - ${strategy}: ${count}\n`);
  }
  
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write('fix_queue failed:\n');
  if (err instanceof Error) {
    process.stderr.write(`${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  process.exitCode = 1;
});