# Invariant Inventory

**Date:** 2026-01-25  
**Phase:** Map Rebuild (Path A)  
**Purpose:** Catalog canonical invariants and their enforcement status

## Overview

This document lists each canonical invariant from:
- **Project Rules** (`docs/cursor_rules.md`)
- **Engine Freeze Contract** (`docs/ENGINE_FREEZE_v0_2_6.md`)
- **Project Ledger Non-Negotiables** (`docs/PROJECT_LEDGER.md`)
- **Validation Functions** (`src/validate/`)

For each invariant, we document:
- Where it is currently enforced (if anywhere)
- Where it is violated / not checked
- Proposed enforcement location (deferred if requires big refactor)

## Invariant Categories

### 1. Determinism Invariants

#### 1.1 Deterministic Turn Updates
**Source:** `docs/cursor_rules.md:8`  
**Rule:** "Deterministic turn updates: given same input state + RNG seed, results must match exactly."

**Enforcement:**
- ✅ **Enforced:** RNG uses seed-based deterministic algorithm (`src/turn/pipeline.ts:43-63`)
- ✅ **Enforced:** Tests verify determinism (`tests/phase10_ops_fatigue.test.ts:774-796`, `tests/sim_formations_report.test.ts:7-52`)
- ⚠️ **Partial:** Timestamp leakage in artifacts (see DETERMINISM_AUDIT.md)
- ❌ **Not Enforced:** No automated check that state serialization excludes timestamps

**Proposed Enforcement:**
- Add guard script to detect timestamp fields in serialized state (deferred - minimal guard only)

#### 1.2 No Timestamps in State/Artifacts
**Source:** `docs/PROJECT_LEDGER.md:25`  
**Rule:** "All outputs must be deterministic - stable sorting, fixed precision (3 decimals for LOCAL_PIXELS_V2), canonical JSON key ordering, **no timestamps**."

**Enforcement:**
- ❌ **Violated:** `tools/map/report_hull_inflation.ts:268,296` - timestamps in JSON/TXT artifacts
- ✅ **Enforced:** Tests check for absence of timestamps (`tests/sim_formations_report.test.ts:49-51`, `tests/phase10_ops_fatigue.test.ts:798-800`)
- ❌ **Not Enforced:** No automated grep-based check for timestamp leakage

**Proposed Enforcement:**
- Add minimal guard script: `tools/engineering/check_determinism.ts` (grep-based, fails CI if timestamps found in artifacts)

### 2. State Mutation Invariants

#### 2.1 All State Changes in Turn Pipeline
**Source:** `docs/cursor_rules.md:9`  
**Rule:** "All changes to state happen only inside the turn pipeline (no hidden side effects)."

**Enforcement:**
- ✅ **Enforced:** State serialization validates before/after (`src/state/serialize.ts:18,31`)
- ⚠️ **Partial:** No automated detection of state mutations outside turn pipeline
- ✅ **Enforced:** Turn pipeline is single entry point (`src/sim/turn_pipeline.ts:306`)

**Proposed Enforcement:**
- Deferred - would require architecture refactor (static analysis or runtime guards)

### 3. Identity Invariants

#### 3.1 Faction IDs Must Be Political Sides
**Source:** `src/validate/factions.ts:23-29`  
**Rule:** Faction IDs must be one of: RBiH, RS, HRHB

**Enforcement:**
- ✅ **Enforced:** `validateFactions()` in `src/validate/validate.ts:78`
- ✅ **Enforced:** Called on serialize/deserialize (`src/state/serialize.ts:18,31`)
- ✅ **Enforced:** Identity canonicalization in serialize (`src/state/serialize.ts:172+`)

**Status:** ✅ Fully enforced

#### 3.2 Settlement ID Uniqueness
**Source:** `docs/PROJECT_LEDGER.md:35`  
**Rule:** "All `settlement_id` values must be globally unique. When duplicates detected, generate deterministic remapped IDs and record remapping in issues report."

**Enforcement:**
- ✅ **Enforced:** `tools/map/fix_duplicate_settlement_ids.ts` - fixes duplicates deterministically
- ⚠️ **Partial:** No validation in `src/validate/` that checks settlement ID uniqueness in state
- ❌ **Not Enforced:** No check that settlement IDs in state are unique

**Proposed Enforcement:**
- Add validation function `validateSettlements()` if settlement IDs are stored in state (deferred - verify if needed)

### 4. Geometry Invariants

#### 4.1 Path A Architecture: Polygons ≠ Settlements
**Source:** `docs/PROJECT_LEDGER.md:21`  
**Rule:** "Polygons are territorial micro-areas (`poly_id`), separate from settlement entities (`sid`). Polygons may link only via municipalities (`mid`). No forced 1:1 matching between polygons and settlements."

**Enforcement:**
- ✅ **Enforced:** Map build pipeline maintains separation (`tools/map/`)
- ✅ **Enforced:** Mistake log prevents 1:1 matching attempts (`docs/ASSISTANT_MISTAKES.log`)
- ❌ **Not Enforced:** No runtime validation that state doesn't violate this (if state contains geometry)

**Status:** ✅ Enforced at build time, N/A at runtime (geometry not in state)

#### 4.2 Aggregate Row Filtering
**Source:** `docs/PROJECT_LEDGER.md:23`  
**Rule:** "Any row containing "∑" symbol in ANY cell must be excluded from settlement-level data."

**Enforcement:**
- ✅ **Enforced:** `tools/map/build_master_census.ts:1277` - filters aggregate rows
- ✅ **Enforced:** `tools/map/read_excel_meta.ts` - filters aggregate rows
- ❌ **Not Enforced:** No validation that state doesn't contain aggregate-derived settlements

**Status:** ✅ Enforced at build time, N/A at runtime (settlements loaded from graph, not state)

#### 4.3 Empty GeoJSON is Valid
**Source:** `docs/PROJECT_LEDGER.md:27`  
**Rule:** "Always emit valid GeoJSON output even if features array is empty."

**Enforcement:**
- ✅ **Enforced:** Map build tools always emit GeoJSON (`tools/map/`)
- ❌ **Not Enforced:** No automated test that verifies empty GeoJSON emission

**Status:** ✅ Enforced in code, no automated test (acceptable)

### 5. Front Segment Invariants

#### 5.1 Edge ID Canonical Format
**Source:** `src/validate/front_segments.ts:49-88`  
**Rule:** Edge IDs must be canonical: `a__b` where `a < b` (lexicographically)

**Enforcement:**
- ✅ **Enforced:** `validateFrontSegments()` checks canonical format
- ✅ **Enforced:** Called in validation framework
- ⚠️ **Partial:** Not called automatically on state mutation (only on serialize/deserialize)

**Status:** ✅ Enforced on serialize/deserialize

#### 5.2 Edge ID Adjacency Membership
**Source:** `src/validate/front_segments.ts:100-137`  
**Rule:** Edge IDs must reference valid settlement IDs that are adjacent in the settlement graph

**Enforcement:**
- ✅ **Enforced:** `validateFrontSegments()` checks adjacency membership (warning if not adjacent)
- ✅ **Enforced:** Checks settlement ID existence (error if unknown)

**Status:** ✅ Fully enforced

### 6. Formation Invariants

#### 6.1 Formation Faction Must Be Political Side
**Source:** `src/validate/formations.ts` (inferred)  
**Rule:** Formation `faction` field must be a valid political side ID

**Enforcement:**
- ✅ **Enforced:** `validateFormations()` checks faction validity
- ✅ **Enforced:** Called in validation framework

**Status:** ✅ Fully enforced

#### 6.2 Formation Assignment Validity
**Source:** `src/validate/formations.ts` (inferred)  
**Rule:** Formation assignments must reference valid regions/edges

**Enforcement:**
- ✅ **Enforced:** `validateFormations()` validates assignment references
- ✅ **Enforced:** Checks AoR contiguity (`src/validate/aor_contiguity.ts`)

**Status:** ✅ Fully enforced

### 7. Engine Freeze Invariants

#### 7.1 Frozen Constants
**Source:** `docs/ENGINE_FREEZE_v0_2_6.md:88-95`  
**Rule:** Constants in `docs/constants_index.md` must not be modified without unfreeze

**Enforcement:**
- ✅ **Enforced:** Regression test `tests/freeze_regression.test.ts` checks constant values
- ✅ **Enforced:** Calibration tests validate behavior

**Status:** ✅ Fully enforced

#### 7.2 Monotonic Exhaustion
**Source:** `docs/ENGINE_FREEZE_v0_2_6.md:39-44`  
**Rule:** "Exhaustion never decreases" (monotonicity guarantee)

**Enforcement:**
- ✅ **Enforced:** Exhaustion calculation ensures monotonicity (`src/state/exhaustion.ts`)
- ✅ **Enforced:** Calibration tests validate monotonicity

**Status:** ✅ Fully enforced

### 8. Control Recognition Invariants

#### 8.1 Control Override Validity
**Source:** `src/validate/control_overrides.ts`  
**Rule:** Control overrides must reference valid settlement IDs and political sides

**Enforcement:**
- ✅ **Enforced:** `validateControlOverrides()` checks validity
- ✅ **Enforced:** Called in validation framework

**Status:** ✅ Fully enforced

#### 8.2 Brčko Controller Rule
**Source:** `src/validate/end_state.ts:17-31`  
**Rule:** BRCKO_CONTROLLER_ID must not appear in control maps when end_state is not set

**Enforcement:**
- ✅ **Enforced:** `validateEndState()` checks this rule
- ✅ **Enforced:** Called in validation framework

**Status:** ✅ Fully enforced

### 9. Supply Invariants

#### 9.1 Supply Rights Validity
**Source:** `src/validate/supply_rights.ts`  
**Rule:** Supply rights must reference valid municipalities and factions

**Enforcement:**
- ✅ **Enforced:** `validateSupplyRights()` checks validity
- ✅ **Enforced:** Called in validation framework

**Status:** ✅ Fully enforced

### 10. Derived State Invariants

#### 10.1 Derived State Not Serialized
**Source:** Implicit (best practice)  
**Rule:** Derived/computed state should not be serialized in GameState

**Enforcement:**
- ⚠️ **Partial:** No automated check that serialized state excludes derived fields
- ✅ **Enforced:** State schema defines only canonical fields (`src/state/game_state.ts`)
- ❌ **Not Enforced:** No guard script to detect derived field serialization

**Proposed Enforcement:**
- Add minimal guard script: `tools/engineering/check_derived_state.ts` (grep-based, fails CI if derived fields found in serialization)

## Summary by Enforcement Status

### ✅ Fully Enforced
1. Deterministic RNG usage
2. Faction ID validity (political sides)
3. Front segment edge ID format
4. Formation validity
5. Control override validity
6. Supply rights validity
7. Engine freeze constants
8. Monotonic exhaustion

### ⚠️ Partially Enforced
1. **No timestamps in artifacts** - Tests check, but one file violates (`report_hull_inflation.ts`)
2. **Derived state not serialized** - Schema enforces, but no automated detection
3. **State mutation only in pipeline** - Architecture enforces, but no automated detection

### ❌ Not Enforced (Gaps)
1. **Timestamp leakage detection** - No automated grep-based check
2. **Derived state serialization detection** - No automated check
3. **Settlement ID uniqueness in state** - Not validated (if state contains settlements)

## Proposed Minimal Guards (Deferred to Refactor Phase)

1. **`tools/engineering/check_determinism.ts`**
   - Grep for `Date.now()`, `new Date()`, ISO timestamp patterns in artifact outputs
   - Fail CI if found in `data/derived/` or serialized state

2. **`tools/engineering/check_derived_state.ts`**
   - Grep for known derived field patterns in serialization code
   - Warn if derived fields are serialized

3. **Determinism helper for CLI tools**
   - `tools/engineering/determinism_guard.ts` - helper function to ensure no timestamp fields, stable sorting

**Note:** These are minimal, grep-based guards. Full architecture refactor (types, validator redesign) is deferred to Engine Freeze phase.

## Notes

- Most invariants are enforced through validation framework
- Determinism is mostly enforced, but one artifact file violates (timestamp)
- Derived state serialization is prevented by schema, but no automated detection
- Map build invariants are enforced at build time (not runtime, as geometry not in state)
