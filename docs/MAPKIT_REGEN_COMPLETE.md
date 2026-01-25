# MapKit Regeneration - Complete Summary

**Date**: Implementation completed  
**Status**: ✅ Fully operational

## Overview

Successfully implemented a deterministic pipeline to regenerate `settlements_polygons.geojson` from source data packs (ZIP of municipality JS files + master XLSX). The regenerated map is now viewable in the UI with all filtering disabled for a clean, complete view.

## Implementation Summary

### 1. Core Regeneration Script

**File**: `scripts/map/regenerate_settlements_geojson.ts`

**Features**:
- Parses ZIP archive containing municipality JS files (Raphael-style path definitions)
- Extracts SVG paths and settlement IDs using regex pattern matching
- Converts SVG paths to GeoJSON polygons with deterministic Bezier curve flattening (12 segments per curve)
- Parses Excel workbook with one sheet per municipality
- Joins settlement attributes from XLSX to path data
- Generates deterministic, reproducible GeoJSON output
- Creates comprehensive QA reports

**Key Technical Details**:
- **Bezier Flattening**: Fixed 12-segment subdivision (deterministic, not adaptive)
- **Ring Organization**: Automatic hole detection using bbox containment + area threshold (0.5x)
- **Municipality Matching**: Multi-strategy matching (exact name, normalized name, code extraction, name variations for post-war changes)
- **Determinism**: Stable sorting by canonical SID, no timestamps, fixed iteration counts

### 2. Dependencies Added

**package.json**:
- `adm-zip`: ^0.5.16 (ZIP file parsing)
- `xlsx`: ^0.18.5 (Excel file parsing)

### 3. NPM Scripts Added

- `map:regen`: Run regeneration script
- `map:regen:validate`: Validate regenerated GeoJSON

### 4. UI Updates

**File**: `dev_ui/ui0_map.ts`

**Changes**:
- Added support for `?regen=1` query parameter to load regenerated GeoJSON
- **Disabled all filtering** for clean view:
  - Outlier detection: Disabled (was hiding settlements)
  - Stray cluster filtering: Disabled (was hiding top-left area)
  - Cluster mode: Disabled
- All 6,167 settlements now visible without any filtering

### 5. Validation

**File**: `src/cli/mapkit_validate.ts` (existing, extended)
- Works with regenerated file via `--input` flag
- Validates geometry integrity, bounds, cluster diagnostics

## Current Map State

### Statistics

- **Total Settlements**: 6,167 features
- **Source Data**:
  - ZIP: 6,167 settlement path records extracted
  - XLSX: 12,282 rows from 284 municipality sheets
- **Join Success Rate**: 97.7% (6,023 joined, 144 missing)
- **Missing Joins**: 144 settlements (2.3%) across 142 municipalities
  - Most municipalities: 1 missing settlement each
  - 2 municipalities: 2 missing settlements each (Vogošća, Ribnik)

### Geometry Types

- **Polygon**: Majority of features
- **MultiPolygon**: Features with multiple disjoint rings

### Output Files

1. **`data/derived/settlements_polygons.regen.geojson`**
   - Regenerated GeoJSON FeatureCollection
   - Deterministically sorted by canonical SID
   - All features include: `sid`, `mun_code`, `settlement_id`, `name` (when available), census data

2. **`data/derived/settlements_polygons.regen_summary.json`**
   - QA summary with:
     - Per-municipality counts
     - Missing joins breakdown by municipality (with names)
     - Geometry type counts
     - Global bounds
     - Cluster diagnostic (2-means clustering)

3. **`docs/mapkit_regen_report.md`**
   - Human-readable report
   - Missing joins by municipality name
   - Validation recommendations

## Missing Joins Analysis

**144 settlements** couldn't be matched to XLSX data. These are likely:
- Settlements that exist in the JS pack but were removed/merged after data collection
- Data entry gaps in the master XLSX
- Minor discrepancies between source files

**Top municipalities with missing joins** (sample):
- Vogošća (10928): 2 missing
- Ribnik (20508): 2 missing
- 140 other municipalities: 1 missing each

All missing joins are explicitly reported in the summary JSON and markdown report.

## Usage

### Regenerate Map

```bash
# With default paths
npm run map:regen

# With custom paths
npm run map:regen -- --zip "path/to/zip" --xlsx "path/to/xlsx" --out "path/to/output.geojson"
```

### Validate Output

```bash
npm run map:regen:validate
```

### View in UI

1. Start dev server: `npm run dev:map`
2. Open: `dev_ui/ui0_map.html?regen=1`
3. All 6,167 settlements visible (no filtering)

## Determinism Guarantees

✅ **Stable iteration order**: Sorted by filename, then by canonical SID  
✅ **Fixed Bezier subdivision**: N=12 segments, uniform steps  
✅ **Fixed clustering iterations**: 10 iterations (when enabled)  
✅ **No timestamps**: All outputs are timestamp-free  
✅ **No random operations**: Fully deterministic  
✅ **Stable ring organization**: Area-based hole detection with fixed thresholds

## Files Created/Modified

### Created
- `scripts/map/regenerate_settlements_geojson.ts` (890+ lines)
- `docs/mapkit_regen_report.md` (auto-generated)
- `docs/MAPKIT_REGEN_COMPLETE.md` (this file)

### Modified
- `package.json` (added dependencies and scripts)
- `dev_ui/ui0_map.ts` (added `?regen=1` support, disabled all filtering)

## Next Steps (Optional)

1. **Investigate Missing Joins**: Review the 144 missing settlements to determine if they should be added to the master XLSX
2. **Compare with Original**: Use validation tools to compare old vs regenerated GeoJSON
3. **Replace Original**: Once validated, consider replacing the original `settlements_polygons.geojson` with the regenerated version
4. **Re-enable Filtering**: If needed, the outlier/cluster filtering can be re-enabled by uncommenting the disabled code

## Validation Status

- ✅ Script runs successfully
- ✅ GeoJSON output is valid
- ✅ All features have valid geometries
- ✅ Deterministic output (stable across runs)
- ✅ UI displays all settlements correctly
- ✅ No filtering active (clean view)

## Notes

- The regeneration pipeline is **map pipeline only** - no engine simulation changes
- All code follows existing codebase patterns and TypeScript conventions
- Filtering code is preserved (commented out) for future use if needed
- Municipality name variations (e.g., "Bosanska Gradiska" → "Gradiska") are handled automatically

---

**Status**: ✅ Complete and operational
