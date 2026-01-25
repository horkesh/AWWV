# A War Without Victory — Architecture summary (v0.2.6)

Phase 22 (v0.2.6) introduces sustainability collapse dynamics for surrounded settlements. This file is the canonical, ordered phase changelog.

## Canonical phase changelog

### Phase 1: Deterministic state core
Canonical IDs, stable serialization, validators, deterministic test harness.

### Phase 2: Settlement substrate ingestion
Load raw settlement records, canonical settlement IDs, SVG-to-polygon pipeline and fixes.

### Phase 3: Settlement polygons + validators
GeoJSON polygons with orphan handling and geometry validation.

### Phase 4: Adjacency graph
Undirected settlement adjacency graph with validators and deterministic derivation.

### Phase 5: Derived front edges
Compute front edges from faction control discontinuities.

### Phase 6: Derived front regions
Connected components of front segments, deterministic region IDs.

### Phase 7: Persistent front segments
Streaks and persistence for front segments and regions.

### Phase 8: Posture system
Per-edge and per-region posture that drives pressure weights.

### Phase 9: Pressure generation
Posture-driven pressure with supply modulation (no tactical combat).

### Phase 10: Supply reachability
Reachability reporting and pressure sustainability modulation.

### Phase 11: Exhaustion
Irreversible exhaustion accumulation; negotiation pressure coupling.

### Phase 12: Control-flip proposals
Deterministic proposal-only flips (no automatic capture).

### Phase 13: Negotiation & treaty system baseline
Negotiation pressure/capital, offer generation, acceptance scoring, territorial valuation, peace ends war, deterministic end_state snapshot.

### Phase 14: Competence catalog + treaty allocation validation
Canonical competence IDs, defence bundle, bundle validation (gating-only).

### Phase 15: Competence valuations in acceptance scoring
Static per-faction competence valuation tables; competence_factor in acceptance breakdown.

### Phase 16: Dev UI guardrails + competence utility
Bundle auto-completion, Brčko completeness gating, peace-trigger visibility, competence utility panel.

### Phase 17: Dev UI diagnostics
Validator status + first rejection_reason; acceptance breakdown visualization (validator-first policy).

### Phase 18: Dev UI presets + lint
Deterministic offer presets and advisory lint panel (no mechanics).

### Phase 19: Consolidation & canon freeze (v0.2.5)
Documentation reconciliation only; no mechanics changes.

### Phase 19.1: Determinism cleanup (v0.2.5)
Removed timestamps from all derived artifacts to enforce determinism.

### Phase 21: Population displacement and recruitment integration (v0.2.6)
Deterministic population displacement system that tracks population movement at the municipality level and permanently reduces local recruitment capacity. Displacement is triggered by sustained pressure without supply, encirclement, and breach persistence. Displaced population is routed deterministically to friendly municipalities with supply access, with excess becoming lost population. Displacement irreversibly reduces militia pool recruitment ceilings and degrades available militia pools proportionally.

### Phase 22: Surrounded settlements, sustainability, and collapse dynamics (v0.2.6)
Deterministic sustainability collapse system that models institutional degradation for surrounded municipalities. Sustainability scores degrade deterministically when municipalities are surrounded, unsupplied, under breach pressure, or experiencing high displacement. Collapse accelerates exhaustion accumulation, amplifies displacement rates, and increases negotiation pressure. Sustainability collapse does not directly flip control but creates irreversible strategic consequences that increase war exhaustion and negotiation pressure.

Phase 22.1 clarified and fixed surround-detection edge cases (no mechanics change).

### Phase 23: Engine freeze & consolidation (v0.2.6 "FROZEN")
Explicit engine freeze and consolidation after Calibration Pass 1 completion. No new mechanics, no parameter tuning, no refactors beyond documentation and structure. Created freeze contract (`docs/ENGINE_FREEZE_v0_2_6.md`), stable constants index (`docs/constants_index.md`), regression tests (`tests/freeze_regression.test.ts`), and engine smoke command (`npm run sim:smoke`). All calibrated systems are frozen and must not be modified without an explicit unfreeze process.

## Calibration notes (Calibration Pass 1)

**Status**: Calibration Pass 1 completed. All five scenario stress-tests pass with current parameters.

### Stable constants

The following constants are considered **stable** after calibration validation:

#### Sustainability system (`src/state/sustainability.ts`)
- `BASE_DEGRADATION = 5` — per turn when surrounded
- `UNSUPPLIED_ACCELERATION_THRESHOLD = 2` — unsupplied_turns >= this triggers acceleration
- `UNSUPPLIED_ACCELERATION = 5` — additional degradation per turn
- `BREACH_DEGRADATION = 3` — additional degradation per turn when breaches persist
- `DISPLACEMENT_DEGRADATION_THRESHOLD = 0.25` — displaced_out / original_population >= this triggers degradation
- `DISPLACEMENT_DEGRADATION = 5` — additional degradation per turn
- `AUTHORITY_DEGRADED_THRESHOLD = 50` — sustainability_score < this marks authority_degraded
- `COLLAPSE_PRESSURE_INCREMENT = 1` — negotiation pressure increment per collapsed municipality per turn

#### Displacement system (`src/state/displacement.ts`)
- `UNSUPPLIED_PRESSURE_TURNS = 3` — N consecutive turns without supply
- `UNSUPPLIED_DISPLACEMENT_FRACTION = 0.05` — 5% per turn after N turns
- `ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10` — 10% per turn when encircled
- `BREACH_PERSISTENCE_TURNS = 2` — M turns of breaches
- `BREACH_DISPLACEMENT_FRACTION = 0.03` — 3% per turn when breaches persist
- `DISPLACEMENT_CAPACITY_FRACTION = 1.5` — receiving municipalities can take 150% of original population
- `LOST_POPULATION_FRACTION = 0.20` — 20% of displaced population becomes lost
- `COLLAPSE_DISPLACEMENT_MULTIPLIER = 1.5` — 50% increase when municipality is collapsed

### Calibration scenarios validated

1. **Prolonged siege** (18 turns): Gradual displacement, sustainability collapse after >= 5 turns, rising negotiation pressure, no automatic control flip.
2. **Temporary encirclement** (8 turns): Partial sustainability loss, no collapse, displacement begins but does not cascade excessively.
3. **Corridor lifeline** (15 turns): Slower sustainability degradation with corridor, reduced displacement, corridor loss has visible impact but not instant collapse.
4. **Multi-pocket stress** (20 turns): Multiple municipalities collapse over time, negotiation pressure accumulates across factions.
5. **Asymmetric collapse** (18 turns): One faction collapses internally while another remains supplied, uneven exhaustion and negotiation leverage.

### Evaluation criteria met

- ✅ No collapse in < 5 turns
- ✅ No displacement > 50% without sustainability collapse
- ✅ Negotiation pressure increases plausibly (not exploding too fast)
- ✅ Gradual, not instantaneous collapse
- ✅ Monotonic degradation (sustainability never increases)
- ✅ Peace emerges from exhaustion and pressure, not artifacts

### Test coverage

Calibration tests are located in `tests/calibration.test.ts` and validate:
- Time-to-collapse (turns)
- Displacement magnitude vs original population
- Negotiation pressure slope
- Absence of sudden discontinuities
- Monotonicity and ordering constraints

**Recommendation**: Constants are stable. Ready to freeze parameters. No tuning required at this time.

**Status**: ✅ **FROZEN** at v0.2.6 (see `docs/ENGINE_FREEZE_v0_2_6.md` for freeze contract)
