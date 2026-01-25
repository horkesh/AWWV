# Phase 21: Population displacement and recruitment integration — Implementation Summary

## Overview

Phase 21 introduces a deterministic population displacement system that tracks population movement at the municipality level and permanently reduces local recruitment capacity. This is the first post-peace-track expansion, deepening the war simulation before negotiation without introducing tactical combat.

## Files Changed

### Core Implementation
- `src/state/displacement.ts` — New displacement update logic with triggers, routing, and militia pool integration
- `src/state/schema.ts` — Added `DisplacementState` interface
- `src/state/game_state.ts` — Added `DisplacementState` interface and `displacement_state` field to `GameState`

### CLI Tools
- `src/cli/sim_displacement.ts` — New CLI tool for displacement inspection (`list` and `inspect` commands)
- `package.json` — Added `sim:displacement` script

### Turn Pipeline
- `src/sim/turn_pipeline.ts` — Added `update-displacement` phase after `update-militia-fatigue`

### Tests
- `tests/displacement.test.ts` — Tests for determinism, irreversibility, recruitment ceiling enforcement, and routing determinism

### Documentation
- `ARCHITECTURE_SUMMARY.md` — Added Phase 21 entry
- `docs/handoff_map_pipeline.md` — Added displacement section

## Key Features

### Displacement State Structure
- `original_population`: Immutable baseline (from census or existing data)
- `displaced_out`: Cumulative, irreversible (people who left)
- `displaced_in`: Cumulative (people who arrived)
- `lost_population`: Cumulative (killed, emigrated, unreachable)
- `last_updated_turn`: Last mutation turn

### Displacement Triggers (Deterministic)
1. **Sustained pressure without supply**: If a municipality is under pressure AND unsupplied for N consecutive turns (N=3), 5% of remaining population is displaced per turn
2. **Encirclement**: If municipality is fully surrounded (no friendly adjacency path), 10% of remaining population is displaced per turn
3. **Breach persistence**: If breaches affecting the municipality persist for M turns (M=2), 3% of remaining population is displaced per turn

### Displacement Routing
- Displaced population is routed deterministically to friendly-controlled municipalities with supply access
- Routing uses shortest-path by adjacency graph
- Receiving municipalities have a soft cap (150% of original population)
- Excess displacement becomes lost population (20% of displaced is always lost)

### Militia Pool Integration
- **Recruitment ceiling**: `original_population - displaced_out - lost_population`
- **Pool degradation**: When displacement occurs, `available` is reduced proportionally (but `committed` is not)
- **Ceiling enforcement**: After displacement updates, pools are automatically capped to not exceed the effective ceiling

## Invariants

1. **Irreversibility**: `displaced_out` and `lost_population` never decrease
2. **Determinism**: Same input state → same displacement results
3. **Recruitment ceiling**: Militia pool total (`available + committed`) cannot exceed effective ceiling
4. **Routing determinism**: Same graph → same displacement destinations

## CLI Usage

```bash
# List all displacement states
npm run sim:displacement <save.json> list [--json] [--out <path>]

# Inspect specific municipality
npm run sim:displacement <save.json> inspect --mun <mun_id> [--out <path>]
```

## Testing

Run tests with:
```bash
npm test -- displacement.test.ts
```

Tests cover:
- Deterministic displacement (same input → same output)
- Irreversibility (displaced_out never decreases)
- Recruitment ceiling enforcement
- Routing determinism

## Documentation Updates Required

The following Word documents need manual updates (not automated):
- `docs/A_War_Without_Victory_Systems_And_Mechanics_Manual_v0_2_5.docx` — Add section on population displacement and recruitment effects
- `docs/A_War_Without_Victory_Engine_Invariants_v0_2_5.docx` — Add invariant: "Displacement is irreversible (displaced_out and lost_population never decrease)"

## Example: Single Municipality Over Multiple Turns

**Turn 10**: Municipality `20168` (Zvornik)
- Original population: 10,000
- Militia pool: available=1000, committed=200
- Under pressure, unsupplied for 3 turns → displacement triggered
- Displacement: 500 people (5% of 10,000)
- Lost: 100 people (20% of 500)
- Routed: 400 people to friendly municipality `20044`
- After displacement:
  - `displaced_out`: 500
  - `lost_population`: 100
  - Effective capacity: 9,400
  - Militia pool `available` reduced proportionally

**Turn 11**: Same municipality
- Remaining population: 9,400
- Still unsupplied → displacement continues
- Displacement: 470 people (5% of 9,400)
- `displaced_out` increases to 970 (irreversible)
- Effective capacity now: 8,930

## Notes

- Displacement is computed in the `update-displacement` phase of the turn pipeline
- The system integrates cleanly with existing militia pools and formation generation
- No changes to peace or treaty systems
- No randomness introduced
- All routing decisions are deterministic and auditable
