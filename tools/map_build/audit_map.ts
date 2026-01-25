import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditRawSettlements } from './build_map.js';

const RAW_DIR = resolve('data/raw/map_kit_v1');
const DERIVED_DIR = resolve('data/derived');

async function main(): Promise<void> {
  const settlementsDataPath = resolve(RAW_DIR, 'map_data/bih_settlements_map_data.json');
  const auditReportPath = resolve('data/derived', 'map_raw_audit_report.json');

  const settlementsRaw = JSON.parse(await readFile(settlementsDataPath, 'utf8')) as {
    settlements: unknown[] | Record<string, unknown>;
  };

  const rawSettlements = Array.isArray(settlementsRaw.settlements)
    ? settlementsRaw.settlements
    : Object.entries(settlementsRaw.settlements ?? {}).map(([id, data]) => ({
        id,
        ...(typeof data === 'object' && data ? data : {})
      }));

  const report = auditRawSettlements(rawSettlements);

  await writeFile(auditReportPath, JSON.stringify(report, null, 2), 'utf8');

  process.stdout.write(`Raw map audit complete:\n`);
  process.stdout.write(`  Total records: ${report.total_records}\n`);
  process.stdout.write(`  Unique sids: ${report.unique_sids}\n`);
  process.stdout.write(`  Unique source_ids: ${report.unique_source_ids}\n`);
  process.stdout.write(`  Exact duplicates: ${report.exact_duplicates.length}\n`);
  process.stdout.write(`  Conflicting duplicates: ${report.conflicting_duplicates.length}\n`);
  process.stdout.write(`  Cross-municipality source_ids: ${report.cross_municipality_source_ids.length}\n`);

  if (report.exact_duplicates.length > 0) {
    process.stdout.write(`\nExact duplicates (safe to collapse):\n`);
    for (const dup of report.exact_duplicates) {
      process.stdout.write(`  sid ${dup.sid}: ${dup.records.length} identical occurrence(s)\n`);
    }
  }

  if (report.conflicting_duplicates.length > 0) {
    process.stdout.write(`\nConflicting duplicates (must split):\n`);
    for (const dup of report.conflicting_duplicates) {
      const dHashes = new Set(dup.records.map((r) => r.d_hash));
      process.stdout.write(`  sid ${dup.sid}: ${dup.records.length} occurrence(s) with different d_hash or metadata\n`);
      for (const rec of dup.records) {
        process.stdout.write(`    - source_id: ${rec.source_id}, mun: ${rec.mun}, mun_code: ${rec.mun_code}, d_hash: ${rec.d_hash}\n`);
      }
    }
  }

  if (report.cross_municipality_source_ids.length > 0) {
    process.stdout.write(`\nCross-municipality source_id duplicates (non-fatal, resolved via sid):\n`);
    for (const dup of report.cross_municipality_source_ids) {
      process.stdout.write(`  source_id ${dup.source_id}: ${dup.records.length} occurrence(s) in different municipalities\n`);
      for (const rec of dup.records) {
        process.stdout.write(`    - sid: ${rec.sid}, mun: ${rec.mun}, mun_code: ${rec.mun_code}\n`);
      }
    }
  }

  if (report.exact_duplicates.length > 0 || report.conflicting_duplicates.length > 0) {
    process.stdout.write(`\nNote: Duplicates will be handled appropriately (exact collapsed, conflicting split)\n`);
  } else {
    process.stdout.write(`\nNo duplicate sids found.\n`);
  }
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exitCode = 1;
});
