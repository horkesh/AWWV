import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadSettlementGraph } from '../map/settlements.js';
import { deserializeState, serializeState } from '../state/serialize.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { buildTreatyDraft, createClause } from '../state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../state/treaty_acceptance.js';
import { applyTreaty } from '../state/treaty_apply.js';
import type { TreatyDraft, TreatyScope } from '../state/treaty.js';
import type { TreatyAcceptanceReport } from '../state/treaty_acceptance.js';
import { runTurn } from '../sim/turn_pipeline.js';
import type { FormationFatigueStepReport } from '../state/formation_fatigue.js';
import { canonicalizePoliticalSideId } from '../state/identity.js';
import { validateState } from '../validate/validate.js';
import { computeSettlementValues } from '../state/territorial_valuation.js';
import type { TerritorialValuationReport } from '../state/territorial_valuation.js';

type Command = 'propose' | 'eval' | 'apply';

interface ProposeOptions {
  command: 'propose';
  savePath: string;
  proposer: string;
  turns: number;
  clauses: string[];
  outReportPath: string | null;
  json: boolean;
}

interface EvalOptions {
  command: 'eval';
  savePath: string;
  reportPath: string;
  outReportPath: string | null;
  json: boolean;
}

interface ApplyOptions {
  command: 'apply';
  savePath: string;
  evalPath: string;
  draftPath: string | null;
  outPath: string | null;
  reportOutPath: string | null;
  json: boolean;
}

type CliOptions = ProposeOptions | EvalOptions | ApplyOptions;

/**
 * Parse clause spec: <annex>:<kind>:<targets_csv>:<scope_kind>:<scope_value>[:giver=<SIDE>][:receiver=<SIDE>][:beneficiary=<SIDE>]
 * Examples:
 * - military:freeze_region:VRS:region:R_0012
 * - territorial:recognize_control_settlements:ARBiH:settlements:SID123|SID124
 * - institutional:autonomy_regional:HVO:region:R_0007
 * - territorial:transfer_settlements:VRS|ARBiH:settlements:SID123|SID124:giver=RS:receiver=RBiH
 * - territorial:corridor_right_of_way:VRS|ARBiH:edges:E001|E002:beneficiary=RBiH
 */
function parseClauseSpec(spec: string, clauseIndex: number): {
  annex: 'military' | 'territorial' | 'institutional';
  kind: string;
  targets: string[];
  scope: TreatyScope;
  giver_side?: string;
  receiver_side?: string;
  beneficiary?: string;
} {
  const parts = spec.split(':');
  if (parts.length !== 5 && parts.length !== 7 && parts.length !== 6) {
    throw new Error(`Invalid clause spec format: ${spec} (expected <annex>:<kind>:<targets>:<scope_kind>:<scope_value>[:giver=<SIDE>][:receiver=<SIDE>][:beneficiary=<SIDE>])`);
  }

  const [annexStr, kind, targetsStr, scopeKind, scopeValue, param1, param2] = parts;

  // Validate annex
  if (annexStr !== 'military' && annexStr !== 'territorial' && annexStr !== 'institutional') {
    throw new Error(`Invalid annex: ${annexStr} (expected military, territorial, or institutional)`);
  }
  const annex = annexStr as 'military' | 'territorial' | 'institutional';

  // Parse targets (split by |, sort unique)
  const targets = Array.from(new Set(targetsStr.split('|').filter((t) => t.length > 0))).sort();

  // Parse scope
  let scope: TreatyScope;
  if (scopeKind === 'global') {
    scope = { kind: 'global' };
  } else if (scopeKind === 'region') {
    scope = { kind: 'region', region_id: scopeValue };
  } else if (scopeKind === 'edges') {
    const edgeIds = Array.from(new Set(scopeValue.split('|').filter((e) => e.length > 0))).sort();
    scope = { kind: 'edges', edge_ids: edgeIds };
  } else if (scopeKind === 'settlements') {
    const sids = Array.from(new Set(scopeValue.split('|').filter((s) => s.length > 0))).sort();
    scope = { kind: 'settlements', sids };
  } else if (scopeKind === 'municipalities') {
    const munIds = Array.from(new Set(scopeValue.split('|').filter((m) => m.length > 0))).sort();
    scope = { kind: 'municipalities', mun_ids: munIds };
  } else {
    throw new Error(`Invalid scope kind: ${scopeKind} (expected global, region, edges, settlements, or municipalities)`);
  }

  // Parse giver/receiver for transfer_settlements
  let giverSide: string | undefined;
  let receiverSide: string | undefined;
  let beneficiary: string | undefined;
  if (kind === 'transfer_settlements') {
    if (parts.length !== 7) {
      throw new Error(`transfer_settlements clause requires giver and receiver: ${spec} (expected ...:giver=<SIDE>:receiver=<SIDE>)`);
    }
    if (!param1?.startsWith('giver=')) {
      throw new Error(`Invalid giver format: ${param1} (expected giver=<SIDE>)`);
    }
    if (!param2?.startsWith('receiver=')) {
      throw new Error(`Invalid receiver format: ${param2} (expected receiver=<SIDE>)`);
    }
    const giverValue = param1.substring(6); // after "giver="
    const receiverValue = param2.substring(9); // after "receiver="
    if (!giverValue || !receiverValue) {
      throw new Error(`Missing giver or receiver value in: ${spec}`);
    }
    // Canonicalize political side IDs (ARBiH -> RBiH, VRS -> RS, HVO -> HRHB)
    giverSide = canonicalizePoliticalSideId(giverValue) as string;
    receiverSide = canonicalizePoliticalSideId(receiverValue) as string;
  } else if (kind === 'corridor_right_of_way') {
    if (parts.length !== 6) {
      throw new Error(`corridor_right_of_way clause requires beneficiary: ${spec} (expected ...:beneficiary=<SIDE>)`);
    }
    if (!param1?.startsWith('beneficiary=')) {
      throw new Error(`Invalid beneficiary format: ${param1} (expected beneficiary=<SIDE>)`);
    }
    const beneficiaryValue = param1.substring(12); // after "beneficiary="
    if (!beneficiaryValue) {
      throw new Error(`Missing beneficiary value in: ${spec}`);
    }
    // Canonicalize political side ID
    beneficiary = canonicalizePoliticalSideId(beneficiaryValue) as string;
  } else if (parts.length === 7 || parts.length === 6) {
    throw new Error(`giver/receiver/beneficiary parameters only allowed for transfer_settlements/corridor_right_of_way clauses: ${spec}`);
  }

  return { annex, kind, targets, scope, giver_side: giverSide, receiver_side: receiverSide, beneficiary };
}

function parseArgs(argv: string[]): CliOptions {
  let command: Command | null = null;
  let savePath: string | null = null;
  let reportPath: string | null = null;
  let evalPath: string | null = null;
  let draftPath: string | null = null;
  let proposer: string | null = null;
  let turns: number | null = null;
  const clauses: string[] = [];
  let outReportPath: string | null = null;
  let outPath: string | null = null;
  let reportOutPath: string | null = null;
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === 'propose' || arg === 'eval' || arg === 'apply') {
      if (command !== null) throw new Error(`Duplicate command: ${arg}`);
      command = arg;
      i += 1;
      continue;
    }
    if (arg === '--proposer') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --proposer');
      proposer = next;
      i += 2;
      continue;
    }
    if (arg === '--turns') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --turns');
      turns = Number.parseInt(next, 10);
      if (!Number.isFinite(turns) || turns < 0) {
        throw new Error(`Invalid --turns: ${next} (expected non-negative int)`);
      }
      i += 2;
      continue;
    }
    if (arg === '--clause') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --clause');
      clauses.push(next);
      i += 2;
      continue;
    }
    if (arg === '--report') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --report');
      reportPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--out-report') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out-report');
      outReportPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--eval') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --eval');
      evalPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--draft') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --draft');
      draftPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --out');
      outPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--report-out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --report-out');
      reportOutPath = resolve(next);
      i += 2;
      continue;
    }
    if (arg === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (savePath === null) {
      savePath = resolve(arg);
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    i += 1;
  }

  if (command === null) {
    throw new Error('Usage: npm run sim:treaty <propose|eval|apply> <save.json> [options...]');
  }
  if (savePath === null) {
    throw new Error('Missing save file path');
  }

  if (command === 'propose') {
    if (proposer === null) throw new Error('Missing --proposer for propose command');
    if (turns === null) throw new Error('Missing --turns for propose command');
    if (clauses.length === 0) throw new Error('Missing --clause for propose command (at least one required)');
    return {
      command: 'propose',
      savePath,
      proposer,
      turns,
      clauses,
      outReportPath,
      json
    };
  } else if (command === 'eval') {
    if (reportPath === null) throw new Error('Missing --report for eval command');
    return {
      command: 'eval',
      savePath,
      reportPath,
      outReportPath,
      json
    };
  } else {
    // apply
    if (evalPath === null) throw new Error('Missing --eval for apply command');
    return {
      command: 'apply',
      savePath,
      evalPath,
      draftPath,
      outPath,
      reportOutPath,
      json
    };
  }
}

async function runProposeMode(opts: ProposeOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  // Phase 12C.4: Compute valuation if we have transfer_settlements clauses
  const hasTransferClauses = opts.clauses.some((spec) => spec.includes(':transfer_settlements:'));
  let valuation: TerritorialValuationReport | undefined;
  if (hasTransferClauses) {
    const graph = await loadSettlementGraph();
    valuation = computeSettlementValues(state, graph);
  }

  // Parse clauses
  const clauseObjects = [];
  for (let i = 0; i < opts.clauses.length; i += 1) {
    const spec = opts.clauses[i];
    const parsed = parseClauseSpec(spec, i);
    const clauseId = `CLAUSE_${opts.turns}_${i}`;
    
    // Phase 12C.4: Pass valuation for transfer_settlements
    const valuationOpts =
      parsed.kind === 'transfer_settlements' && valuation && parsed.giver_side && parsed.receiver_side
        ? { valuation, giver_side: parsed.giver_side, receiver_side: parsed.receiver_side }
        : undefined;
    
    const clause = createClause(
      clauseId,
      parsed.annex,
      parsed.kind as any,
      opts.proposer,
      parsed.targets,
      parsed.scope,
      undefined, // tags
      parsed.giver_side,
      parsed.receiver_side,
      parsed.beneficiary,
      valuationOpts
    );
    clauseObjects.push(clause);
  }

  // Build treaty draft
  const draft = buildTreatyDraft(opts.turns, opts.proposer, clauseObjects);

  // Output
  if (opts.json) {
    const output = JSON.stringify(draft, null, 2);
    const outPath = opts.outReportPath ?? resolve('data', 'derived', `treaty_draft_turn_${opts.turns}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output, 'utf8');
    process.stdout.write(`Treaty draft written to ${outPath}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Treaty Draft (Turn ${draft.turn})\n`);
    process.stdout.write(`Treaty ID: ${draft.treaty_id}\n`);
    process.stdout.write(`Proposer: ${draft.proposer_faction_id}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`Clauses (${draft.clauses.length}):\n`);
    for (const clause of draft.clauses) {
      process.stdout.write(`  ${clause.id}: ${clause.annex}:${clause.kind}\n`);
      process.stdout.write(`    Targets: ${clause.target_faction_ids.join(', ')}\n`);
      process.stdout.write(`    Scope: ${JSON.stringify(clause.scope)}\n`);
      process.stdout.write(`    Cost: ${clause.cost}, Impact: ${clause.acceptance_impact}, Burden: ${clause.enforcement_burden}\n`);
    }
    process.stdout.write(`\n`);
    process.stdout.write(`Totals:\n`);
    process.stdout.write(`  Cost: ${draft.totals.cost_total}\n`);
    process.stdout.write(`  Acceptance Impact: ${draft.totals.acceptance_impact_total}\n`);
    process.stdout.write(`  Enforcement Burden: ${draft.totals.enforcement_burden_total}\n`);
    process.stdout.write(`\n`);
    if (draft.package_warnings.length > 0) {
      process.stdout.write(`Warnings:\n`);
      for (const warning of draft.package_warnings) {
        process.stdout.write(`  - ${warning}\n`);
      }
      process.stdout.write(`\n`);
    } else {
      process.stdout.write(`No warnings\n`);
      process.stdout.write(`\n`);
    }

    // Also write JSON if out-report specified
    if (opts.outReportPath) {
      await mkdir(dirname(opts.outReportPath), { recursive: true });
      await writeFile(opts.outReportPath, JSON.stringify(draft, null, 2), 'utf8');
      process.stdout.write(`Treaty draft JSON written to ${opts.outReportPath}\n`);
    }
  }
}

async function runEvalMode(opts: EvalOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const reportPayload = await readFile(opts.reportPath, 'utf8');
  const draft: TreatyDraft = JSON.parse(reportPayload);

  // Validate schema
  if (draft.schema !== 1) {
    throw new Error(`Unsupported treaty draft schema: ${draft.schema}`);
  }

  const graph = await loadSettlementGraph();

  // Run one turn to get current state and reports
  const { nextState, report } = await runTurn(state, { seed: state.meta.seed, settlementEdges: graph.edges });

  // Compute front edges
  const frontEdges = computeFrontEdges(nextState, graph.edges);

  // Get formation fatigue report
  const formationFatigueReport: FormationFatigueStepReport | undefined = report.formation_fatigue;

  // Evaluate acceptance (Phase 12C.4: pass graph for valuation)
  const acceptanceReport = evaluateTreatyAcceptance(nextState, draft, frontEdges, formationFatigueReport, graph);

  // Output
  if (opts.json) {
    const output = JSON.stringify(acceptanceReport, null, 2);
    const outPath = opts.outReportPath ?? resolve('data', 'derived', `treaty_eval_${draft.treaty_id}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output, 'utf8');
    process.stdout.write(`Treaty evaluation written to ${outPath}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Treaty Evaluation (Turn ${acceptanceReport.turn})\n`);
    process.stdout.write(`Treaty ID: ${acceptanceReport.treaty_id}\n`);
    process.stdout.write(`Proposer: ${acceptanceReport.proposer_faction_id}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`Per-Target Acceptance:\n`);
    for (const target of acceptanceReport.per_target) {
      process.stdout.write(`  ${target.faction_id}: ${target.accept ? 'ACCEPT' : 'REJECT'}\n`);
      process.stdout.write(`    Score: ${target.breakdown.total_score}\n`);
      process.stdout.write(`    Breakdown:\n`);
      process.stdout.write(`      Base Will: ${target.breakdown.base_will}\n`);
      process.stdout.write(`      Pressure Factor: +${target.breakdown.pressure_factor}\n`);
      process.stdout.write(`      Reality Factor: +${target.breakdown.reality_factor}\n`);
      process.stdout.write(`      Guarantee Factor: +${target.breakdown.guarantee_factor}\n`);
      process.stdout.write(`      Cost Factor: ${target.breakdown.cost_factor}\n`);
      process.stdout.write(`      Humiliation Factor: -${target.breakdown.humiliation_factor}\n`);
      process.stdout.write(`      Warning Penalty: -${target.breakdown.warning_penalty}\n`);
      process.stdout.write(`      Heldness Factor: ${target.breakdown.heldness_factor}\n`);
      process.stdout.write(`      Trade Fairness Factor: +${target.breakdown.trade_fairness_factor}\n`);
      process.stdout.write(`    Reasons: ${target.reasons.join(', ')}\n`);
    }
    process.stdout.write(`\n`);
    process.stdout.write(`Result: ${acceptanceReport.accepted_by_all_targets ? 'ACCEPTED BY ALL' : 'REJECTED'}\n`);
    if (acceptanceReport.rejecting_factions.length > 0) {
      process.stdout.write(`Rejecting factions: ${acceptanceReport.rejecting_factions.join(', ')}\n`);
    }
    if (acceptanceReport.rejection_reason) {
      process.stdout.write(`Rejection reason: ${acceptanceReport.rejection_reason}\n`);
      if (acceptanceReport.rejection_reason === 'brcko_unresolved') {
        process.stdout.write(`Rejected: Brčko unresolved (special status required for peace)\n`);
      }
    }
    if (acceptanceReport.rejection_details) {
      const d = acceptanceReport.rejection_details;
      const parts = [`constraint_type=${d.constraint_type}`];
      if (d.competences) parts.push(`competences=[${d.competences.join(', ')}]`);
      if (d.competence) parts.push(`competence=${d.competence}`);
      if (d.faction) parts.push(`faction=${d.faction}`);
      if (d.holder) parts.push(`holder=${d.holder}`);
      process.stdout.write(`Rejection details: ${parts.join(', ')}\n`);
    }
    process.stdout.write(`\n`);
    if (acceptanceReport.warnings.length > 0) {
      process.stdout.write(`Warnings:\n`);
      for (const warning of acceptanceReport.warnings) {
        process.stdout.write(`  - ${warning}\n`);
      }
      process.stdout.write(`\n`);
    }
    process.stdout.write(`Totals:\n`);
    process.stdout.write(`  Cost: ${acceptanceReport.totals.cost_total}\n`);
    process.stdout.write(`  Acceptance Impact: ${acceptanceReport.totals.acceptance_impact_total}\n`);
    process.stdout.write(`  Enforcement Burden: ${acceptanceReport.totals.enforcement_burden_total}\n`);

    // Also write JSON if out-report specified
    if (opts.outReportPath) {
      await mkdir(dirname(opts.outReportPath), { recursive: true });
      await writeFile(opts.outReportPath, JSON.stringify(acceptanceReport, null, 2), 'utf8');
      process.stdout.write(`\nTreaty evaluation JSON written to ${opts.outReportPath}\n`);
    }
  }
}

async function runApplyMode(opts: ApplyOptions): Promise<void> {
  const payload = await readFile(opts.savePath, 'utf8');
  const state = deserializeState(payload);

  const evalPayload = await readFile(opts.evalPath, 'utf8');
  const evalReport: TreatyAcceptanceReport = JSON.parse(evalPayload);

  // Validate schema
  if (evalReport.treaty_id === undefined || evalReport.accepted_by_all_targets === undefined) {
    throw new Error('Invalid treaty evaluation report format');
  }

  // Validate accepted_by_all_targets == true
  if (!evalReport.accepted_by_all_targets) {
    throw new Error('Treaty not accepted by all targets, cannot apply');
  }

  // Load treaty draft
  let treatyDraft: TreatyDraft;
  if (opts.draftPath) {
    // Load from separate draft file
    const draftPayload = await readFile(opts.draftPath, 'utf8');
    treatyDraft = JSON.parse(draftPayload);
    if (treatyDraft.schema !== 1) {
      throw new Error(`Unsupported treaty draft schema: ${treatyDraft.schema}`);
    }
    // Validate treaty_id matches
    if (treatyDraft.treaty_id !== evalReport.treaty_id) {
      throw new Error(`Treaty ID mismatch: draft has ${treatyDraft.treaty_id}, eval report has ${evalReport.treaty_id}`);
    }
  } else if ('draft' in evalReport && evalReport.draft) {
    // Embedded draft in eval report
    treatyDraft = evalReport.draft as TreatyDraft;
  } else {
    throw new Error('Missing treaty draft: provide --draft <path> or ensure eval report includes embedded draft');
  }

  // Load settlement graph for territorial apply
  const graph = await loadSettlementGraph();

  // Compute front edges and regions
  const frontEdges = computeFrontEdges(state, graph.edges);
  const frontRegions = computeFrontRegions(state, frontEdges);

  // Apply treaty (military + territorial annexes)
  const { state: updatedState, report } = applyTreaty(state, treatyDraft, evalReport, {
    derivedFrontEdges: frontEdges,
    frontRegions,
    settlementGraph: graph
  });

  // Validate before writing
  const issues = validateState(updatedState);
  if (issues.some((i) => i.severity === 'error')) {
    const errorIssues = issues.filter((i) => i.severity === 'error');
    throw new Error(`Validation failed after treaty apply:\n${errorIssues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  }

  // Write updated save
  const outSavePath = opts.outPath ?? opts.savePath;
  await mkdir(dirname(outSavePath), { recursive: true });
  await writeFile(outSavePath, serializeState(updatedState), 'utf8');

  // Write report if requested
  if (opts.reportOutPath) {
    await mkdir(dirname(opts.reportOutPath), { recursive: true });
    await writeFile(opts.reportOutPath, JSON.stringify(report, null, 2), 'utf8');
  }

  // Output
  if (opts.json) {
    const output = JSON.stringify(report, null, 2);
    const defaultReportPath = opts.reportOutPath ?? resolve('data', 'derived', `treaty_apply_${treatyDraft.treaty_id}.json`);
    if (!opts.reportOutPath) {
      await mkdir(dirname(defaultReportPath), { recursive: true });
      await writeFile(defaultReportPath, output, 'utf8');
    }
    process.stdout.write(`Treaty apply report written to ${opts.reportOutPath ?? defaultReportPath}\n`);
  } else {
    // Human-readable summary
    process.stdout.write(`Treaty Apply Report (Turn ${report.turn})\n`);
    process.stdout.write(`Treaty ID: ${report.treaty_id}\n`);
    process.stdout.write(`Applied: ${report.applied ? 'YES' : 'NO'}\n`);
    if (report.reason) {
      process.stdout.write(`Reason: ${report.reason}\n`);
    }
    if (report.applied || report.military.freeze_edges_added > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(`Military Annex:\n`);
      process.stdout.write(`  Freeze Edges Added: ${report.military.freeze_edges_added}\n`);
      process.stdout.write(`  Freeze Edges Total: ${report.military.freeze_edges_total}\n`);
      process.stdout.write(`  Monitoring Level: ${report.military.monitoring_level}\n`);
      process.stdout.write(`  Duration: ${report.military.duration_turns === 'indefinite' ? 'indefinite' : `${report.military.duration_turns} turns`}\n`);
      process.stdout.write(`\n`);
      if (report.freeze_edges.length > 0) {
        process.stdout.write(`Frozen Edges (${report.freeze_edges.length}):\n`);
        for (const edgeId of report.freeze_edges.slice(0, 10)) {
          process.stdout.write(`  ${edgeId}\n`);
        }
        if (report.freeze_edges.length > 10) {
          process.stdout.write(`  ... and ${report.freeze_edges.length - 10} more\n`);
        }
      }
    }
    if (report.territorial) {
      process.stdout.write(`\n`);
      process.stdout.write(`Territorial Annex:\n`);
      process.stdout.write(`  Transfers Applied: ${report.territorial.applied_transfers}\n`);
      process.stdout.write(`  Recognitions Applied: ${report.territorial.applied_recognitions}\n`);
      process.stdout.write(`  Capital Spent: ${report.territorial.spent_capital}\n`);
      if (report.territorial.transfers.length > 0) {
        process.stdout.write(`\n`);
        process.stdout.write(`Transfers (${report.territorial.transfers.length}):\n`);
        for (const transfer of report.territorial.transfers.slice(0, 10)) {
          process.stdout.write(`  ${transfer.sid}: ${transfer.from} → ${transfer.to}\n`);
        }
        if (report.territorial.transfers.length > 10) {
          process.stdout.write(`  ... and ${report.territorial.transfers.length - 10} more\n`);
        }
      }
      if (report.territorial.recognitions.length > 0) {
        process.stdout.write(`\n`);
        process.stdout.write(`Recognitions (${report.territorial.recognitions.length}):\n`);
        for (const rec of report.territorial.recognitions.slice(0, 10)) {
          process.stdout.write(`  ${rec.sid}: recognized as ${rec.side}\n`);
        }
        if (report.territorial.recognitions.length > 10) {
          process.stdout.write(`  ... and ${report.territorial.recognitions.length - 10} more\n`);
        }
      }
      if (report.territorial.failures && report.territorial.failures.length > 0) {
        process.stdout.write(`\n`);
        process.stdout.write(`Territorial Failures:\n`);
        for (const failure of report.territorial.failures) {
          process.stdout.write(`  - ${failure}\n`);
        }
      }
    }
    if (report.corridor) {
      process.stdout.write(`\n`);
      process.stdout.write(`Corridor Rights (Phase 12C.3):\n`);
      process.stdout.write(`  Corridors Applied: ${report.corridor.applied_corridors}\n`);
      process.stdout.write(`  Capital Spent: ${report.corridor.spent_capital}\n`);
      if (report.corridor.corridors.length > 0) {
        process.stdout.write(`\n`);
        process.stdout.write(`Corridors (${report.corridor.corridors.length}):\n`);
        for (const corridor of report.corridor.corridors.slice(0, 10)) {
          process.stdout.write(`  ${corridor.id}: beneficiary=${corridor.beneficiary}, scope=${corridor.scope_kind}\n`);
        }
        if (report.corridor.corridors.length > 10) {
          process.stdout.write(`  ... and ${report.corridor.corridors.length - 10} more\n`);
        }
      }
      if (report.corridor.failures && report.corridor.failures.length > 0) {
        process.stdout.write(`\n`);
        process.stdout.write(`Corridor Failures:\n`);
        for (const failure of report.corridor.failures) {
          process.stdout.write(`  - ${failure}\n`);
        }
      }
    }
    if (report.warnings.length > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(`Warnings:\n`);
      for (const warning of report.warnings) {
        process.stdout.write(`  - ${warning}\n`);
      }
    }
    process.stdout.write(`\n`);
    process.stdout.write(`Updated save written to ${outSavePath}\n`);
    if (opts.reportOutPath) {
      process.stdout.write(`Apply report written to ${opts.reportOutPath}\n`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === 'propose') {
    await runProposeMode(opts);
  } else if (opts.command === 'eval') {
    await runEvalMode(opts);
  } else {
    await runApplyMode(opts);
  }
}

main().catch((err) => {
  console.error('sim:treaty failed', err);
  process.exitCode = 1;
});
