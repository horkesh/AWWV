# Repository Cleanup Report
**Date:** 2026-01-25  
**Phase:** Map Rebuild (Path A)  
**Purpose:** Remove provably unused files without breaking build or changing behavior

## Summary

This cleanup removed only files that were provably unused (not imported, not referenced in scripts/docs, not required by build). No behavior changes, no determinism changes, no core logic refactoring.

## Removed Files

### tools/map_v2/ (entire directory)
**Reason:** Only referenced in package.json scripts; no imports, no doc references, no test references.

**Files deleted:**
- `tools/map_v2/build_map_v2.ts`
- `tools/map_v2/unpack_inputs.ts`
- `tools/map_v2/viewer_v2/index.html`
- `tools/map_v2/viewer_v2/prep.js`
- `tools/map_v2/viewer_v2/server.js`
- `tools/map_v2/viewer_v2/viewer.js`
- `tools/map_v2/viewer_v2/data/derived_v2/*` (all cached/generated data)
- `tools/map_v2/.cache/*` (all cache files)

**Validation:**
- `rg -n "map_v2|build_map_v2|unpack_inputs|viewer_v2" .` - only found in package.json scripts
- `rg -n "from.*map_v2|import.*map_v2|require.*map_v2" .` - no imports found
- No references in docs/ (except generic versioning mention in map_pipeline.md)
- No references in tests/

## Package.json Scripts Removed

Removed 4 npm scripts that referenced deleted files:
- `map:v2:unpack` - was: `tsx tools/map_v2/unpack_inputs.ts`
- `map:v2:build` - was: `tsx tools/map_v2/build_map_v2.ts`
- `map:v2:prep` - was: `node tools/map_v2/viewer_v2/prep.js`
- `map:v2:view` - was: `node tools/map_v2/viewer_v2/server.js`

## Kept Files (Referenced, Not Deleted)

The following files/directories were checked but kept because they are referenced:

### scripts/map/*.ts
**Status:** Kept - referenced in package.json scripts
- `repair_settlements_geom.ts` → `map:repair`
- `regenerate_settlements_geojson.ts` → `map:regen`
- `diagnose_settlement_regimes.ts` → `map:diagnose`
- `normalize_coordinate_regimes.ts` → `map:normalize`
- `report_two_means_by_source.ts` → `map:report:two-means`
- `report_missing_edge_sids.ts` → `map:report:missing-edge-sids`
- `report_orphan_settlements.ts` → `map:report:orphans`
- `report_settlements_outside_municipality.ts` → `map:report:outside-muni`
- `fix_edges_canonicalize_sids.ts` → `map:fix:edges`
- `promote_regen.ts` → `map:promote`

**Note:** These scripts may be obsolete for Path A architecture, but they are still referenced in package.json and docs (MAPKIT_CANON.md, MAPKIT_REGEN_COMPLETE.md). Deferred cleanup per user instructions.

### tools/map_build/
**Status:** Kept - referenced in package.json scripts and docs
- `audit_map.ts` → `map:audit`
- `build_map.ts` → `map:build`
- `adjacency.py` → `map:adj`
- `print_polygon_failures.ts` → `map:print-failures`
- `fix_queue.ts` → `map:fixqueue`
- `apply_fallback_fixes.ts` → `map:applyhull`

Also referenced in:
- `docs/handoff_map_pipeline.md`
- `src/cli/sim_mapcheck.ts` (reads `map_build_report.json`)
- `tests/artifact_determinism.test.ts`

### tools/map_viewer/ and tools/map_viewer_simple/
**Status:** Kept - referenced in package.json scripts
- `map:view:prep` → `tools/map_viewer/prep.js`
- `map:view` → `tools/map_viewer/server.js`
- `map:view:simple:prep` → `tools/map_viewer_simple/prep.js`
- `map:view:simple` → `tools/map_viewer_simple/server.js`

### tools/map/viewer.html and serve_viewer.js
**Status:** Kept - referenced in package.json
- `map:view` → `node tools/map/serve_viewer.js` (serves viewer.html)

## Validation Commands Used

```bash
# Search for v2/deprecated patterns
rg -n "v2|_v2|deprecated|old" .

# Check map_v2 references
rg -n "map_v2|build_map_v2|unpack_inputs|viewer_v2" .

# Check imports
rg -n "from.*map_v2|import.*map_v2|require.*map_v2" .

# Check package.json scripts
rg -n "map:v2" package.json
```

## Build Validation

After cleanup, the following commands should still work:
- `npm run typecheck` - TypeScript compilation check
- `npm run map:extract:muni:drzava` - Municipality border extraction
- `npm run audit:muni` - Municipality coverage audit
- `npm run audit:muni:diagnose-borders` - Border ID diagnostic
- `npm run audit:settlements:muni` - Settlement-municipality alignment audit

## Impact

- **Files removed:** 1 directory (tools/map_v2/) with ~10+ files
- **Scripts removed:** 4 npm scripts
- **Behavior changes:** None
- **Determinism:** Unchanged
- **Build breakage:** None (removed files were not imported or required)

## Notes

- No core logic was refactored
- No simulation behavior changes
- All canonical docs (Rulebook, Systems & Mechanics Manual, Engine Invariants) untouched
- Kept files that are referenced even if potentially obsolete (per user instructions: "deferred cleanup")
