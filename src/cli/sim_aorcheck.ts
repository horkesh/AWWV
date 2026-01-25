import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { validateAllAoRContiguity } from '../validate/aor_contiguity.js';
import { ValidationIssue } from '../validate/validate.js';

const defaultPath = resolve('saves', 'save_0001.json');

async function main(): Promise<void> {
  const path = process.argv[2] ? resolve(process.argv[2]) : defaultPath;

  try {
    const payload = await readFile(path, 'utf8');
    const state = deserializeState(payload);
    const graph = await loadSettlementGraph();

    process.stdout.write(`Checking AoR contiguity for ${path}\n`);
    process.stdout.write(`Loaded ${graph.settlements.size} settlements, ${graph.edges.length} edges\n`);
    process.stdout.write(`Checking ${state.factions.length} faction(s)\n`);

    const issues = validateAllAoRContiguity(state, graph);

    printReport(issues);

    const hasErrors = issues.some((i) => i.severity === 'error');
    if (hasErrors) {
      process.exitCode = 1;
    } else {
      process.stdout.write('All AoRs are contiguous.\n');
    }
  } catch (err) {
    console.error('sim:aorcheck failed', err);
    process.exitCode = 1;
  }
}

function printReport(issues: ValidationIssue[]): void {
  if (issues.length === 0) {
    process.stdout.write('No issues found.\n');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warn');
  process.stdout.write(`Issues: ${errors.length} error(s), ${warns.length} warning(s)\n`);

  for (const issue of issues) {
    const loc = issue.path ? ` @ ${issue.path}` : '';
    process.stdout.write(`- [${issue.severity.toUpperCase()}] ${issue.code}${loc}: ${issue.message}\n`);
  }
}

main().catch((err) => {
  console.error('sim:aorcheck failed', err);
  process.exitCode = 1;
});
