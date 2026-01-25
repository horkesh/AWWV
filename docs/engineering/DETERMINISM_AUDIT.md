# Determinism Audit Report

**Date:** 2026-01-25  
**Phase:** Map Rebuild (Path A)  
**Purpose:** Identify non-determinism hazards without performing refactor

## Executive Summary

This audit identifies locations where non-determinism could enter the codebase through:
- Timestamps in state/artifacts
- Non-deterministic random number generation
- Unstable object key iteration order
- Unstable array/collection iteration order

**Classification:**
- **State-affecting**: Non-determinism that affects serialized state or deterministic outputs (artifacts)
- **Log-only**: Non-determinism that only affects development logs (acceptable)

## Findings

### 1. Timestamp Leakage in Artifacts

#### 1.1 `tools/map/report_hull_inflation.ts` (STATE-AFFECTING)

**Location:** Lines 268, 296  
**Issue:** `generated_at: new Date().toISOString()` and `Generated: ${new Date().toISOString()}` written to JSON and TXT artifacts

**Classification:** State-affecting (artifacts are deterministic outputs)

**Fix Plan:**
- Remove `generated_at` field from JSON report
- Remove timestamp line from TXT report
- If build metadata needed, use deterministic source (e.g., git commit hash, build number from input)

**File Reference:**
```typescript
// Line 268
generated_at: new Date().toISOString(),

// Line 296
txtLines.push(`Generated: ${new Date().toISOString()}`);
```

### 2. Date Usage in Logging (Acceptable)

#### 2.1 `tools/assistant/mistake_guard.ts` (LOG-ONLY)

**Location:** Line 147  
**Issue:** `new Date()` used when date parameter not provided

**Classification:** Log-only (only affects mistake log append, not state/artifacts)

**Status:** Acceptable - mistake log is append-only history, not deterministic output. However, the function already accepts optional `date` parameter for determinism (line 117), so callers should pass date explicitly when determinism is required.

**Note:** Current implementation is fine for mistake logging, but if mistake log entries are ever used as deterministic inputs, callers must pass explicit date.

### 3. Random Number Generation

#### 3.1 Deterministic RNG Usage (CORRECT)

**Location:** `src/turn/pipeline.ts` lines 43-63  
**Status:** ✅ Correct - Uses deterministic seed-based RNG (`createRng(seed)`) with Mulberry32 algorithm

**No issues found** - all randomness in simulation uses seeded RNG.

### 4. Object Key Iteration Order

#### 4.1 Unsorted Object.keys() Usage

**Location:** Multiple files in `src/` and `tools/map/`

**Classification:** Potentially state-affecting if keys are used in serialization or deterministic outputs

**Findings:**

**SAFE (sorted after extraction):**
- `src/state/sustainability.ts:260` - `Object.keys(militiaPools).sort()` ✅
- `src/state/displacement.ts:485,499` - `Object.keys(militiaPools).sort()` ✅
- `src/cli/sim_scenario.ts:267` - `Object.keys(segs).sort()` ✅

**POTENTIALLY UNSAFE (not sorted):**
- `src/cli/sim_smoke.ts:200,214` - `Object.keys(state.sustainability_state)` and `Object.keys(state.displacement_state)` - used for iteration only, not serialized ✅ (safe)
- `src/sim/turn_pipeline.ts:158,160` - `Object.entries()` used to build Map - Map iteration order is insertion-order, but source object order is non-deterministic ⚠️

**Analysis of `src/sim/turn_pipeline.ts:158-160`:**
```typescript
const deltas = new Map<string, number>(Object.entries(step.pressure_deltas));
// ...
Object.entries(step.local_supply)
```

**Risk:** If `step.pressure_deltas` or `step.local_supply` are objects with non-deterministic key order, Map insertion order will vary. However, these are internal to turn pipeline and not serialized directly. **Status:** Low risk, but should verify these objects are created with stable key order.

**Recommendation:** Audit where `pressure_deltas` and `local_supply` objects are created to ensure stable key ordering.

#### 4.2 Object.entries() in Map Tools

**Location:** `tools/map/` - Multiple files use `Object.entries()` for iteration

**Classification:** State-affecting if used in artifact generation

**Findings:**
- `tools/map/derive_municipality_outlines_from_fabric.ts:673` - `Object.entries(unionFailuresByReason).sort()` ✅ (sorted)
- `tools/map/extract_municipality_borders_from_drzava.ts:1360` - `Object.entries(report.dropped_reasons)` - used for iteration, then sorted ✅ (safe)
- `tools/map/report_svg_geometry_failures.ts:204,218,242` - `Object.entries()` used for iteration, then sorted ✅ (safe)
- `tools/map/svgpath_to_geojson.ts:516` - `Object.entries(dropReasons)` - used for iteration, then sorted ✅ (safe)

**Status:** All map tool usages are either sorted or used for iteration only (not serialized directly).

### 5. Array/Collection Iteration Order

#### 5.1 Array Sorting

**Status:** ✅ Good - Most arrays that are serialized are explicitly sorted:
- `src/state/sustainability.ts:100,365` - Arrays sorted before use
- `src/state/displacement.ts:162,424,658,659` - Arrays sorted before use
- `src/state/negotiation_pressure.ts:59,179` - Arrays sorted before serialization
- `tools/map/` - Most outputs explicitly sort features by ID

**No issues found** - sorting is consistently applied where needed.

### 6. JSON Serialization Key Order

#### 6.1 Default JSON.stringify() Behavior

**Location:** All serialization points

**Status:** ⚠️ JavaScript `JSON.stringify()` uses insertion order for object keys, which is deterministic within a single run but can vary if object construction order varies.

**Risk Assessment:**
- **State serialization** (`src/state/serialize.ts:25`): Uses `JSON.stringify(state, null, 2)` - relies on object key insertion order
- **Artifact generation**: Most map tools use `JSON.stringify(obj, null, 2)` - same risk

**Mitigation:** Current codebase relies on consistent object construction order. This is acceptable if:
1. Objects are always constructed in the same order
2. No dynamic key addition that could vary

**Recommendation:** Consider using canonical JSON key sorting for critical artifacts (see `tools/map/build_map.ts:199` for example of sorted keys).

**Example of canonical sorting:**
```typescript
// tools/map/build_map.ts:199
return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort(), 2);
```

**Files using canonical sorting:**
- `tools/map/build_map.ts:199` ✅

**Files not using canonical sorting (but may be safe due to stable construction):**
- `src/state/serialize.ts:25` - State serialization
- Most artifact generators in `tools/map/`

## Summary by Severity

### Critical (State-Affecting, Must Fix)
1. **`tools/map/report_hull_inflation.ts`** - Timestamp in JSON/TXT artifacts (lines 268, 296)

### Low Risk (Monitor, May Need Fix)
1. **`src/sim/turn_pipeline.ts`** - Object.entries() for Map construction - verify source object key order is stable
2. **JSON key ordering** - Consider canonical sorting for critical artifacts

### Acceptable (Log-Only)
1. **`tools/assistant/mistake_guard.ts`** - Date usage in logging (acceptable, but prefer explicit date parameter)

## Fix Priority

1. **Immediate:** Remove timestamps from `report_hull_inflation.ts` artifacts
2. **Monitor:** Verify `pressure_deltas` and `local_supply` object construction order
3. **Consider:** Add canonical JSON key sorting to critical artifact generators (deferred to refactor phase)

## Notes

- All RNG usage is deterministic (seed-based)
- Most array/collection iteration is explicitly sorted
- Object key iteration is mostly safe (sorted or iteration-only)
- Primary risk is timestamp leakage in artifacts (1 file identified)
