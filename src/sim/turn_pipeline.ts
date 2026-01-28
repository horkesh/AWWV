import { GameState } from '../state/game_state.js';
import { EdgeRecord } from '../map/settlements.js';
import { computeFrontEdges } from '../map/front_edges.js';
import { computeFrontRegions } from '../map/front_regions.js';
import { buildAdjacencyMap } from '../map/adjacency_map.js';
import { syncFrontSegments } from '../state/front_segments.js';
import { normalizeFrontPosture } from '../state/front_posture.js';
import { expandRegionPostureToEdges } from '../state/front_posture_regions.js';
import { accumulateFrontPressure, FrontPressureStepReport } from '../state/front_pressure.js';
import { accumulateExhaustion, ExhaustionStats } from '../state/exhaustion.js';
import { applyFormationCommitment, CommitmentStepReport } from '../state/front_posture_commitment.js';
import { updateFormationFatigue, FormationFatigueStepReport } from '../state/formation_fatigue.js';
import { updateMilitiaFatigue, MilitiaFatigueStepReport } from '../state/militia_fatigue.js';
import { updateDisplacement, DisplacementStepReport } from '../state/displacement.js';
import { updateSustainability, SustainabilityStepReport } from '../state/sustainability.js';
import { updateNegotiationPressure, NegotiationPressureStepReport } from '../state/negotiation_pressure.js';
import { updateNegotiationCapital, NegotiationCapitalStepReport } from '../state/negotiation_capital.js';
import {
  generateNegotiationOffers,
  checkOfferAcceptance,
  expireCeasefireEntries,
  applyEnforcementPackage,
  type OfferGenerationReport,
  type AcceptanceReport,
  type EnforcementPackage
} from '../state/negotiation_offers.js';
import { loadSettlementGraph } from '../map/settlements.js';
import {
  getEnablePhase3A,
  loadEnrichedContactGraph,
  buildPressureEligibilityPhase3A,
  buildStateAccessors,
  type Phase3AAuditSummary
} from './pressure/phase3a_pressure_eligibility.js';
import {
  getEnablePhase3ADiffusion,
  runPhase3APressureDiffusion
} from './pressure/phase3a_pressure_diffusion.js';
import {
  getEnablePhase3B,
  applyPhase3BPressureExhaustion,
  type Phase3BExhaustionResult
} from './pressure/phase3b_pressure_exhaustion.js';
import {
  getEnablePhase3C,
  applyPhase3CExhaustionCollapseGating,
  type Phase3CEligibilityResult
} from './pressure/phase3c_exhaustion_collapse_gating.js';
import {
  getEnablePhase3D,
  applyPhase3DCollapseResolution,
  type Phase3DCollapseResolutionResult
} from './collapse/phase3d_collapse_resolution.js';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard.js';

loadMistakes();
assertNoRepeat('wire phase3a weights into bounded negative-sum pressure diffusion and validate via ab harness');
assertNoRepeat('phase3d consumption must apply each modifier exactly once and must ensure all new phase files are tracked before commit');
assertNoRepeat('phase5b must expose existing posture degradation only and must not invent new friction mechanics');
assertNoRepeat('phase5b commit must remain read-only exposure of existing posture degradation and must not introduce new mechanics');

export type Rng = () => number;

export interface TurnInput {
  seed: string;
  settlementEdges?: EdgeRecord[];
  applyNegotiation?: boolean; // Phase 11B: apply accepted negotiation offers
}

export interface TurnReport {
  seed: string;
  phases: { name: string }[];
  region_posture_expansion?: { expanded_edges_count: number };
  formation_fatigue?: FormationFatigueStepReport;
  commitment?: CommitmentStepReport;
  front_pressure?: FrontPressureStepReport;
  exhaustion?: ExhaustionStats;
  militia_fatigue?: MilitiaFatigueStepReport;
  displacement?: DisplacementStepReport; // Phase 21
  sustainability?: SustainabilityStepReport; // Phase 22
  negotiation_pressure?: NegotiationPressureStepReport;
  negotiation_capital?: NegotiationCapitalStepReport; // Phase 12A
  negotiation_offer?: OfferGenerationReport; // Phase 11B
  negotiation_acceptance?: AcceptanceReport; // Phase 11B
  negotiation_apply?: { applied: boolean; freeze_edges_count: number }; // Phase 11B
  phase3a_pressure_eligibility?: Phase3AAuditSummary; // Phase 3A: pressure eligibility audit (feature-gated)
  phase3b_pressure_exhaustion?: Phase3BExhaustionResult; // Phase 3B: pressure → exhaustion coupling (feature-gated)
  phase3c_exhaustion_collapse_gating?: Phase3CEligibilityResult; // Phase 3C: exhaustion → collapse eligibility gating (feature-gated)
  phase3d_collapse_resolution?: Phase3DCollapseResolutionResult; // Phase 3D: collapse resolution (feature-gated)
  end_state_active?: boolean; // Phase 12D.0: true if end_state exists (war ended)
  end_state_info?: { // Phase 12D.1: snapshot info when end_state is active
    kind: string;
    treaty_id: string;
    since_turn: number;
    outcome_hash?: string;
    settlements_by_controller?: Record<string, number>;
  };
}

export interface TurnContext {
  state: GameState;
  rng: Rng;
  input: TurnInput;
  report: TurnReport;
}

export type PhaseHandler = (context: TurnContext) => void | Promise<void>;

interface NamedPhase {
  name: string;
  run: PhaseHandler;
}

const phases: NamedPhase[] = [
  {
    name: 'initialize',
    run: () => {
      // placeholder: ensure deterministic setup stays inside pipeline
    }
  },
  {
    name: 'sync-front-segments',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      syncFrontSegments(context.state, derivedFrontEdges);
    }
  },
  {
    name: 'normalize-front-posture',
    run: (context) => {
      normalizeFrontPosture(context.state);
    }
  },
  {
    name: 'expand-region-posture',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const frontRegions = computeFrontRegions(context.state, derivedFrontEdges);
      context.report.region_posture_expansion = expandRegionPostureToEdges(context.state, frontRegions);
    }
  },
  {
    name: 'update-formation-fatigue',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const frontRegions = computeFrontRegions(context.state, derivedFrontEdges);
      context.report.formation_fatigue = updateFormationFatigue(context.state, derivedFrontEdges, frontRegions, edges);
    }
  },
  {
    name: 'apply-formation-commitment',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const frontRegions = computeFrontRegions(context.state, derivedFrontEdges);
      const { effectivePosture, report } = applyFormationCommitment(
        context.state,
        derivedFrontEdges,
        frontRegions,
        context.report.formation_fatigue,
        edges
      );
      context.report.commitment = report;
      // Store effective posture in context for pressure step (transient, not persisted)
      (context as any).effectivePosture = effectivePosture;
    }
  },
  {
    name: 'expose-effective-posture',
    run: (context) => {
      // Phase 5B: Expose intended vs effective posture (read-only, no new mechanics)
      const commitmentReport = context.report.commitment;
      if (!commitmentReport) return;

      const turn = context.state.meta.turn;
      const exposure: any = {
        by_faction: {},
        last_updated_turn: turn
      };

      // Get effective posture from context (computed in commitment step)
      const effectivePosture = (context as any).effectivePosture as Record<string, any> | undefined;

      // Build exposure from commitment report by_edge audits
      // Match audits to factions by checking base posture assignments and effective posture values
      for (const edgeAudit of commitmentReport.by_edge) {
        const edgeId = edgeAudit.edge_id;
        
        // Find which faction(s) this edge belongs to by checking base posture assignments
        for (const factionId of Object.keys(context.state.front_posture || {})) {
          const assignment = context.state.front_posture[factionId]?.assignments?.[edgeId];
          if (!assignment || assignment.weight === 0) continue;

          // Verify this audit matches this faction by checking effective posture
          const effectiveAssignment = effectivePosture?.[factionId]?.assignments?.[edgeId];
          if (!effectiveAssignment) continue;

          // Match by checking if base_weight and effective_weight align
          if (effectiveAssignment.base_weight !== edgeAudit.base_weight ||
              effectiveAssignment.effective_weight !== edgeAudit.effective_weight) {
            continue; // This audit doesn't match this faction
          }

          if (!exposure.by_faction[factionId]) {
            exposure.by_faction[factionId] = { by_edge: {} };
          }

          // Get global factor from faction totals if applied
          const factionTotal = commitmentReport.by_faction.find((f) => f.faction_id === factionId);
          const globalFactor = factionTotal?.capacity_applied ? factionTotal.global_factor : undefined;

          exposure.by_faction[factionId].by_edge[edgeId] = {
            intended_posture: assignment.posture,
            intended_weight: edgeAudit.base_weight,
            effective_weight: edgeAudit.effective_weight,
            friction_factor: edgeAudit.friction_factor,
            commit_points: edgeAudit.commit_points,
            global_factor: globalFactor
          };
        }
      }

      // Initialize if needed
      if (!context.state.effective_posture_exposure) {
        (context.state as any).effective_posture_exposure = {};
      }
      (context.state as any).effective_posture_exposure = exposure;
    }
  },
  {
    name: 'accumulate-front-pressure',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const adjacencyMap = buildAdjacencyMap(edges);
      const effectivePosture = (context as any).effectivePosture;
      context.report.front_pressure = accumulateFrontPressure(context.state, derivedFrontEdges, adjacencyMap, effectivePosture);
    }
  },
  {
    name: 'accumulate-exhaustion',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const step = context.report.front_pressure;
      if (!step) return;

      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const deltas = new Map<string, number>(Object.entries(step.pressure_deltas));
      const localSupply = new Map<string, { side_a_supplied: boolean; side_b_supplied: boolean }>(
        Object.entries(step.local_supply)
      );

      context.report.exhaustion = accumulateExhaustion(context.state, derivedFrontEdges, deltas, localSupply);
    }
  },
  {
    name: 'phase3a-pressure-eligibility',
    run: async (context) => {
      // Feature-gated: only run if flag is enabled
      if (!getEnablePhase3A()) return;

      try {
        // Load enriched contact graph
        const enrichedGraph = await loadEnrichedContactGraph();
        
        // Build state accessors
        const accessors = buildStateAccessors(context.state);
        
        // Build effective edges with audit enabled
        const result = buildPressureEligibilityPhase3A(
          enrichedGraph,
          context.state,
          accessors,
          true // audit enabled
        );
        
        // Store audit in report (effective edges are in-memory only, not persisted)
        if (result.audit) {
          context.report.phase3a_pressure_eligibility = result.audit;
        }
        
        // Store effective edges in context for potential use by pressure propagation
        (context as any).phase3aEffectiveEdges = result.edgesEffective;
      } catch (err) {
        // If Phase 3A fails, log but don't crash the simulation
        console.warn(`Phase 3A pressure eligibility failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  },
  {
    name: 'phase3a-pressure-diffusion',
    run: (context) => {
      if (!getEnablePhase3A() || !getEnablePhase3ADiffusion()) return;
      const effectiveEdges = (context as { phase3aEffectiveEdges?: unknown }).phase3aEffectiveEdges;
      if (!Array.isArray(effectiveEdges)) return;
      runPhase3APressureDiffusion(context.state, effectiveEdges);
    }
  },
  {
    name: 'phase3b-pressure-exhaustion',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const effectiveEdges = (context as { phase3aEffectiveEdges?: unknown }).phase3aEffectiveEdges;
      const result = applyPhase3BPressureExhaustion(
        context.state,
        derivedFrontEdges,
        Array.isArray(effectiveEdges) ? effectiveEdges : undefined
      );
      context.report.phase3b_pressure_exhaustion = result;
    }
  },
  {
    name: 'phase3c-exhaustion-collapse-gating',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) {
        const result = applyPhase3CExhaustionCollapseGating(context.state);
        context.report.phase3c_exhaustion_collapse_gating = result;
        return;
      }
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      const result = applyPhase3CExhaustionCollapseGating(context.state, derivedFrontEdges);
      context.report.phase3c_exhaustion_collapse_gating = result;
    }
  },
  {
    name: 'phase3d-collapse-resolution',
    run: (context) => {
      const result = applyPhase3DCollapseResolution(context.state);
      context.report.phase3d_collapse_resolution = result;
    }
  },
  {
    name: 'update-militia-fatigue',
    run: async (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const exhaustionReport = context.report.exhaustion;
      if (!exhaustionReport) return;

      // Build exhaustion deltas map
      const exhaustionDeltas = new Map<string, number>();
      for (const f of exhaustionReport.per_faction) {
        if (f.delta > 0) {
          exhaustionDeltas.set(f.faction_id, f.delta);
        }
      }

      // Load settlement graph to get settlements map
      const graph = await loadSettlementGraph();
      context.report.militia_fatigue = updateMilitiaFatigue(context.state, graph.settlements, edges, exhaustionDeltas);
    }
  },
  {
    name: 'update-displacement',
    run: async (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;

      // Load settlement graph to get settlements map
      const graph = await loadSettlementGraph();
      context.report.displacement = updateDisplacement(context.state, graph.settlements, edges);
    }
  },
  {
    name: 'update-sustainability',
    run: async (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;

      // Load settlement graph to get settlements map
      const graph = await loadSettlementGraph();
      context.report.sustainability = updateSustainability(context.state, graph.settlements, edges);
    }
  },
  {
    name: 'update-negotiation-pressure',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);
      context.report.negotiation_pressure = updateNegotiationPressure(
        context.state,
        derivedFrontEdges,
        context.report.exhaustion,
        context.report.formation_fatigue,
        context.report.militia_fatigue,
        context.report.sustainability
      );
    }
  },
  {
    name: 'update-negotiation-capital',
    run: (context) => {
      context.report.negotiation_capital = updateNegotiationCapital(
        context.state,
        context.report.negotiation_pressure,
        context.report.formation_fatigue,
        context.report.negotiation_acceptance
      );
    }
  },
  {
    name: 'expire-ceasefire',
    run: (context) => {
      expireCeasefireEntries(context.state);
    }
  },
  {
    name: 'update-negotiation-offers',
    run: (context) => {
      const edges = context.input.settlementEdges;
      if (!edges) return;
      const derivedFrontEdges = computeFrontEdges(context.state, edges);

      // Generate offers
      const offerReport = generateNegotiationOffers(
        context.state,
        derivedFrontEdges,
        edges,
        context.report.exhaustion,
        context.report.formation_fatigue,
        context.report.militia_fatigue
      );
      context.report.negotiation_offer = offerReport;

      // Check acceptance if offer exists
      if (offerReport.offer) {
        const acceptanceReport = checkOfferAcceptance(
          context.state,
          offerReport.offer,
          derivedFrontEdges,
          edges,
          context.report.exhaustion,
          context.report.formation_fatigue
        );
        context.report.negotiation_acceptance = acceptanceReport;

        // Apply if accepted and flag is set
        if (acceptanceReport.accepted && acceptanceReport.enforcement_package && context.input.applyNegotiation) {
          applyEnforcementPackage(context.state, acceptanceReport.enforcement_package);
          context.report.negotiation_apply = {
            applied: true,
            freeze_edges_count: acceptanceReport.enforcement_package.freeze_edges.length
          };
        } else {
          context.report.negotiation_apply = {
            applied: false,
            freeze_edges_count: 0
          };
        }
      } else {
        context.report.negotiation_acceptance = {
          accepted: false,
          reasons: ['no_offer_generated'],
          enforcement_package: null
        };
        context.report.negotiation_apply = {
          applied: false,
          freeze_edges_count: 0
        };
      }
    }
  },
  {
    name: 'resolve-noop',
    run: () => {
      // placeholder: future resolution work goes here
    }
  }
];

export async function runTurn(state: GameState, input: TurnInput): Promise<{ nextState: GameState; report: TurnReport }> {
  const working = cloneState(state);

  // Phase 12D.0: If end_state exists, short-circuit to report-only mode
  if (working.end_state) {
    // Increment turn but skip all war mutation phases
    working.meta = {
      ...working.meta,
      seed: input.seed,
      turn: working.meta.turn + 1
    };

    const report: TurnReport = {
      seed: input.seed,
      phases: [{ name: 'end_state_active' }],
      end_state_active: true,
      // Phase 12D.1: Include end_state info in report
      end_state_info: {
        kind: working.end_state.kind,
        treaty_id: working.end_state.treaty_id,
        since_turn: working.end_state.since_turn,
        outcome_hash: working.end_state.snapshot?.outcome_hash,
        settlements_by_controller: working.end_state.snapshot
          ? Object.fromEntries(working.end_state.snapshot.settlements_by_controller)
          : undefined
      }
    };

    return { nextState: working, report };
  }

  // Keep turn metadata deterministic and internal to the pipeline.
  working.meta = {
    ...working.meta,
    seed: input.seed,
    turn: working.meta.turn + 1
  };

  const rng = createRng(input.seed);
  const report: TurnReport = { seed: input.seed, phases: [] };
  const context: TurnContext = { state: working, rng, input, report };

  for (const phase of phases) {
    report.phases.push({ name: phase.name });
    await phase.run(context);
  }

  return { nextState: context.state, report };
}

function createRng(seed: string | number): Rng {
  const numericSeed = typeof seed === 'number' ? seed : hashSeed(seed);
  let a = numericSeed >>> 0;

  return function rng(): number {
    // Mulberry32 for fast, deterministic RNG
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function cloneState(state: GameState): GameState {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(state);
  }

  return JSON.parse(JSON.stringify(state)) as GameState;
}
