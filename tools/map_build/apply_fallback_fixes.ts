import { readFile, writeFile } from 'node:fs/promises';
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

interface LocalFix {
  fix: {
    type: string;
    replacement_d?: string;
    notes?: string;
  };
}

interface LocalFixesFile {
  schema?: number;
  notes?: string;
  fixes: Record<string, LocalFix>;
}

type FixStrategy = 'convex_hull_from_path' | 'replacement_d';

function parseArgs(): { limit: number; strategy: FixStrategy } {
  const args = process.argv.slice(2);
  let limit = 5;
  let strategy: FixStrategy = 'convex_hull_from_path';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit < 1) {
        process.stderr.write('Error: --limit must be a positive integer\n');
        process.exitCode = 1;
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--strategy' && i + 1 < args.length) {
      const strat = args[i + 1];
      if (strat === 'convex_hull_from_path' || strat === 'replacement_d') {
        strategy = strat;
      } else {
        process.stderr.write(`Error: --strategy must be "convex_hull_from_path" or "replacement_d"\n`);
        process.exitCode = 1;
        process.exit(1);
      }
      i++;
    }
  }
  
  return { limit, strategy };
}

async function main(): Promise<void> {
  const { limit, strategy } = parseArgs();
  
  const failuresPath = resolve('data/derived/polygon_failures.json');
  const localFixesPath = resolve('data/raw/map_kit_v1/settlement_polygon_fixes_local.json');
  
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
  
  // Load existing local fixes
  let localFixes: LocalFixesFile;
  try {
    const localFixesContent = await readFile(localFixesPath, 'utf8');
    localFixes = JSON.parse(localFixesContent) as LocalFixesFile;
  } catch (err) {
    // File doesn't exist yet, create new structure
    localFixes = {
      schema: 1,
      notes: 'Local polygon fixes for A War Without Victory. Applied after fixes_pack_v1.',
      fixes: {}
    };
  }
  
  // Ensure fixes object exists
  if (!localFixes.fixes) {
    localFixes.fixes = {};
  }
  
  // Filter failures that don't already have local fixes
  const eligibleFailures = failuresReport.failures.filter(
    failure => !localFixes.fixes[failure.sid]
  );
  
  if (eligibleFailures.length === 0) {
    process.stdout.write('No eligible failures found. All remaining failures already have local fixes.\n');
    return;
  }
  
  // Take first N failures
  const failuresToFix = eligibleFailures.slice(0, limit);
  
  // Add fixes
  const addedSids: string[] = [];
  for (const failure of failuresToFix) {
    if (strategy === 'convex_hull_from_path') {
      localFixes.fixes[failure.sid] = {
        fix: {
          type: 'convex_hull_from_path',
          notes: `Use convex hull of SVG path points as fallback geometry (reason: ${failure.reason})`
        }
      };
    } else if (strategy === 'replacement_d') {
      // For replacement_d, we'd need a replacement path, which we don't have
      // This would require more complex logic, so skip for now
      process.stderr.write(`Warning: replacement_d strategy not yet supported for batch application\n`);
      continue;
    }
    addedSids.push(failure.sid);
  }
  
  if (addedSids.length === 0) {
    process.stdout.write('No fixes were added.\n');
    return;
  }
  
  // Write updated local fixes file
  try {
    await writeFile(localFixesPath, JSON.stringify(localFixes, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`Error writing ${localFixesPath}: ${err}\n`);
    process.exitCode = 1;
    return;
  }
  
  // Print report
  process.stdout.write(`\nApplied ${strategy} fixes to ${addedSids.length} settlement(s):\n`);
  for (const sid of addedSids) {
    const failure = failuresToFix.find(f => f.sid === sid);
    if (failure) {
      process.stdout.write(`  - ${sid} (${failure.mun_code}, ${failure.mun}): ${failure.reason}\n`);
    } else {
      process.stdout.write(`  - ${sid}\n`);
    }
  }
  process.stdout.write(`\nUpdated: ${localFixesPath}\n`);
  process.stdout.write(`Run "npm run map:build" to test the fixes.\n`);
  process.stdout.write(`\n`);
}

main().catch((err) => {
  process.stderr.write('apply_fallback_fixes failed:\n');
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