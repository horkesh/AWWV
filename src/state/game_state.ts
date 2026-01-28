import type { ArmyLabel } from './identity.js';

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type FactionId = string;

export type FormationId = string;

export type MunicipalityId = string;

export type PostureLevel = 'hold' | 'probe' | 'push';

export interface FormationAssignment {
  kind: 'region' | 'edge';
  region_id?: string;
  edge_id?: string;
}

export interface FormationOpsState {
  fatigue: number; // integer >= 0, irreversible in Phase 10
  last_supplied_turn: number | null; // null or <= current turn
}

export interface FormationState {
  id: FormationId;
  faction: FactionId;
  name: string;
  created_turn: number;
  status: 'active' | 'inactive';
  assignment: FormationAssignment | null;
  tags?: string[]; // optional, descriptive only, no gameplay meaning
  ops?: FormationOpsState; // Phase 10: operational degradation tracking
  force_label?: ArmyLabel; // optional, presentational army label (ARBiH/VRS/HVO) for visibility
}

export interface FrontPostureAssignment {
  edge_id: string;
  posture: PostureLevel;
  // integer >= 0, default 0 (allocation counter; no effects yet)
  weight: number;
}

export interface FrontPostureState {
  // keyed by edge_id
  assignments: Record<string, FrontPostureAssignment>;
}

export interface FrontRegionPostureAssignment {
  region_id: string;
  posture: PostureLevel;
  weight: number;
}

export interface FrontRegionPostureState {
  // keyed by region_id
  assignments: Record<string, { posture: PostureLevel; weight: number }>;
}

export interface FrontPressureState {
  edge_id: string;
  // signed pressure: positive means “side_a advantage”, negative means “side_b advantage”
  // side_a / side_b are derived from current front_edges snapshot when present
  value: number; // integer, can be negative
  max_abs: number; // maximum absolute value observed
  last_updated_turn: number;
}

export interface FrontSegmentState {
  edge_id: string;
  active: boolean;
  created_turn: number;
  since_turn: number;
  last_active_turn: number;
  // Deterministic scaffolding for future static-front hardening (no mechanics yet).
  // consecutive turns currently active (0 if inactive)
  active_streak: number;
  // maximum active_streak ever achieved
  max_active_streak: number;
  // Deterministic scaffolding for future pressure/supply/exhaustion coupling (no mechanics yet).
  // current friction counter (integer >= 0)
  friction: number;
  // maximum friction ever observed (integer >= 0)
  max_friction: number;
}

export interface AuthorityProfile {
  authority: number;
  legitimacy: number;
  control: number;
  logistics: number;
  exhaustion: number;
}

export interface NegotiationState {
  pressure: number; // integer >= 0, monotonically non-decreasing
  last_change_turn: number | null; // null or <= current turn
  // Phase 12A: Negotiation capital (spendable leverage currency)
  capital: number; // integer >= 0, can go up/down
  spent_total: number; // integer >= 0, monotonic
  last_capital_change_turn: number | null; // null or <= current turn
}

export interface FactionState {
  id: FactionId;
  profile: AuthorityProfile;
  // No map yet: keep as generic IDs for future AoR assignment.
  areasOfResponsibility: string[];
  // Input-only field for supply reachability reporting (no gameplay effects yet).
  supply_sources: string[]; // settlement sids
  // Command capacity for Phase 9: integer >= 0, default 0 (no extra capacity configured).
  // If > 0, applies global scaling when total demand exceeds capacity.
  command_capacity?: number;
  // Phase 11A: Negotiation pressure accounting (no deal-making yet).
  negotiation?: NegotiationState;
}

export interface MilitiaPoolState {
  mun_id: MunicipalityId;
  faction: FactionId | null; // null allowed for contested or unassigned in early war
  available: number; // integer >= 0
  committed: number; // integer >= 0, reserved for later conversion to formations
  exhausted: number; // integer >= 0, reserved for later attrition and displacement effects
  updated_turn: number; // integer, last mutation turn, deterministic from state.meta.turn (NOT wall clock)
  tags?: string[]; // optional labels, no mechanics
  fatigue?: number; // Phase 10: integer >= 0, irreversible operational degradation
}

// Phase 21: Population displacement state (per municipality)
export interface DisplacementState {
  mun_id: MunicipalityId;
  original_population: number; // immutable baseline from census or existing data
  displaced_out: number; // cumulative, irreversible (people who left this municipality)
  displaced_in: number; // cumulative (people who arrived from other municipalities)
  lost_population: number; // cumulative (killed, emigrated, unreachable - abstracted)
  last_updated_turn: number; // integer, last mutation turn
}

// Phase 22: Sustainability collapse state (per municipality)
export interface SustainabilityState {
  mun_id: MunicipalityId;
  is_surrounded: boolean;
  unsupplied_turns: number; // integer >= 0, consecutive turns without supply
  sustainability_score: number; // integer 0-100, monotonic decreasing
  collapsed: boolean; // true when sustainability_score <= 0
  last_updated_turn: number; // integer, last mutation turn
}

export interface NegotiationStatus {
  ceasefire_active: boolean;
  ceasefire_since_turn: number | null;
  last_offer_turn: number | null;
}

export interface CeasefireFreezeEntry {
  since_turn: number;
  until_turn: number | null; // null for indefinite
}

export interface StateMeta {
  turn: number;
  seed: string;
}

export interface NegotiationLedgerEntry {
  id: string; // deterministic id: "NLED_<turn>_<faction_id>_<kind>_<seq>"
  turn: number;
  faction_id: string;
  kind: 'gain' | 'spend' | 'adjust';
  amount: number; // integer >= 0
  reason: string; // fixed enum-like string
  meta?: Record<string, number | string>; // optional, keep small and deterministic
}

export type SettlementId = string;
export type PoliticalSideId = FactionId;

// Phase 12C.2: Negotiated control overrides (treaty-based control assignments)
export interface ControlOverrideState {
  side: PoliticalSideId;
  kind: 'treaty_transfer' | 'treaty_recognition';
  treaty_id: string;
  since_turn: number;
}

// Phase 12C.2: Control recognition registry (legal claim without ownership transfer)
export interface ControlRecognitionState {
  side: PoliticalSideId;
  treaty_id: string;
  since_turn: number;
}

// Phase 12C.3: Supply corridor right-of-way (traversal rights without control change)
export interface SupplyCorridorRight {
  id: string; // deterministic
  treaty_id: string;
  beneficiary: PoliticalSideId;
  scope: { kind: 'region'; region_id: string } | { kind: 'edges'; edge_ids: string[] } | { kind: 'settlements'; sids: string[] };
  since_turn: number;
  until_turn: number | null; // null = indefinite
}

export interface SupplyRightsState {
  corridors: SupplyCorridorRight[];
}

// Phase 12D.0: Peace end-state marker
export type EndStateKind = 'peace_treaty';

// Phase 12D.1: End-state snapshot (frozen final outcome)
// Phase 13A.0: Added competences array
export interface EndStateSnapshot {
  turn: number;
  // Canonical control outcome
  controllers: Array<[number, string]>; // sorted by sid asc, includes BRCKO_CONTROLLER_ID if applicable
  settlements_by_controller: Array<[string, number]>; // sorted by controller_id asc
  // Optional summaries, ONLY if already available in state without new mechanics
  exhaustion_totals?: Array<[string, number]>; // per side_id, sorted by side_id
  negotiation_spend?: Array<{ side_id: string; category: string; amount: number }>; // sorted
  // Phase 13A.0: Institutional competences allocated at peace
  competences?: Array<{
    competence: string; // CompetenceId
    holder: string; // PoliticalSideId or special identifier (e.g. "INTERNATIONAL_SUPERVISION")
  }>; // sorted by competence ID
  outcome_hash: string; // sha256 over canonical snapshot object
}

export interface EndState {
  kind: EndStateKind;
  treaty_id: string;
  since_turn: number;
  note?: string;
  snapshot?: EndStateSnapshot; // Phase 12D.1: Frozen snapshot created once at peace entry
}

// Phase 3C: Collapse eligibility state (per faction, per domain)
export interface CollapseEligibilityState {
  // Tier-0: Per-domain eligibility flags (faction-level)
  eligible_authority: boolean;
  eligible_cohesion: boolean;
  eligible_spatial: boolean;
  // Tier-0: Per-domain persistence counters (consecutive turns above threshold)
  persistence_authority: number;
  persistence_cohesion: number;
  persistence_spatial: number;
  // Suppression/immunity flags
  suppressed: boolean;
  immune: boolean;
  // Last updated turn (for determinism)
  last_updated_turn: number;
}

// Phase 3C Tier-1: Per-entity (settlement SID) eligibility state
export interface Tier1EntityEligibilityState {
  // Per-domain eligibility flags
  domains: {
    authority: boolean;
    cohesion: boolean;
    spatial: boolean;
  };
  // Per-domain persistence counters
  persistence: {
    authority: number;
    cohesion: number;
    spatial: number;
  };
  // Suppression/immunity flags
  suppressed: boolean;
  immune: boolean;
  // Optional debug info (keep small)
  debug?: {
    exposure: number;
    gates?: {
      authority?: { threshold_met: boolean; degradation_exists: boolean };
      cohesion?: { threshold_met: boolean; degradation_exists: boolean };
      spatial?: { threshold_met: boolean; degradation_exists: boolean };
    };
  };
}

// Phase 3C: Local strain accumulator (proxy until per-entity exhaustion exists)
export interface LocalStrainState {
  // Per-entity (settlement SID) local strain accumulator
  by_entity: Record<string, number>; // EntityId -> strain value (monotonic, clamped)
}

// Phase 3D: Collapse damage tracks (irreversible degradation per entity per domain)
export interface CollapseDamageState {
  // Per-entity (settlement SID) collapse damage accumulator
  by_entity: Record<string, {
    authority: number; // [0,1] monotonic damage track
    cohesion: number;  // [0,1] monotonic damage track
    spatial: number;   // [0,1] monotonic damage track
  }>;
}

// Phase 3D: Capacity modifiers (derived from collapse damage, consumed by later phases)
export interface CapacityModifiersState {
  // Per-entity (settlement SID) capacity modifiers
  by_sid: Record<string, {
    authority_mult: number;    // [0,1] multiplier for authority/control capacity
    cohesion_mult: number;     // [0,1] multiplier for cohesion/formation capacity
    supply_mult: number;       // [0,1] multiplier for supply throughput
    pressure_cap_mult: number; // [0,1] multiplier for front pressure generation cap
  }>;
}

// Phase 5B: Effective posture exposure (read-only, no new mechanics)
// Exposes intended vs effective posture for visibility/debugging
export interface EffectivePostureExposureState {
  // Per faction, per edge: intended vs effective posture data
  by_faction: Record<FactionId, {
    // Per edge: exposure data
    by_edge: Record<string, {
      // Intended posture (as set by player)
      intended_posture: PostureLevel;
      intended_weight: number; // base_weight from commitment report
      // Effective posture multiplier actually used this turn
      effective_weight: number; // effective_weight from commitment report
      // Raw contributing scalars (diagnostics only)
      friction_factor: number; // [0,1] friction factor from commitment
      commit_points: number; // integer milli-points committed
      // Global capacity factor if applied
      global_factor?: number; // [0,1] global capacity scaling factor
    }>;
  }>;
  // Last updated turn (for determinism)
  last_updated_turn: number;
}

export interface GameState {
  schema_version: number;
  meta: StateMeta;
  factions: FactionState[];
  // Persistent formation roster (scaffolding only; no gameplay effects in this phase)
  formations: Record<FormationId, FormationState>;
  front_segments: Record<string, FrontSegmentState>;
  // scaffolding-only: stored intent/allocation (no resolution yet)
  front_posture: Record<FactionId, FrontPostureState>;
  // player-facing scaffolding: region-level posture assignments, expanded deterministically into per-edge posture
  front_posture_regions: Record<FactionId, FrontRegionPostureState>;
  // scaffolding-only: persistent pressure accumulator per segment (no resolution yet)
  front_pressure: Record<string, FrontPressureState>;
  // municipality-level militia pools (scaffolding only; no gameplay effects in Phase 7)
  militia_pools: Record<MunicipalityId, MilitiaPoolState>;
  // Phase 11B: Negotiation status and ceasefire enforcement
  negotiation_status?: NegotiationStatus;
  ceasefire?: Record<string, CeasefireFreezeEntry>; // keyed by edge_id
  // Phase 12A: Negotiation capital ledger
  negotiation_ledger?: NegotiationLedgerEntry[];
  // Phase 12C.2: Negotiated control overrides (applied after AoR control resolution)
  control_overrides?: Record<SettlementId, ControlOverrideState>;
  // Phase 12C.2: Control recognition registry (legal claim without ownership transfer)
  control_recognition?: Record<SettlementId, ControlRecognitionState>;
  // Phase 12C.3: Supply rights registry (corridor traversal rights)
  supply_rights?: SupplyRightsState;
  // Phase 12D.0: Peace end-state marker (war ends when territorial treaty is applied)
  end_state?: EndState;
  // Phase 21: Population displacement tracking (per municipality)
  displacement_state?: Record<MunicipalityId, DisplacementState>;
  // Phase 22: Sustainability collapse tracking (per municipality)
  sustainability_state?: Record<MunicipalityId, SustainabilityState>;
  // Phase 3C: Collapse eligibility state (per faction, Tier-0)
  collapse_eligibility?: Record<FactionId, CollapseEligibilityState>;
  // Phase 3C Tier-1: Per-entity (settlement SID) eligibility state
  collapse_eligibility_tier1?: Record<string, Tier1EntityEligibilityState>; // EntityId -> Tier1EntityEligibilityState
  // Phase 3C: Local strain accumulator (proxy until per-entity exhaustion exists)
  local_strain?: LocalStrainState;
  // Phase 3D: Collapse damage tracks (irreversible degradation per entity per domain)
  collapse_damage?: CollapseDamageState;
  // Phase 3D: Capacity modifiers (derived from collapse damage, consumed by later phases)
  capacity_modifiers?: CapacityModifiersState;
  // Phase 5B: Effective posture exposure (read-only, no new mechanics)
  effective_posture_exposure?: EffectivePostureExposureState;
  // Phase 5C: Logistics prioritization (player intent injection, no new mechanics)
  // Target ID format: edge_id for edge assignments, region_id for region assignments
  logistics_priority?: Record<FactionId, Record<string, number>>; // target_id -> priority (default 1.0, > 0)
}
