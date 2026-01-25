# Refactor Roadmap (DEFERRED)

**Date:** 2026-01-25  
**Phase:** Map Rebuild (Path A)  
**Status:** DEFERRED until Engine Freeze phase  
**Decision:** Defer architecture refactor, implement only audits/guards now

## Summary

A separate agent proposed a large refactor involving types, validator, ledger, and mistake log improvements. This document captures that proposal but rewrites it to comply with our existing project rules, explicitly noting what is deferred.

## Original Proposal (Summarized)

The agent proposed:
1. **Type system improvements** - Stronger typing for state, invariants, validation
2. **Validator redesign** - More comprehensive validation with better error messages
3. **Ledger integration** - Automated ledger updates, version tracking
4. **Mistake log enhancements** - Better mistake detection, auto-fix capabilities

## Rewritten Proposal (Aligned with Project Rules)

### 1. Type System Improvements (DEFERRED)

**Proposed Changes:**
- Add branded types for IDs (settlement_id, municipality_id, faction_id)
- Add type-level invariants (e.g., `NonNegativeNumber`, `CanonicalEdgeId`)
- Improve type safety for state mutations

**Compliance with Rules:**
- ✅ Allowed: Type improvements don't change runtime behavior
- ⚠️ Risk: Must ensure no breaking changes to existing state files
- ⚠️ Risk: Must not change deterministic outputs

**Deferred Because:**
- Requires careful migration of existing state files
- Should be done during Engine Freeze phase when state schema is stable
- Current type system is sufficient for Map Rebuild phase

### 2. Validator Redesign (DEFERRED)

**Proposed Changes:**
- More comprehensive validation coverage
- Better error messages with context
- Validation at mutation points (not just serialize/deserialize)

**Compliance with Rules:**
- ✅ Allowed: Validation improvements are always welcome
- ❌ **VIOLATION:** Proposed "nearest assignment inference" - this violates rule: "Validator should warn and stop deterministically, not infer 'nearest' assignments"
- ❌ **VIOLATION:** Proposed "auto-fix that changes outcomes silently" - this violates rule: "No auto-fix that changes outcomes silently"

**Corrected Approach:**
- ✅ Add more validation checks (good)
- ✅ Improve error messages (good)
- ❌ **DO NOT** implement auto-fix or inference
- ❌ **DO NOT** silently change outcomes
- ✅ Validator should warn and stop deterministically

**Deferred Because:**
- Current validation framework is sufficient
- Proposed auto-fix violates project rules
- Should be done during Engine Freeze phase when validation requirements are clearer

### 3. Ledger Integration (DEFERRED)

**Proposed Changes:**
- Automated ledger updates
- Version tracking
- Change detection

**Compliance with Rules:**
- ✅ Allowed: Automation is fine if it maintains append-only history
- ⚠️ Risk: Must not rewrite old entries (violates rule: "Append-only History")
- ⚠️ Risk: Must not change "Current state / Current phase" sections incorrectly

**Corrected Approach:**
- ✅ Automated changelog appends (good)
- ❌ **DO NOT** rewrite old entries
- ❌ **DO NOT** auto-update "Current state" sections without human review
- ✅ Maintain append-only discipline

**Deferred Because:**
- Current manual ledger updates are working fine
- Automation risks violating append-only rule
- Should be done during Engine Freeze phase when process is more stable

### 4. Mistake Log Enhancements (DEFERRED)

**Proposed Changes:**
- Better mistake detection patterns
- Auto-fix capabilities
- Mistake prevention at compile time

**Compliance with Rules:**
- ✅ Allowed: Better detection is good
- ❌ **VIOLATION:** Proposed "auto-fix" - this violates rule: "No auto-fix that changes outcomes silently"
- ✅ Allowed: Compile-time checks (good, if they don't change behavior)

**Corrected Approach:**
- ✅ Improve mistake detection (good)
- ✅ Add more patterns (good)
- ❌ **DO NOT** implement auto-fix
- ✅ Keep mistake log as append-only history
- ✅ Maintain `appendMistake()` with explicit date parameter for determinism

**Deferred Because:**
- Current mistake guard is sufficient
- Auto-fix violates project rules
- Should be done during Engine Freeze phase

## Key Rule Violations in Original Proposal

### 1. Auto-Fix That Changes Outcomes Silently
**Rule:** "No auto-fix that changes outcomes silently"  
**Violation:** Proposed auto-fix for validation errors  
**Correct Approach:** Validator warns and stops deterministically, human fixes the issue

### 2. Inference of "Nearest" Assignments
**Rule:** "Validator should warn and stop deterministically, not infer 'nearest' assignments"  
**Violation:** Proposed inference of nearest valid values  
**Correct Approach:** Validator reports exact error, human provides correct value

### 3. Timestamp Usage
**Rule:** "Logging timestamps allowed only in dev logs, never in state/artifacts"  
**Status:** ✅ Already compliant - mistake log uses explicit date parameter

### 4. Derived State Serialization
**Rule:** "Derived state not serialized"  
**Status:** ✅ Already compliant - current approach doesn't serialize derived state

## What Was Implemented Instead (Minimal Guards)

Instead of the large refactor, we implemented minimal guard scripts:

1. **`tools/engineering/check_determinism.ts`**
   - Grep-based detection of timestamp leakage
   - Detects `Date.now()`, `new Date()`, ISO timestamps in artifacts
   - Warns on `Math.random()` in simulation pipeline

2. **`tools/engineering/check_derived_state.ts`**
   - Grep-based detection of derived state serialization
   - Checks for known derived field patterns in serialization code

3. **`tools/engineering/determinism_guard.ts`**
   - Helper functions for CLI tools
   - `removeTimestampFields()` - removes timestamp fields from objects
   - `ensureStableSort()` - ensures deterministic array sorting
   - `assertNoTimestamps()` - validates no timestamp fields

**These are minimal, grep-based guards. No architecture refactor.**

## When to Revisit (Engine Freeze Phase)

This refactor should be reconsidered during the **Engine Freeze phase** when:
- State schema is stable
- Validation requirements are clearer
- Process is more mature
- Breaking changes are acceptable (with migration plan)

## Notes

- All proposed changes must comply with project rules
- No auto-fix that changes outcomes
- No inference of "nearest" assignments
- Maintain append-only discipline
- Keep determinism guarantees
- Derived state not serialized

**Current Status:** ✅ Audits and minimal guards implemented. Refactor deferred.
