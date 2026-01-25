# Map Diagnostics

This document describes diagnostic and maintenance scripts for the map data pipeline.

## Diagnostic Scripts

### Two-Means Analysis

Analyzes settlement clustering using the two-means algorithm, reporting results by source file.

```bash
npm run map:report:two-means
```

**Outputs:**
- `data/derived/two_means_by_source.summary.json` - JSON summary
- `data/derived/two_means_by_source.report.md` - Markdown report

### Missing Edge SIDs

Diagnoses edge endpoints that reference settlement SIDs that don't exist in the settlements index. Useful for identifying ID canonicalization mismatches.

```bash
npm run map:report:missing-edge-sids
```

**Outputs:**
- `data/derived/missing_edge_sids.summary.json` - JSON report with:
  - Total missing endpoints count
  - Unique missing SID count
  - Missing SIDs sorted by frequency
  - Base SID matches (for canonicalization)

## Maintenance Scripts

### Fix Edge SIDs

Canonicalizes edge endpoint SIDs by resolving base SIDs (2-segment format like `mun:settlement`) to their canonical 3-segment forms (like `mun:settlement:hash`). This fixes ID mismatches where edges reference old base SIDs that have been deduplicated.

```bash
npm run map:fix:edges
```

**What it does:**
1. Loads settlements and builds base-SID to candidates mapping
2. For each edge endpoint:
   - If exact match exists, keep it
   - If it's a 2-segment base SID with candidates:
     - If exactly 1 candidate → replace with that candidate
     - If multiple candidates → choose deterministically (prefer non-fallback, then lexicographically smallest)
   - If cannot be resolved → mark edge as invalid
3. Removes invalid edges
4. Deduplicates edges (undirected normalization)
5. Writes fixed edges back to `data/derived/settlement_edges.json`

**Outputs:**
- `data/derived/settlement_edges.json` - Fixed edges file (overwrites original)
- `data/derived/fix_edges_canonicalize_sids.report.json` - Report with remap statistics

**Workflow:**
```bash
# 1. Diagnose the problem
npm run map:report:missing-edge-sids

# 2. Fix the edges
npm run map:fix:edges

# 3. Verify the fix
npm run sim:mapcheck
```

## Validation

### Map Check

Validates the settlement graph, checking for missing edge endpoints, duplicates, and other issues.

```bash
npm run sim:mapcheck
```

**What it checks:**
- All edge endpoints exist in settlements
- No duplicate edges
- No disallowed self-loops
- Orphan settlements (degree 0)
- Count assertions

**Runtime resolver:** The validator includes a runtime fallback that attempts to resolve base SIDs to canonical SIDs. If resolution succeeds, it emits a warning (`edge.sid_resolved_via_base`) rather than an error, allowing the system to continue while surfacing data quality issues.

## Common Issues

### Edge endpoint missing

**Symptom:** `edge.missing_settlement` errors in `sim:mapcheck`

**Cause:** Edge endpoints reference base SIDs (2-segment) that have been deduplicated to canonical SIDs (3-segment with hash suffix)

**Solution:**
1. Run `npm run map:report:missing-edge-sids` to confirm
2. Run `npm run map:fix:edges` to canonicalize
3. Run `npm run sim:mapcheck` to verify

### Orphan settlements

**Symptom:** Warnings about settlements with degree 0 (no edges)

**Cause:** Settlement exists but has no adjacency edges. May be legitimate (isolated settlement) or indicate missing edges.

**Note:** Some orphan settlements may have 3-segment SIDs that were deduplicated from a base SID. Check if the base SID appears in edges.
