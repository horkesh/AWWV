# AWWV Project Ledger

**Last Updated:** 2026-01-25  
**Status:** Active - MAP REBUILD Phase

This is the single authoritative project ledger. All context, decisions, and state should be tracked here. See `docs/ASSISTANT_MISTAKES.log` for the canonical "do not repeat" source.

---

## Identity

**Project:** A War Without Victory (AWWV)  
**Type:** Wargame simulation prototype  
**Repository:** AWWV  
**Current Focus:** Map rebuild using Path A architecture

---

## Non-negotiables

1. **Path A Architecture:** Polygons are territorial micro-areas (`poly_id`), separate from settlement entities (`sid`). Polygons may link only via municipalities (`mid`). No forced 1:1 matching between polygons and settlements.

2. **Aggregate Row Filtering:** Any row containing "∑" symbol in ANY cell must be excluded from settlement-level data. Aggregate rows are for validation only.

3. **Deterministic Builds:** All outputs must be deterministic - stable sorting, fixed precision (3 decimals for LOCAL_PIXELS_V2), canonical JSON key ordering, no timestamps.

4. **Empty GeoJSON is Valid:** Always emit valid GeoJSON output even if features array is empty. Never skip writing GeoJSON when feature count is zero.

5. **Canvas Polygon Isolation:** Every polygon must use its own `beginPath()`, `moveTo()` for first vertex, and `closePath()` before fill/stroke. Never connect polygons across paths.

6. **Municipality Outline Handling:** Municipality outlines can be single polygons. Union operations must handle both single and multiple polygon cases. Use convex hull fallback when union is unreliable.

7. **Render-Valid Primary Gate:** Primary gate is render-valid (finite, non-zero area, non-self-intersecting/triangulatable). GIS-valid is diagnostic only. Use deterministic convex hull salvage when needed, but measure hull inflation.

8. **Settlement ID Uniqueness:** All `settlement_id` values must be globally unique. When duplicates detected, generate deterministic remapped IDs and record remapping in issues report.

9. **Mistake Log Integration:** All scripts must reference `docs/ASSISTANT_MISTAKES.log` as canonical "do not repeat" source. Use mistake guard before any map/geometry work.

10. **Append-Only History:** Ledger changelog is append-only. Do not rewrite old entries except in "Current state / Current phase" sections.

---

## Current Phase

**Phase:** MAP REBUILD (Path A)  
**Status:** Active  
**Focus:** Rebuilding map substrate with Path A architecture (polygons ≠ settlements)

**Key Work:**
- Polygon fabric extraction from HTML/SVG sources
- Settlement metadata from Excel (with aggregate filtering)
- Municipality code crosswalk (optional)
- Municipality outline derivation
- Settlement point generation
- Visual inspection tools

---

## Allowed / Disallowed Work

### ✅ Allowed in Current Phase

- Map rebuild pipeline work (Path A)
- Polygon fabric extraction and processing
- Settlement metadata processing (Excel → CSV)
- Municipality outline derivation
- Settlement point generation
- Visual inspection HTML tools
- Geometry validation and reporting
- Crosswalk file creation/updates
- Mistake log entries for new issues

### ❌ Disallowed in Current Phase

- Forcing 1:1 polygon-to-settlement matching
- Treating aggregate rows (∑) as settlements
- Skipping GeoJSON output when feature count is zero
- Connecting canvas polygons across paths
- Using GIS validity as hard gate (use render-valid)
- Allowing duplicate settlement IDs
- Rewriting old ledger changelog entries
- Modifying raw source files in `data/source/` (read-only)

---

## Geometry Contract (Path A)

**Path A Architecture:**

1. **Polygons** (`poly_id`): Territorial micro-areas from SVG, identified by `poly_id`. Linked to municipalities via `mun_code` → `mid` crosswalk. NOT linked directly to settlements.

2. **Settlements** (`sid`): Simulation entities from Excel, identified by `sid`. Linked to municipalities via `mid`. Point+graph entities, NOT polygon entities.

3. **Municipalities** (`mid`): Pre-1991 municipality IDs. Polygons and settlements both link to municipalities, but not directly to each other.

**Outline Modes:**

The pipeline operates in one of three modes based on crosswalk availability:

| Mode | Crosswalk present | Outlines file | Meaning |
|------|-------------------|--------------|---------|
| mid | yes | municipality_outline*.geojson | pre-1991 opštine borders |
| mun_code | no | mun_code_outline.geojson | map-pack partitions (inspection-only) |
| national | no | national_outline.geojson | BiH border only |

**Mode "mid" (canonical):**
- Requires `data/source/mun_code_crosswalk.csv`
- Produces municipality outlines keyed by pre-1991 `mid`:
  - `data/derived/municipality_outline.geojson` (or `*_rekeyed.geojson` depending on repo state)
- Meaning: pre-1991 opštine borders for simulation logic

**Mode "mun_code" (fallback, inspection-only):**
- Used when crosswalk is missing or yields 0 polygons with mid
- Produces outlines grouped by polygon fabric `mun_code`:
  - `data/derived/mun_code_outline.geojson`
- Meaning: map-pack municipal partitions for inspection only, NOT pre-1991 opštine

**Mode "national" (fallback):**
- Always produced regardless of mode:
  - `data/derived/national_outline.geojson`
- Meaning: country border only

**Crosswalk Behavior:**
- Without `mun_code_crosswalk.csv`: Polygons have `mid = null`, mid-based municipality outlines cannot be derived. The intended fallback is mun_code outlines for inspection. National outline fallback is always created. Settlement points placed in deterministic grid (synthetic).
- With `mun_code_crosswalk.csv`: Polygons enriched with `mid`, municipality outlines derived from polygon fabric (union by mid), more accurate territorial representation.

**Missing Crosswalk Handling:**
- Polygon fabric still fully generated and visible
- All polygons have `mid = null`
- Mid-based municipality outlines cannot be derived (empty FeatureCollection expected)
- Mun_code outlines should be created for inspection: `mun_code_outline.geojson`
- National outline fallback: `national_outline.geojson` (union of all polygons)
- Inspector shows warning: "No municipality outlines (mun_code_crosswalk.csv missing)"
- Settlement points placed in deterministic grid (synthetic flag)
- "Points inside municipality" validation checks skipped

---

## Decisions

| Date | Decision | Rationale | Consequences |
|------|----------|-----------|--------------|
| 2026-01-24 | Adopted Path A architecture (polygons ≠ settlements) | Previous approach attempted 1:1 matching which failed due to incompatible ID schemes | Clean separation allows polygons for visualization, settlements remain point+graph entities |
| 2026-01-24 | Always emit GeoJSON even with zero features | Downstream tools expect consistent output structure | Empty GeoJSON is valid and maintains pipeline consistency |
| 2026-01-24 | Filter aggregate rows (∑) from settlement data | Aggregate rows are validation-only, not actual settlements | Prevents aggregate totals from becoming settlement entities |
| 2026-01-24 | Use render-valid as primary gate, GIS-valid as diagnostic | GIS validity too strict, drops usable geometry | More geometry preserved while still maintaining quality |
| 2026-01-24 | Municipality outlines can be single polygons | Union operations should handle both single and multiple polygon cases | Prevents rejection of valid single-polygon municipalities |
| 2026-01-24 | Use convex hull fallback for outlines when union fails | Union is unreliable for some municipality geometries | Provides deterministic fallback with inflation reporting |
| 2026-01-24 | Measure hull inflation when using convex hull salvage | Convex hull can distort settlement shapes | Flags high-inflation hulls in metadata and overlays |
| 2026-01-24 | Treat SVG ids as opaque geometry handles | SVG polygon ids and Excel settlement ids use different schemes | Explicit crosswalk required, no silent mismatches |
| 2026-01-24 | Municipality borders sourced directly from drzava.js to avoid unstable unions | Union operations on micro-polygons frequently fail, drzava.js contains pre-authored municipality shapes | Bypasses union completely, renders borders reliably from source |

---

## Current State

### Files in `data/derived/`

**Proven/Working:**
- `polygon_fabric.json` - Polygon features extracted from HTML (6148 polygons)
- `polygon_fabric.geojson` - GeoJSON polygons in LOCAL_PIXELS_V2
- `polygon_fabric_with_mid.geojson` - Polygons with mid (if crosswalk exists)
- `settlements_meta.csv` - Settlement metadata from Excel (6283 settlements, 142 aggregate rows filtered)
- `settlement_points_from_excel.geojson` - Settlement points (6148 points)
- `municipality_outline.geojson` - Municipality outlines (0 municipalities - crosswalk missing)
- `national_outline.geojson` - National outline fallback (union of all polygons)
- `settlements_inspector.html` - Visual inspection tool
- `municipality_borders_viewer.html` - Municipality borders viewer
- `municipality_borders.geojson` - Municipality borders extracted from drzava.js (142 features expected)
- `municipality_borders_viewer.html` - Municipality borders viewer (drzava.js source)
- `municipality_borders_report.json` - Extraction report for drzava.js borders
- `geometry_report.json` - Build statistics and validation metrics
- `mun_code_summary.csv` - Diagnostic summary of mun_code values

**Build Statistics (from geometry_report.json):**
- Total polygons: 6148
- Polygons kept: 6148
- Polygons dropped: 0
- Points created: 6148
- Aggregate rows filtered: 142
- Polygons without meta: 6137
- Meta without polygons: 6283
- Municipalities derived: 0 (crosswalk missing)
- Crosswalk matched: 0
- Crosswalk unresolved: 6422

**Coordinate System:**
- CRS: LOCAL_PIXELS_V2
- Bounds: min_x=1, min_y=-9.521, max_x=940.964, max_y=910.09
- Precision: 3 decimals

**Status:**
- ✅ Polygon fabric extraction working
- ✅ Settlement metadata extraction working (aggregate filtering applied)
- ✅ Settlement point generation working
- ⚠️ Municipality crosswalk missing (all polygons have `mid = null`)
- ⚠️ Mid-based municipality outlines cannot be derived (crosswalk missing - expected)
- ⚠️ Mun_code outlines should be created for inspection when crosswalk missing
- ✅ National outline fallback created
- ✅ Visual inspection tools working

**Counts and Terminology:**
- `settlements_meta.csv` rows (6,283) ≠ polygon fabric feature count (6,148) - this is normal
- Settlement entities (from Excel) are authoritative simulation entities
- Polygon fabric is a territorial substrate for visualization
- IDs must not be remapped silently. Any remap must be explicit via a committed mapping file (if ever needed)

**Current Blockers:**
- Blocker: When crosswalk is missing, `mun_code_outline.geojson` must be emitted for inspection. If this file is not being created, the pipeline is incomplete.
- Blocker: Inspector may show missing outlines if `mun_code_outline.geojson` is not present when in mun_code mode.

**Broken/Missing:**
- Municipality code crosswalk (`data/source/mun_code_crosswalk.csv`) - missing, causing all polygons to have `mid = null`
- If crosswalk missing: `mun_code_outline.geojson` should exist for inspection (verify this is being created)

---

## Next Tasks (Top 5)

1. **Verify Mun_Code Outline Creation** - When crosswalk is missing, ensure `mun_code_outline.geojson` is being created for inspection. If not, fix the pipeline to emit this fallback artifact.

2. **Create/Update Municipality Code Crosswalk** - Build `data/source/mun_code_crosswalk.csv` to map polygon `mun_code` values to canonical `mid` values. This will enable mid-based municipality outline derivation and improve territorial representation.

3. **Validate Polygon-to-Municipality Mapping** - After crosswalk is created, verify that municipality outlines are correctly derived and settlement points are contained within outlines.

4. **Update Inspector with Outline Mode Status** - Ensure inspector HTML clearly shows outline mode (mid/mun_code/national) and provides guidance when crosswalk is missing.

5. **Document Crosswalk Creation Process** - Add documentation on how to create/update the municipality code crosswalk file.

---

## Backlog

- Improve polygon-to-municipality matching accuracy
- Add more detailed geometry validation reports
- Create automated crosswalk generation tool
- Add municipality-level statistics to geometry report
- Improve settlement point placement accuracy (when coordinates missing)
- Add polygon simplification options for performance
- Create municipality outline quality metrics
- Add support for multiple coordinate systems
- Create migration guide from old map system to Path A
- Add unit tests for map build pipeline

---

## Operational Notes

**Build System:**
- TypeScript files run directly with `tsx` (no compilation step required)
- Build command: `npm run build:map` or `pnpm build:map`
- Check command: `npm run map:check` or `pnpm map:check`
- PowerShell command chaining:
  - Windows PowerShell 5.1 does NOT support `&&`. Use separate lines or `;` separator (e.g., `npm run build:map; npm run map:check`)
  - PowerShell 7 supports `&&` (e.g., `npm run build:map && npm run map:check`)
  - If `pnpm` is not installed, use `npm run build:map` instead

**Dependencies:**
- `pnpm` may be missing - use `npm` as fallback
- TypeScript execution: `tsx` (in devDependencies)
- GeoJSON processing: `@turf/turf`
- Excel parsing: `xlsx`
- SVG path parsing: `svg-path-parser`
- Concave hull: `concaveman`

**File Paths:**
- Source files: `data/source/`
- Derived files: `data/derived/`
- Tools: `tools/map/`
- Documentation: `docs/`

**Mistake Guard Integration:**
- All scripts in `tools/map/` should import and use mistake guard
- Reference: `docs/ASSISTANT_MISTAKES.log`
- Guard functions: `loadMistakes()`, `assertNoRepeat(context)`

**Project Ledger Integration:**
- All scripts should import and use project ledger guard
- Reference: `docs/PROJECT_LEDGER.md`
- Guard functions: `loadLedger()`, `assertLedgerFresh(context)`
- Summary: `getLedgerSummary()`

---

## Changelog

**2026-01-24** - Initial ledger creation
- Created PROJECT_LEDGER.md with current MAP REBUILD phase state
- Documented Path A architecture and geometry contract
- Recorded current file state in `data/derived/`
- Listed top 5 next tasks and backlog
- Integrated with mistake log reference

**2026-01-24** - Clarified outline modes and operational notes
- Clarified outline modes (mid vs mun_code fallback vs national) with explicit table
- Corrected PowerShell command notes: Windows PowerShell 5.1 does NOT support `&&`, use `;` or separate lines
- Aligned artifact expectations: mun_code outlines should be created when crosswalk missing
- Corrected misleading statements: mid-based outlines cannot be derived when crosswalk missing (expected), but mun_code outlines should be created for inspection
- Aligned counts and terminology: settlements_meta.csv rows ≠ polygon fabric features (normal), settlement entities are authoritative
- Added firm rule: IDs must not be remapped silently, any remap must be explicit via committed mapping file
- Added current blockers section: mun_code_outline.geojson must be emitted when crosswalk missing
- Updated next tasks to prioritize verifying mun_code outline creation

**2026-01-24** - Municipality borders extraction from drzava.js (Path A)
- Added extractor: `extract_municipality_borders_from_drzava.ts` - parses drzava.js to extract municipality borders directly
- Added viewer builder: `build_municipality_borders_viewer_html.ts` - generates HTML viewer for drzava.js borders
- Integrated into map build pipeline: new steps added after municipality outline derivation
- Updated check_map.ts: added validation for municipality_borders.geojson (>=130 features, numeric mid required)
- Decision: Municipality borders sourced directly from drzava.js to avoid unstable union operations
- Note: This is a visualization/substrate aid, not yet the canonical pre-1991 mid geometry (until munID→pre-1991 mid mapping is conclusive)

**2026-01-24** - Municipality coverage audit script
- Added `tools/map/audit_municipality_coverage.ts`: deterministic audit comparing expected municipalities (from `settlements_meta.csv`) vs present municipalities (from `municipality_borders.geojson`)
- New npm script: `audit:muni` (`npm run audit:muni`)
- Outputs: `municipality_coverage_report.json`, `municipality_missing_borders.csv`, `municipality_missing_borders.json` (missing/extra lists, summary stats; no timestamps, stable sort)
- Integrated mistake guard and project ledger guard

**2026-01-24** - Municipality ID normalization for border coverage audit
- Phase: Map Rebuild (Path A)
- Decision: Audit compares canonical pre-1991 municipality IDs via explicit crosswalk, no inference
- Added crosswalk file: `data/refs/municipality_id_crosswalk.csv` (columns: `munid_5,mid_7,name`)
- Updated `audit_municipality_coverage.ts` to normalize 5-digit border IDs to 7-digit canonical IDs via crosswalk
- Extended coverage report with: `id_scheme` metadata, `unmapped_border_ids` list, `crosswalk_stats`
- Artifacts: crosswalk file enables normalized coverage comparison; unmapped border IDs tracked separately (not counted as present)
- Updated `tools/map/README.md` to document crosswalk requirement and `unmapped_border_ids` meaning

**2026-01-24** - Border ID extraction diagnostic for municipality audit
- Phase: Map Rebuild (Path A)
- Decision: Diagnose schema/format mismatch before expanding crosswalk, no inference, no geometry
- Added `tools/map/diagnose_border_ids.ts`: deterministic diagnostic to explain why only 13/138 border features map via crosswalk
- New npm script: `audit:muni:diagnose-borders` (`npm run audit:muni:diagnose-borders`)
- Outputs: `data/derived/municipality_audit/border_id_diagnostic.json` + `border_id_diagnostic.csv`
- For each border feature, reports: extracted_raw_id, extracted_from_key, all_candidate_keys_present, normalized_id_attempt (raw_string, trimmed, digits_only, padded_5_if_digits), crosswalk_match_status (direct_match, trimmed_match, digits_only_match, padded_5_match, matched_munid_5, matched_mid_7)
- Read-only analysis: reports raw vs normalized differences, no geometry changes, no inference, no remapping heuristics
- Artifacts: diagnostic output clearly shows why mapping rate is low (wrong key used, formatting differences, mixed ID schemes)
- Updated `tools/map/README.md` to document diagnostic script and its purpose

**2026-01-24** - Settlement-to-municipality alignment audit (post-1995 authoritative)
- Phase: Map Rebuild (Path A)
- Decision: post-1995 municipalities (drzava.js lineage) are authoritative; audit checks settlement references against this set; no inference
- Added `tools/map/audit_settlement_muni_alignment.ts`: deterministic audit validating settlement metadata municipality references against authoritative post-1995 municipality set from borders GeoJSON
- New npm script: `audit:settlements:muni` (`npm run audit:settlements:muni`)
- Outputs: `data/derived/municipality_audit/settlement_muni_alignment_report.json` + 3 CSVs (`settlements_missing_muni_ref.csv`, `settlements_unknown_muni_ref.csv`, `municipalities_zero_settlements.csv`)
- For each settlement, extracts municipality reference using priority order (munid_5 -> munID -> mun_id -> mun_code -> mid), records source_field and raw_value, validates against authoritative set via exact matching (no normalization)
- Reports: settlements with missing/unknown municipality references, municipalities with zero settlements, unknown municipality reference values
- Artifacts: alignment report with summary statistics, explicit lists of mismatches and coverage gaps (no silent drops)
- Note: No geometry generated; borders remain reference-only
- Updated `tools/map/README.md` to document audit script, extraction priority, and output meanings

**2026-01-24** - Add visual check for drzava.js municipality extraction
- Phase: Map Rebuild (Path A)
- Decision: Visual check is a read-only diagnostic, no geometry inference or repair
- Artifacts: HTML viewer + extracted GeoJSON remain deterministic
- Modified `tools/map/extract_municipality_borders_from_drzava.ts`: outputs `municipality_borders_from_drzava.geojson`, `municipality_borders_extraction_report.json`, `municipality_borders_extraction_failures.csv`; generates `municipality_borders_from_drzava_viewer.html`
- Viewer: static HTML + inline JS/CSS, loads GeoJSON and report via relative paths; canvas outlines only; hover/click inspector (munid_5, name); legend (features + failures); search by munid_5/name with thicker highlight; collapsible failures panel listing `failed_entities` (munid_5, name, reason)
- New npm script: `map:extract:muni:drzava` (`npm run map:extract:muni:drzava`)
- Updated `tools/map/README.md`: how to run extract, how to open viewer, what to check

**2026-01-25** - Fix drzava.js extraction, filter to municipalities only
- **Phase:** Map Rebuild (Path A)
- **Decision:** drzava.js contains mixed admin layers; extractor must explicitly identify and export municipalities only, no inference
- **Artifacts:** updated `municipality_borders_from_drzava.geojson` + extraction report now shows `admin_layer_breakdown`
- `classifyAdminUnit(obj)` added: uses explicit name prefixes (`Kanton:`, `Entitet:`, `Regija:`, `Distrikt:`, `Država:`) → canton / entity / other; else municipality. No ID-based or name-based heuristics; uncertain → other, logged
- Filter: only items classified as municipality are exported to GeoJSON; non-municipality counted in report, not exported
- Report extended: `admin_layer_breakdown` (municipality, canton, entity, other), `sample_non_municipality` (max 20, first encountered, deterministic)
- Failures CSV: `layer` column added (fixed to `municipality`); only municipality-classified parse failures
- GeoJSON properties: `munid_5` (string, 5-digit), `name`, `source`, `feature_index`; IDs from municipality’s own identifier
- Viewer: renders only municipality borders; legend displays `admin_layer_breakdown`
- Updated `tools/map/README.md`: drzava.js mixed-layer source, how filtering works

**2026-01-25** - Municipality geometry failure diagnostics for drzava extraction
- **Phase:** Map Rebuild (Path A)
- **Decision:** Failures are analyzed and reported, not repaired; no inference
- **Artifacts:** `municipality_geometry_failures_diagnostic.json` + `municipality_geometry_failures_diagnostic.csv`
- Modified `tools/map/extract_municipality_borders_from_drzava.ts`: deterministic diagnostic for each municipality that fails geometry conversion (munid_5, name, raw_geometry_kind, failure_stage, failure_reason, detail, basic_stats). Outputs written to `data/derived/municipality_audit/`. No geometry repair, ring closing, smoothing, hulls, or inference.
- Extended `municipality_borders_extraction_report.json` with `municipality_failures`, `municipality_failures_by_reason`, `municipality_failed_ids`.
- Updated `tools/map/README.md`: where to find the failure diagnostic (municipality_audit, JSON + CSV).

**2026-01-25** - Repository cleanup, remove dead map scripts and v2 variants
- **Phase:** Map Rebuild (Path A)
- **Decision:** Delete only provably-unused files; keep anything referenced by package scripts, docs, or imports; determinism unchanged
- **Artifacts:** Cleanup report (kept/removed) committed to `docs/cleanup/2026-01-25_repo_cleanup.md`
- Removed `tools/map_v2/` directory (entire directory): only referenced in package.json scripts, no imports, no doc references, no test references. Deleted files: `build_map_v2.ts`, `unpack_inputs.ts`, `viewer_v2/` directory and all contents, `.cache/` directory.
- Removed 4 npm scripts from `package.json`: `map:v2:unpack`, `map:v2:build`, `map:v2:prep`, `map:v2:view`.
- Kept files that are referenced (even if potentially obsolete): `scripts/map/*.ts` (referenced in package.json), `tools/map_build/` (referenced in scripts and docs), `tools/map_viewer/` and `tools/map_viewer_simple/` (referenced in scripts), `tools/map/viewer.html` and `serve_viewer.js` (referenced in scripts).
- No behavior changes, no determinism changes, no core logic refactoring. Build validation: typecheck and canonical map scripts still run.

**2026-01-25** - Rule change — inferred municipality borders permitted from settlement-derived outlines
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:**
  * The prohibition on inferred municipality borders is lifted.
  * Settlement-derived municipality outlines are now permitted as a reconstruction source.
  * These borders are accepted as reconstructed, not surveyed.
- **Rationale:**
  * drzava.js geometry is incomplete and syntactically unreliable for municipalities.
  * A complete, internally consistent municipality layer is required for simulation reference.
- **Artifacts:**
  * Reconstructed municipality borders derived from legacy settlement outlines
  * Provenance and reconstruction method recorded per municipality
- Added `tools/map/reconstruct_municipalities_from_legacy.ts`: loads municipality outlines from `data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.zip`, unions fragments per municipality deterministically, applies ring closure and geometry normalization, outputs `municipality_borders_reconstructed.geojson` with full provenance properties.
- New npm script: `map:reconstruct:muni` (`npm run map:reconstruct:muni`)
- Outputs: `municipality_borders_reconstructed.geojson` (authoritative layer), `municipality_reconstruction_report.json` (statistics, unresolved IDs, geometry fixes applied)
- Each feature includes: `munid_5`, `name`, `source: "reconstructed_from_settlement_outlines"`, `reconstruction_method: "settlement_outline_union"`, `legacy_source_file`, `feature_index`
- Allowed operations: load legacy outlines, accept valid geometry as-is, union multiple geometries per municipality deterministically, merge fragments, ring closure, geometry normalization. NOT allowed: simplification, smoothing, snapping.
- ID resolution: from legacy outline attributes where present; if missing, derive via explicit lookup table (authored in-code); log ambiguous cases; do NOT invent new municipalities.
- Updated `tools/map/README.md`: documentation for reconstruction script, allowed operations, ID resolution, report structure.
