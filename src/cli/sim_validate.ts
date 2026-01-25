import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deserializeState } from '../state/serialize.js';
import { validateState } from '../validate/validate.js';
import { loadSettlementGraph } from '../map/settlements.js';
import { validateAllAoRContiguity } from '../validate/aor_contiguity.js';
import { validateFrontSegments } from '../validate/front_segments.js';
import { validateFrontPosture } from '../validate/front_posture.js';
import { validateFrontPostureRegions } from '../validate/front_posture_regions.js';
import { validateFrontPressure } from '../validate/front_pressure.js';
import { validateSupplySources } from '../validate/supply_sources.js';
import { validateFormations } from '../validate/formations.js';
import { validateMilitiaPools } from '../validate/militia_pools.js';
import { validateFactions } from '../validate/factions.js';
import { validateCeasefire } from '../validate/ceasefire.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { getValidMunicipalityIds } from '../map/municipalities.js';

const defaultPath = resolve('saves', 'save_0001.json');

async function main(): Promise<void> {
  const path = process.argv[2] ? resolve(process.argv[2]) : defaultPath;
  const payload = await readFile(path, 'utf8');

  const state = deserializeState(payload);
  const issues = validateState(state);

  // Add AoR contiguity + front segment invariants (derived data only)
  try {
    const graph = await loadSettlementGraph();
    const aorIssues = validateAllAoRContiguity(state, graph);
    issues.push(...aorIssues);

    const frontSegmentIssues = validateFrontSegments(state, graph.edges, { settlementIds: graph.settlements.keys() });
    issues.push(...frontSegmentIssues);

    const postureIssues = validateFrontPosture(state);
    issues.push(...postureIssues);

    const derivedFrontEdges = computeFrontEdges(state, graph.edges);
    const frontRegions = computeFrontRegions(state, derivedFrontEdges);
    const regionPostureIssues = validateFrontPostureRegions(state, frontRegions);
    issues.push(...regionPostureIssues);

    const formationsIssues = validateFormations(state, frontRegions, derivedFrontEdges);
    issues.push(...formationsIssues);

    const pressureIssues = validateFrontPressure(state);
    issues.push(...pressureIssues);

    const supplySourcesIssues = validateSupplySources(state, graph.settlements.keys());
    issues.push(...supplySourcesIssues);

    const validMunicipalityIds = await getValidMunicipalityIds();
    const militiaPoolsIssues = validateMilitiaPools(state, validMunicipalityIds);
    issues.push(...militiaPoolsIssues);

    const factionsIssues = validateFactions(state);
    issues.push(...factionsIssues);

    const ceasefireIssues = validateCeasefire(state, derivedFrontEdges);
    issues.push(...ceasefireIssues);
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'aor.validation_failed',
      message: `Could not load settlement graph for AoR validation: ${err}`
    });
  }

  printReport(path, sortIssues(issues));

  const hasErrors = issues.some((i) => i.severity === 'error');
  if (hasErrors) process.exitCode = 1;

  if (!hasErrors) process.stdout.write('Validation passed.\n');
}

function printReport(path: string, issues: ReturnType<typeof validateState>): void {
  process.stdout.write(`Validating ${path}\n`);
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

function sortIssues<T extends { code: string; message: string; path?: string; severity: string }>(issues: T[]): T[] {
  return [...issues].sort((a, b) => {
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const pathA = a.path ?? '';
    const pathB = b.path ?? '';
    const pathCmp = pathA.localeCompare(pathB);
    if (pathCmp !== 0) return pathCmp;
    const msg = a.message.localeCompare(b.message);
    if (msg !== 0) return msg;
    return a.severity.localeCompare(b.severity);
  });
}

main().catch((err) => {
  console.error('sim:validate failed', err);
  process.exitCode = 1;
});
