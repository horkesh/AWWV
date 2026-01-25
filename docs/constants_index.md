# Stable Constants Index (v0.2.6 FROZEN)

**Status**: Calibration Pass 1 validated  
**Version**: v0.2.6  
**Freeze Date**: 2026-01-23

This document catalogs all stable constants that are frozen at v0.2.6. **Do not modify these constants without an explicit unfreeze process** (see `docs/ENGINE_FREEZE_v0_2_6.md`).

## Displacement System Constants

**File**: `src/state/displacement.ts`

### Displacement Trigger Constants

- `UNSUPPLIED_PRESSURE_TURNS = 3`
  - **Description**: N consecutive turns without supply required to trigger displacement
  - **Value**: `3`
  - **Line**: 18

- `UNSUPPLIED_DISPLACEMENT_FRACTION = 0.05`
  - **Description**: Fraction of remaining population displaced per turn after N unsupplied turns
  - **Value**: `0.05` (5% per turn)
  - **Line**: 19

- `ENCIRCLEMENT_DISPLACEMENT_FRACTION = 0.10`
  - **Description**: Fraction of remaining population displaced per turn when municipality is encircled
  - **Value**: `0.10` (10% per turn)
  - **Line**: 20

- `BREACH_PERSISTENCE_TURNS = 2`
  - **Description**: M turns of breaches required to trigger displacement
  - **Value**: `2`
  - **Line**: 21

- `BREACH_DISPLACEMENT_FRACTION = 0.03`
  - **Description**: Fraction of remaining population displaced per turn when breaches persist
  - **Value**: `0.03` (3% per turn)
  - **Line**: 22

### Displacement Routing Constants

- `DISPLACEMENT_CAPACITY_FRACTION = 1.5`
  - **Description**: Receiving municipalities can take 150% of original population
  - **Value**: `1.5`
  - **Line**: 25

- `LOST_POPULATION_FRACTION = 0.20`
  - **Description**: 20% of displaced population becomes lost (not routed)
  - **Value**: `0.20` (20%)
  - **Line**: 26

### Sustainability Collapse Integration

- `COLLAPSE_DISPLACEMENT_MULTIPLIER = 1.5`
  - **Description**: 50% increase in displacement rate when municipality is collapsed
  - **Value**: `1.5`
  - **Line**: 29

## Sustainability System Constants

**File**: `src/state/sustainability.ts`

### Sustainability Degradation Constants

- `BASE_DEGRADATION = 5`
  - **Description**: Per-turn degradation when municipality is surrounded
  - **Value**: `5`
  - **Line**: 18

- `UNSUPPLIED_ACCELERATION_THRESHOLD = 2`
  - **Description**: unsupplied_turns >= this triggers acceleration
  - **Value**: `2`
  - **Line**: 19

- `UNSUPPLIED_ACCELERATION = 5`
  - **Description**: Additional degradation per turn when unsupplied threshold is met
  - **Value**: `5`
  - **Line**: 20

- `BREACH_DEGRADATION = 3`
  - **Description**: Additional degradation per turn when breaches persist
  - **Value**: `3`
  - **Line**: 21

- `DISPLACEMENT_DEGRADATION_THRESHOLD = 0.25`
  - **Description**: displaced_out / original_population >= this triggers degradation
  - **Value**: `0.25` (25%)
  - **Line**: 22

- `DISPLACEMENT_DEGRADATION = 5`
  - **Description**: Additional degradation per turn when displacement threshold is met
  - **Value**: `5`
  - **Line**: 23

### Authority Degradation Threshold

- `AUTHORITY_DEGRADED_THRESHOLD = 50`
  - **Description**: sustainability_score < this marks authority_degraded (scaffolding, no mechanics yet)
  - **Value**: `50`
  - **Line**: 24

### Negotiation Pressure Integration

- `COLLAPSE_PRESSURE_INCREMENT = 1`
  - **Description**: Negotiation pressure increment per collapsed municipality per turn
  - **Value**: `1`
  - **Line**: 27

## Notes

- All constants are defined as `const` in their respective files
- Constants are not exported (internal to their modules)
- Values are integers or decimal numbers as specified
- All constants have been validated through Calibration Pass 1 (see `ARCHITECTURE_SUMMARY.md`)

## Validation

These constants are enforced by regression tests in `tests/freeze_regression.test.ts`:
- Constant values are asserted to match frozen expected values
- Scenario invariants are validated against calibration fixtures
