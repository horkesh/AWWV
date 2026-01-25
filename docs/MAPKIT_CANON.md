# MapKit Canonical Substrate

**Status**: Regenerated map is canonical  
**File**: `data/derived/settlements_polygons.geojson`

## Overview

The canonical settlement geometry file (`settlements_polygons.geojson`) is the regenerated map produced by the deterministic MapKit regeneration pipeline. The original file has been backed up as `settlements_polygons.geojson.pre_regen_backup`.

## Provenance

- **Source**: Regenerated from source data packs (ZIP of municipality JS files + master XLSX)
- **Regeneration Script**: `scripts/map/regenerate_settlements_geojson.ts`
- **Promotion Script**: `scripts/map/promote_regen.ts`
- **Backup**: Original canonical backed up to `.pre_regen_backup` (never deleted)

## Determinism Guarantees

The canonical map maintains strict determinism:

- **Stable iteration order**: Sorted by filename, then by canonical SID
- **Fixed Bezier subdivision**: N=12 segments, uniform steps
- **Fixed clustering iterations**: 10 iterations (when enabled)
- **No timestamps**: All outputs are timestamp-free
- **No random operations**: Fully deterministic
- **Stable ring organization**: Area-based hole detection with fixed thresholds
- **Stable SID ordering**: Features sorted deterministically by canonical SID

## Statistics

- **Total Settlements**: 6,167 features
- **Join Success Rate**: 97.7% (6,023 joined, 144 missing)
- **Missing Joins**: 144 settlements (2.3%) across 142 municipalities
  - Most municipalities: 1 missing settlement each
  - 2 municipalities: 2 missing settlements each (Vogošća, Ribnik)

### Known Missing XLSX Joins

144 settlements could not be matched to XLSX data. These are likely:
- Settlements that exist in the JS pack but were removed/merged after data collection
- Data entry gaps in the master XLSX
- Minor discrepancies between source files

All missing joins are explicitly reported in `settlements_polygons.regen_summary.json`.

## Quality Standards

The canonical map is validated against regression guards:

- **Stray cluster size**: < 0.5% (two-means clustering)
- **Inside-main-bounds rate**: >= 99% (centroids within expanded core bounds)
- **No NaN/Infinity**: All coordinates are finite
- **Stable SID ordering**: No duplicate SIDs, deterministic sort order
- **Finite global bounds**: Bounds are finite and not absurdly large

Validation: `npm run map:validate`

## Usage

### Default Loading

The canonical file is loaded by default by:
- UI-0 map viewer (`dev_ui/ui0_map.html`)
- Simulation pipeline (`sim:mapcheck`, `sim:run`, etc.)
- Adjacency generation (`map:adj`)
- All map-dependent tools

### Legacy Parameters

- `?regen=1`: Legacy parameter, now loads canonical (kept for compatibility)
- `?repaired=1`: Loads repaired variant (if exists)

## Rebuilding Derived Artifacts

After promoting regenerated map to canonical, rebuild downstream artifacts:

```bash
# 1. Promote regenerated map to canonical
tsx scripts/map/promote_regen.ts

# 2. Rebuild adjacency
npm run map:adj

# 3. Validate
npm run map:validate
npm run sim:mapcheck
```

## Files

- **Canonical**: `data/derived/settlements_polygons.geojson`
- **Backup**: `data/derived/settlements_polygons.geojson.pre_regen_backup`
- **Regenerated source**: `data/derived/settlements_polygons.regen.geojson` (preserved)
- **Summary**: `data/derived/settlements_polygons.regen_summary.json`

## Related Documentation

- `docs/MAPKIT_REGEN_COMPLETE.md`: Regeneration implementation details
- `docs/mapkit_regen_report.md`: QA report from regeneration
