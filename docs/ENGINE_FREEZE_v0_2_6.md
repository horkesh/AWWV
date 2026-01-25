# Engine Freeze Contract v0.2.6 "FROZEN"

**Date**: 2026-01-23  
**Version**: v0.2.6  
**Status**: FROZEN

This document defines the explicit freeze contract for the AWWV engine at v0.2.6. All systems listed below are considered **frozen** and must not be modified without an explicit "unfreeze" process.

## 1. Scope Frozen

The following systems and their mechanics are **frozen** at v0.2.6:

### 1.1 Pressure Generation Rules
- Posture-driven pressure calculation
- Supply modulation of pressure
- Pressure accumulation and persistence
- **Location**: `src/state/front_pressure.ts`, `src/sim/turn_pipeline.ts`

### 1.2 Supply Reachability Rules
- Supply source propagation through adjacency graph
- Reachability computation algorithm
- Supply isolation detection
- **Location**: `src/state/supply_reachability.ts`

### 1.3 Displacement Triggers + Routing + Militia Ceiling Integration
- Displacement trigger conditions (unsupplied pressure, encirclement, breach persistence)
- Displacement routing algorithm (shortest path to friendly supplied municipalities)
- Militia pool recruitment ceiling enforcement
- **Location**: `src/state/displacement.ts`
- **Constants**: See `docs/constants_index.md`

### 1.4 Sustainability Collapse Rules + Negotiation Pressure Increment
- Sustainability degradation calculation (base + accelerators)
- Collapse detection (sustainability_score <= 0)
- Negotiation pressure increment per collapsed municipality
- **Location**: `src/state/sustainability.ts`
- **Constants**: See `docs/constants_index.md`

### 1.5 Exhaustion Rules and Monotonicity
- Exhaustion accumulation per turn
- Work supplied vs unsupplied differentiation
- Exhaustion coupling to negotiation pressure
- Monotonicity guarantee (exhaustion never decreases)
- **Location**: `src/state/exhaustion.ts`

### 1.6 Treaty Acceptance Constraints and Competence Factor Integration
- Acceptance scoring formula (base_will + pressure_factor + reality_factor + guarantee_factor + competence_factor - cost_factor - humiliation_factor - warning_penalty - heldness_factor + trade_fairness_factor)
- Competence utility calculation
- Acceptance constraints (gating-only validators)
- **Location**: `src/state/treaty_acceptance.ts`, `src/state/competence_valuations.ts`, `src/state/acceptance_constraints.ts`

### 1.7 Peace Termination and End_State Snapshot Semantics
- Peace-triggering territorial clauses (`transfer_settlements`, `recognize_control_settlements`)
- End_state snapshot generation (deterministic, no timestamps)
- War termination logic
- **Location**: `src/state/treaty.ts`, `src/state/game_state.ts`

## 2. What is Allowed After Freeze

The following changes are **permitted** without unfreezing:

- **UI/observability**: Changes to dev UI, visualization, diagnostics, reporting
- **New scenarios/fixtures**: Adding new test scenarios or save files for testing
- **Bugfixes**: Fixes that do not change calibrated dynamics (must include regression proof)
- **Documentation clarifications**: Updates to documentation that clarify existing behavior without changing mechanics
- **Code organization**: Refactoring that does not change behavior (e.g., extracting constants to a central file if already duplicated)

## 3. What Requires an Explicit "Unfreeze"

The following changes **require** an explicit unfreeze process:

- **Changing any constants** in displacement or sustainability systems (see `docs/constants_index.md`)
- **Changing turn pipeline ordering**: Modifying the sequence of steps in `src/sim/turn_pipeline.ts`
- **Changing acceptance scoring weights/factors**: Modifying the formula or weights in `src/state/treaty_acceptance.ts`
- **Changing supply/front derivation rules**: Modifying algorithms in `src/state/supply_reachability.ts` or `src/map/front_edges.ts`
- **Adding new mechanics**: Introducing new state or dynamics that affect calibrated systems
- **Changing calibration-validated behavior**: Any change that would cause calibration tests to fail

### Unfreeze Process

To unfreeze:
1. Document the rationale for the change
2. Update this freeze contract with the new version
3. Re-run all calibration tests and document results
4. Update `ARCHITECTURE_SUMMARY.md` with the unfreeze phase entry
5. Update version number in relevant files

## 4. Stable Constants Index

All frozen constants are cataloged in `docs/constants_index.md`. This document provides:
- Exact constant names and values
- File locations
- "Calibration Pass 1 validated" notation

**Do not modify these constants without an explicit unfreeze.**

## 5. Regression Tests

The following regression tests enforce freeze behavior:

- **Freeze constant values test**: `tests/freeze_regression.test.ts` - Asserts displacement and sustainability constants equal frozen expected values
- **Scenario invariants test**: `tests/freeze_regression.test.ts` - Runs calibration fixtures and asserts invariant ranges

These tests serve as "tripwires" to prevent accidental drift.

## 6. Calibration Pass 1 Status

**Status**: ✅ Completed

All five calibration scenario stress-tests pass with current parameters:
1. Prolonged siege (18 turns)
2. Temporary encirclement (8 turns)
3. Corridor lifeline (15 turns)
4. Multi-pocket stress (20 turns)
5. Asymmetric collapse (18 turns)

See `ARCHITECTURE_SUMMARY.md` section "Calibration notes (Calibration Pass 1)" for details.

## 7. Version History

- **v0.2.6 (2026-01-23)**: Initial freeze after Calibration Pass 1 completion
