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

const DERIVED_DIR = resolve('data/derived');
const FAILURES_FILE = resolve(DERIVED_DIR, 'polygon_failures.json');

async function main(): Promise<void> {
  try {
    const content = await readFile(FAILURES_FILE, 'utf8');
    const report = JSON.parse(content) as PolygonFailuresReport;

    if (report.total_failures === 0) {
      process.stdout.write('No polygon failures found.\n');
      return;
    }

    process.stdout.write(`\nPolygon Failures (${report.total_failures} total)\n`);
    process.stdout.write('='.repeat(100) + '\n');
    process.stdout.write(
      `${'SID'.padEnd(25)} ${'Source ID'.padEnd(12)} ${'Mun Code'.padEnd(10)} ${'Municipality'.padEnd(25)} ${'Reason'}\n`
    );
    process.stdout.write('-'.repeat(100) + '\n');

    for (const failure of report.failures) {
      const sid = failure.sid.substring(0, 24).padEnd(25);
      const sourceId = failure.source_id.substring(0, 11).padEnd(12);
      const munCode = failure.mun_code.substring(0, 9).padEnd(10);
      const mun = (failure.mun || '').substring(0, 24).padEnd(25);
      const reason = failure.reason.substring(0, 50);
      
      process.stdout.write(`${sid} ${sourceId} ${munCode} ${mun} ${reason}\n`);
    }

    process.stdout.write('='.repeat(100) + '\n');
    process.stdout.write(`\nTo fix a failure, add an entry to data/raw/map_kit_v1/settlement_polygon_fixes_local.json\n`);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`Error: Polygon failures file not found: ${FAILURES_FILE}\n`);
      process.stderr.write(`Run 'npm run map:build' first to generate the failures report.\n`);
    } else {
      process.stderr.write(`Error reading polygon failures: ${err}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write('Failed with unhandled exception:\n');
  if (err instanceof Error) {
    process.stderr.write(`${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  process.exitCode = 1;
  process.exit(1);
});
