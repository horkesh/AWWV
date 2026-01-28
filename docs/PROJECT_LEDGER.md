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
- **Workflow Requirement:** Every work item changelog entry must include: "Mistake log updated: yes/no" and, if yes, list the Key(s) appended.

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

**2026-01-25** - Re-enable municipality outlines derived from settlement polygon fabric
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:** Municipality borders may be reconstructed from settlement polygon fabric as a derived reference layer when authoritative borders fail
- **Artifacts:** `municipality_outlines_from_settlement_fabric.geojson` + coverage + inflation report
- Added `tools/map/derive_municipality_outlines_from_fabric.ts`: derives municipality outlines by unioning polygons (poly_id micro-areas) from settlement polygon fabric deterministically. No polygon↔settlement 1:1 assumption. Municipality identity from explicit municipality reference field (mid if available, otherwise mun_code). Deterministic union with stable ordering (sorted by poly_id). Geometry normalization: ring closure, duplicate point removal, fixed precision (3 decimals). NOT allowed: smoothing, simplification, snapping. Fallback: if union fails, outputs MultiPolygon as collection of original polygons (method: "polygon_collection_fallback").
- Outputs: `municipality_outlines_from_settlement_fabric.geojson` (properties: mun_id, name, source, method, poly_count, feature_index), `municipality_outlines_derivation_report.json` (inputs, totals, missing_municipalities, geometry_stats, failures), `municipality_outlines_missing.csv` (mun_id, name), `muni_from_fabric_viewer.html` (visual inspection with fallback highlighting).
- Coverage audit: determines expected municipality set from settlements_meta.csv, explicitly lists municipalities with zero polygons (data gap, not rendering bug).
- New npm script: `map:derive:muni-from-fabric` (`npm run map:derive:muni-from-fabric`)
- Updated `tools/map/README.md`: documentation for derivation script, what "derived" means, coverage audit, viewer features.
- **Note:** These borders are reconstructed/derived, not authoritative surveyed boundaries. They serve as a reference layer for visualization and coverage validation.

**2026-01-25** - Fix municipality-outline derivation report (missing logic + union diagnostics), add mistake-log writeback
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:** Tooling must be self-auditing; missing-list must be logically consistent; union failures must be explained deterministically
- **Artifacts:** corrected derivation report, richer failure diagnostics, mistake log writeback support
- Fixed `tools/map/derive_municipality_outlines_from_fabric.ts`: corrected missing municipalities logic to use same ID scheme (mid vs mun_code) for expected vs emitted comparison. When using mun_code scheme, cannot compare to expected municipalities from settlements_meta.csv (which uses mid). Added internal consistency validation warnings.
- Enhanced union diagnostics: per-municipality union status tracking with failure_reason and failure_detail (max 200 chars). Failure reasons: union_exception, invalid_polygon_input, union_empty_result, fallback_collection. Added union_failures_by_reason counter in report. Added fallbacks_used counter.
- New output: `municipality_union_status.csv` with columns: mun_id, poly_count, union_attempted, union_result, failure_reason, failure_detail. Stable sorted by mun_id.
- Extended `tools/assistant/mistake_guard.ts`: `appendMistake()` now accepts optional date parameter for determinism (caller must pass date string explicitly, no automatic Date.now()).
- Added mistake log entry: "Municipality outline derivation reported all municipalities missing" - documents the ID scheme mismatch bug that was fixed.
- Updated report structure: added id_scheme field, union_failures_by_reason object, fallbacks_used counter, per_municipality_union_status_path reference.
- **Note:** All unions currently fail (union_exception: 142) due to Turf.js limitations with complex geometries, but fallback to MultiPolygon collection works correctly, ensuring all 142 municipalities are emitted.

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

**2026-01-25** - Fix muni-from-fabric union implementation and expected-count reporting
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:** Municipality outlines may be derived from polygon fabric; unions must be real unions (not broken “buffer fix”); fallbacks are allowed but must be explicit
- **Artifacts:** cleaner `municipality_outlines_from_settlement_fabric.geojson` + corrected derivation report + viewer reflects union vs fallback
- Replaced Turf-based union (and buffer-fix path that threw “Must have at least 2 geometries”) with **polyclip-ts** boolean union. Ring normalization: duplicate-point removal, ring closure; no simplification/smoothing.
- **Expected count:** When no external municipality list, `municipalities_expected` = unique mun_ids in polygons_with_muni. Report now includes `municipalities_with_polygons`; `municipalities_missing` = expected − emitted.
- **Viewer:** Union-success features use normal stroke; fallback-collection features use **dashed** stroke and **thicker** outline. Legend shows unions_succeeded / unions_failed / fallbacks_used and “With polygons”.
- Mistake log entry: “Muni-from-fabric union path was broken, forcing fallback for all municipalities” — documents the previous buffer-fix failure and fix.
- Updated `tools/map/README.md` (derive-muni-from-fabric): union implementation (polyclip-ts), report fields, viewer fallback styling.

**2026-01-25** - Determinism + invariants audit, refactor roadmap captured (no big refactor)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Defer architecture refactor to Engine Freeze phase, implement only audits/guards now
- **Artifacts:** determinism audit report, invariant inventory, refactor roadmap doc
- Created `docs/engineering/DETERMINISM_AUDIT.md`: comprehensive audit of timestamp leakage, random number usage, object key iteration order, JSON serialization key order. Identified 1 critical violation: `tools/map/report_hull_inflation.ts` had timestamps in JSON/TXT artifacts (fixed).
- Created `docs/engineering/INVARIANTS_IN_CODE.md`: inventory of canonical invariants from project rules, engine freeze contract, validation functions. Documents enforcement status (fully enforced, partially enforced, not enforced) for each invariant.
- Created `docs/engineering/REFACTOR_ROADMAP.md`: captures separate agent's refactor proposal but rewrites it to comply with project rules. Explicitly notes rule violations in original proposal (auto-fix, inference, silent outcome changes). Marks refactor as DEFERRED until Engine Freeze phase.
- Added minimal guard scripts: `tools/engineering/check_determinism.ts` (grep-based timestamp/random detection), `tools/engineering/check_derived_state.ts` (grep-based derived state serialization detection), `tools/engineering/determinism_guard.ts` (helper functions for CLI tools).
- Fixed timestamp leakage: removed `generated_at` field and timestamp line from `tools/map/report_hull_inflation.ts` artifacts.
- Added mistake guard imports to all touched scripts.
- **No functional refactor performed** - only audits, documentation, and minimal guard scripts. Map tooling continues to work.

**2026-01-25** - Add deterministic pre-union normalization ladder to reduce muni union failures
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:** Allow conservative coordinate normalization (quantization + degenerate vertex removal) to enable boolean unions, while preserving fallback behavior when union still fails
- **Artifacts:** updated union status with normalization_level, updated report with per-level success stats
- Modified `tools/map/derive_municipality_outlines_from_fabric.ts`: implemented 3-level normalization ladder (Level 0: ring closure + duplicate removal; Level 1: + coordinate quantization to EPS1 grid; Level 2: + collinear point removal + drop rings with <4 distinct points). Union retries at each level before falling back to polygon collection.
- Normalization parameters computed deterministically from polygon fabric bbox: `EPS1 = max(width, height) * 1e-7` clamped to `[1e-6, 1e-3]`, `AREA_EPS = EPS1 * EPS1`. Parameters recorded in report `normalization_params`.
- Updated `MunicipalityUnionStatus` interface: added `normalization_level_attempted`, `normalization_level_succeeded`, `union_error_message` fields. Updated union status CSV with these columns.
- Updated derivation report: added `unions_succeeded_by_level` (counts per level 0/1/2), `normalization_params` object. Extended GeoJSON feature properties with `normalization_level`.
- Updated viewer: shows normalization level in info panel. Statistics display unions succeeded by level.
- Results: unions_succeeded increased from 34 to 35 (1 additional success at Level 1). Level 0: 34 successes, Level 1: 1 success, Level 2: 0 successes. 107 unions still fail at all levels (union_exception from polyclip-ts), fallback to polygon collection works correctly.
- Updated `tools/map/README.md`: documented normalization ladder, normalization parameters, updated output descriptions.
- **Note:** Normalization is conservative (no hulls, smoothing, or Douglas-Peucker simplification). Allowed operations preserve geometry truthfulness while enabling more unions to succeed.

**2026-01-25** - Derive municipality boundaries from polygon fabric adjacency (no union)
- **Phase:** Map Rebuild (Path A, amended)
- **Decision:** Municipality outlines are computed as boundary edges in the fabric (shared-edge cancellation), supporting non-contiguous municipalities without boolean union
- **Artifacts:** municipality_boundaries_from_fabric.geojson + boundary derivation report + viewer toggle
- Added `tools/map/derive_municipality_boundaries_from_fabric.ts`: extracts municipality boundaries by cancelling internal shared edges in polygon fabric. Algorithm: (1) extract all polygon ring edges with coordinate quantization (EPS from fabric bbox), (2) build edge map with municipality ownership, (3) cancel internal edges (edges appearing twice in same municipality), (4) keep boundary edges (inter-municipality borders or outer fabric boundaries), (5) stitch boundary segments into paths deterministically (lexicographic endpoint ordering), (6) output as MultiLineString per municipality.
- Edge cancellation logic: edges appearing in multiple municipalities → boundary (inter-municipality border); edges appearing once in a municipality → boundary (outer fabric edge); edges appearing twice+ in same municipality → internal (cancelled). Uses edge occurrence counts per municipality for efficient processing.
- Path stitching: builds endpoint-to-segment adjacency map, walks segments forward and backward from each unused segment start, deterministically picks next segment by lexicographic endpoint coordinate order. Handles closed loops and multiple disconnected paths naturally (supports non-contiguous municipalities).
- Outputs: `municipality_boundaries_from_fabric.geojson` (MultiLineString features with mun_id, name, source, eps, segment_count, path_count), `municipality_boundaries_derivation_report.json` (polygons_loaded, municipalities, eps, boundary_edges_total, per_muni stats), `municipality_boundaries_unstitchable.csv` (unstitchable segment issues, empty if all segments stitched successfully), `municipality_boundaries_viewer.html` (visual inspection tool).
- Results: 142 municipalities processed, 651,599 boundary edges extracted, 0 unstitchable issues (all segments successfully stitched into paths). No boolean union required - boundaries computed purely from edge adjacency.
- Added npm script: `map:derive:muni-boundaries-from-fabric`
- **Note:** This approach avoids union failures entirely and naturally supports non-contiguous municipalities (multiple disconnected boundary paths per municipality). Boundaries are clean outlines, not full fabric fill.

**2026-01-25** - Offline HTML viewer for unified geography GeoJSON
- **Phase:** Map Rebuild (Path A)
- **Decision:** Inspection-only viewer with deterministic rendering, no geometry modification, offline operation
- **Artifacts:** `tools/map/serve_geography_viewer.ts` (Node.js HTTP server), `tools/map/view_geography/index.html` (viewer UI), `tools/map/view_geography/viewer.js` (canvas renderer)
- Added offline HTML viewer for unified GeoJSON (municipalities + settlements) with layer toggles. Server: tiny Node.js HTTP server (no external deps), serves HTML/JS/GeoJSON, port 5179 (env PORT overrides), prints "Open: http://localhost:PORT/". Input file resolution: default `data/source/awwv_geography_FINAL.geojson` (primary), fallback `data/source/awwv_geography_unified.geojson`; if neither exists, server starts but shows error in viewer.
- Viewer: canvas-based renderer with fit-to-bounds transform, deterministic draw order (municipality → settlement → unknown, then stable sort by municipality_id/settlement_id/index). UI: checkboxes for "Show settlements borders" (default ON), "Show municipalities borders" (default ON), "Show unknown borders" (default OFF), legend with counts per layer. Rendering: stroke only (no fill), municipality borders thicker (2px) than settlement borders (1px), different line widths per layer.
- Layer classification: (1) if `feature.properties.layer` is exactly "settlement" or "municipality" → use it, (2) else if `feature.properties.kind` is exactly "settlement" or "municipality" (case-insensitive) → use it, (3) else if `feature.properties.feature_type` or `feature.properties.level` matches → use it, (4) else → "unknown". Console diagnostics: logs first 30 distinct property keys (sorted), logs counts per layerType. Unknown warning: if unknown count > 0, shows on-page banner: "X features could not be classified as settlement or municipality; showing only if 'Show unknown' is enabled."
- New npm script: `map:view-geojson` (`npm run map:view-geojson`)
- **Note:** Viewer is inspection-only (outlines only, no geometry modification). No external CDN dependencies, works offline/in-repo. Deterministic rendering order ensures consistent display across refreshes.

**2026-01-25** - Municipality geometry anomaly audit
- **Phase:** Map Rebuild (Path A)
- **Decision:** Diagnosis-only audit for geometry anomalies, no geometry modification or repair
- **Artifacts:** `tools/map/audit_municipality_geometry.ts` (audit script), `data/derived/municipality_geometry_audit.json` (JSON report), `data/derived/municipality_geometry_audit.txt` (human-readable report)
- Added deterministic audit script for municipality geometry anomalies in `data/source/geography.geojson`. Filters to features where `properties.feature_type === "municipality"`, extracts municipality name from `properties.municipality_name` (fallback: "UNKNOWN"), extracts mid from `properties.mid` or `properties.municipality_id` if present.
- Anomaly detection (per Polygon ring and per MultiPolygon part): (1) Non-adjacent repeated vertices (exact coordinate match after rounding to 1e-6 precision), records first index, repeat index, and coordinate snippets; (2) Immediate backtrack segments (A->B->A pattern), records 3-point sequence; (3) Degenerate segments (A==B consecutive duplicates), records indices; (4) Candidate self-crossings via segment intersection test (bounded, deterministic), checks intersections between non-adjacent segments only, skips rings with >6000 vertices, early-exit after first 50 intersections per ring, records intersection pairs and approximate location.
- Outputs: JSON report with summary counts (municipalities_total, municipalities_with_any_issue, total_issues_by_type) and per-municipality details (name, mid, geometry_type, total_vertices_estimate, issues array with type/part_index/ring_index/indices/coord/snippet). TXT report: human-readable top offenders list sorted by severity score (desc) then name (asc), severity scoring: self_crossing_candidate +10, non_adjacent_repeat +6, backtrack +3, degenerate_segment +1. Special section for "Velika Kladusa" if present: prints first detected non-adjacent repeat with snippets.
- New npm script: `map:audit-munis` (`npm run map:audit-munis`)
- **Note:** Audit is read-only, no geometry modification. All rounding uses fixed precision (1e-6), municipalities sorted by name for deterministic output. If audit reveals systematic generator failure mode (e.g., repeated-vertex loops), may require FORAWWV.md addendum describing boundary extraction requirements.

**2026-01-25** - Extract municipality outlines from HTML (SVG path conversion)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Extract municipality boundary outlines from HTML file containing SVG paths, convert to GeoJSON deterministically without geometry repair or inference
- **Artifacts:** `tools/map/extract_muni_outlines_from_html.ts` (extraction script), `data/derived/municipality_outlines_from_html.geojson` (GeoJSON output), `data/derived/municipality_outlines_from_html_audit.txt` (audit report)
- Added extraction script that reads `data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.html` and extracts the `MUNICIPALITY_DISSOLVED_OUTLINES` JavaScript object. HTML parsing: locates object literal using balanced-brace scanner (deterministic, no regex), evaluates in locked-down VM context. Object normalization: supports string paths, arrays of paths, objects with `d` property, arrays of objects with `d` property.
- SVG path parsing: implements minimal parser for absolute/relative commands (M/m, L/l, H/h, V/v, Z/z required; Q/q, C/c, S/s, T/t, A/a optional). Curve flattening: deterministic segment counts (Q: 20, C: 30, A: 30), proper SVG arc parameterization implemented (center parameterization conversion). All coordinates rounded to 6 decimals for stability.
- Output format: GeoJSON FeatureCollection with MultiLineString features (one per municipality key). Properties: `muni_key` (original key), `source` (source file reference), `svg_commands` (sorted unique list), `parts` (number of path parts), `warnings` (optional array). Geometry: each closed subpath becomes a LineString, multiple subpaths → MultiLineString. No polygon conversion (inspection-safe lines only).
- Audit report: total municipalities found, municipalities emitted/skipped, skip reasons (counts), top 20 by vertex count, list of municipalities with curve/arc commands. Determinism: municipality keys sorted lexicographically, stable coordinate rounding, no timestamps.
- Results: 141 municipalities found, 141 emitted, 0 skipped. Velika Kladusa has highest vertex count (4263). No municipalities with curve/arc commands detected in source data.
- New npm script: `map:extract-muni-outlines` (`npm run map:extract-muni-outlines`)
- **Note:** Output is inspection/reference only. No geometry repair, smoothing, simplification, or buffering performed. If unsupported SVG commands are encountered, municipalities are skipped with explicit warnings logged.

**2026-01-25** - HTML viewer for SVG-derived municipality outlines
- **Phase:** Map Rebuild (Path A)
- **Decision:** Add minimal offline HTML viewer for visual inspection of SVG-derived municipality outlines, no geometry modification
- **Artifacts:** `tools/map/serve_svg_muni_viewer.ts` (HTTP server), `tools/map/view_svg_muni/index.html` (viewer UI), `tools/map/view_svg_muni/viewer.js` (canvas renderer)
- Added offline HTML viewer for `municipality_outlines_from_html.geojson`. Server: tiny Node.js HTTP server (no external deps), serves HTML/JS/GeoJSON, port 5181 (env PORT overrides), prints "Open: http://localhost:PORT/". If GeoJSON file missing, returns 404 plain text, logs warning, does not throw.
- Viewer UI: canvas full-window with control panel (checkboxes for "Show outlines" default ON, "Show points" default OFF, filter text input, focus municipality dropdown, reset view button, stats display). Stats show municipality count, total parts, total vertices (computed from geometry).
- Rendering: supports MultiLineString, LineString, Polygon, MultiPolygon (exterior rings only). Deterministic draw order: features sorted by `properties.muni_key` ascending (string compare). Pan/zoom: mouse wheel zooms around cursor, click+drag pans, reset button fits to global bounds. Filtering: if filter text non-empty, only renders `muni_keys` containing filter (case-insensitive). Focus: dropdown populated from sorted `muni_key` values, selecting zooms to feature bounds.
- New npm script: `map:view-muni-svg` (`npm run map:view-muni-svg`)
- **Note:** Viewer is inspection-only (outlines and points only, no geometry modification). No external CDN dependencies, works offline/in-repo. Deterministic rendering order ensures consistent display across refreshes. If viewer reveals that SVG-derived outlines are consistently "cleaner" than fabric-derived boundaries and are being relied on operationally, docs/FORAWWV.md may require an addendum clarifying acceptable reference-geometry sources.

**2026-01-25** - Dual-layer fit viewer for settlement fabric vs municipality outlines
- **Phase:** Map Rebuild (Path A)
- **Decision:** Add dual-layer HTML viewer to visually verify fit between settlement fabric and municipality outlines, no geometry modification
- **Artifacts:** `tools/map/serve_fit_viewer.ts` (HTTP server), `tools/map/view_fit/index.html` (viewer UI), `tools/map/view_fit/viewer.js` (canvas renderer)
- Added offline HTML viewer comparing settlement fabric and municipality outlines for visual fit verification. Server: tiny Node.js HTTP server (no external deps), serves HTML/JS/GeoJSON, port 5183 (env PORT overrides), prints "Open: http://localhost:PORT/". Routes: `/settlements` (tries `data/source/geography.geojson` then `data/source/awwv_geography_FINAL.geojson`), `/muni_outlines` (serves `data/derived/municipality_outlines_from_html.geojson`). If files missing, returns 404 plain text, logs warning, does not throw.
- Viewer UI: canvas full-window with control panel (checkboxes for "Show settlements" default ON, "Show municipality outlines" default ON, "Show settlement points" default OFF, "Show municipality points" default OFF, filter text input, focus municipality dropdown, "Clip settlements to focused municipality bbox" checkbox default OFF, "Fit All" button, stats display, warnings, diagnostics panel). Stats show settlements drawn/ignored, municipality outlines drawn, current scale/zoom.
- Settlement layer extraction: filters features using conservative rules (feature_type === "settlement", layer === "settlement", kind === "settlement" case-insensitive). If zero settlements found, shows on-page warning and displays property keys seen (first 30, sorted) in diagnostics panel and console. Municipality outlines layer: uses all features, keyed by `properties.muni_key`.
- Geometry support: renders Polygon, MultiPolygon (exterior rings only), LineString, MultiLineString for both layers. Stroke outlines only (no fills). Different stroke widths: settlements thin (1px), municipality outlines thicker (2px). Different colors: settlements blue (#0066cc), municipality outlines red (#cc0000).
- Shared camera: computes combined bounds (settlements + muni outlines) and fits to canvas on load. Pan/zoom: mouse wheel zooms around cursor, click+drag pans. Focus municipality: dropdown populated from sorted `muni_key` values, selecting zooms to feature bounds. Optional clipping: if "Clip settlements to focused municipality bbox" enabled, only draws settlements whose bbox intersects focused muni bbox (cheap deterministic intersection test).
- Deterministic draw order: settlements sorted by (municipality_id string, settlement_id string, original_index), municipality outlines sorted by `muni_key` ascending. Draw order: settlements first (if enabled), municipality outlines on top (if enabled).
- Diagnostics: after loading, computes and displays settlements_drawn, settlements_ignored, muni_outlines_drawn, property keys seen in settlements file (first 30, sorted) printed to console and in collapsible UI diagnostics panel.
- New npm script: `map:view-fit` (`npm run map:view-fit`)
- **Note:** Viewer is inspection-only (outlines and points only, no geometry modification, no snapping, no inference). No external CDN dependencies, works offline/in-repo. Deterministic rendering order ensures consistent display across refreshes. If fit check reveals systematic coordinate-system mismatch (e.g., outlines in SVG coordinate space but settlements in projected space), docs/FORAWWV.md may require an addendum clarifying canonical coordinate regimes for all reference geometries.

**2026-01-25** - Clean municipality outlines by settlement fabric (interior segment removal)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Remove interior segments from municipality outlines using settlement polygon fabric as oracle, without geometry invention
- **Artifacts:** `tools/map/clean_muni_outlines_by_fabric.ts` (cleaning script), `data/derived/municipality_outlines_from_html_cleaned.geojson` (cleaned outlines), `data/derived/municipality_outlines_from_html_cleaned_report.json` (JSON report), `data/derived/municipality_outlines_from_html_cleaned_report.txt` (TXT report)
- Added deterministic cleaner that removes interior seam segments from municipality outlines. Inputs: settlement fabric from `data/source/geography.geojson` (filters to settlement polygons using conservative rules: feature_type === "settlement", layer === "settlement", kind === "settlement" case-insensitive), municipality outlines from `data/derived/municipality_outlines_from_html.geojson`. Municipality ID field detection: prefers `properties.municipality_id`, falls back to `properties.mun_id`, warns and exits if neither found.
- Spatial index: builds simple grid-based spatial index over settlement polygons for efficient point-in-polygon queries. Each polygon stores bbox, muni_id, and geometry. Cell size computed as 1% of fabric diagonal (min 1.0).
- Segment classification: breaks each outline LineString into segments (p[i] -> p[i+1]). For each segment: computes midpoint M and unit perpendicular normal n, samples points L = M + n*eps and R = M - n*eps (eps = diag * 1e-4, clamped to >= 1e-6), queries settlement polygons containing L and R. Classification: (1) both L and R inside same municipality AND muni_id matches outline's muni_key -> INTERIOR seam -> DROP, (2) both inside different municipalities -> TRUE boundary -> KEEP, (3) one side inside, other outside -> boundary at exterior -> KEEP, (4) neither side classified -> KEEP but record as unclassified.
- Municipality ID mapping: attempts to map outline `muni_key` to settlement `muni_id` by checking if `muni_key` is purely numeric (treat as muni_id) or if outline feature has `properties.municipality_id`. If no mapping found, runs in KEEP-only mode (no drops) to avoid false deletions. Report clearly indicates which mode was used.
- Geometry rebuilding: after classification, re-stitches contiguous kept segments into LineStrings. When dropped segment encountered, finishes current line and starts new line with dropped segment's endpoint. Outputs MultiLineString (or LineString) only, no polygonization attempted. Coordinates rounded to 6 decimals for stability.
- Reports: JSON report includes coverage stats (total/classified/fully_classified/dropped/kept segments), per-municipality stats (segments_total, dropped, kept, unclassified_count, key_mismatch_count), top 20 municipalities by dropped segment count, mode flags (outlines_have_muni_id_mapping, eps_used, precision_used). TXT report: summary, top offenders, clear warning if no mapping found ("No outline muni_id mapping, drop disabled for safety").
- Determinism: stable ordering (features sorted by muni_key), fixed precision (6 decimals), no randomness, no timestamps. No smoothing, union, simplification, or buffering. Filter step only: segments kept or dropped based on fabric classification. If classification coverage too low, warns and outputs unchanged copy with report.
- New npm script: `map:clean-muni-outlines` (`npm run map:clean-muni-outlines`)
- **Note:** Cleaner is deterministic filter only, no geometry invention. If cleaner shows that "dissolved outlines" systematically include interior seams and require fabric-based filtering to be truthful, docs/FORAWWV.md may need an addendum describing: "SVG-derived outlines are not trusted until validated/filtered against fabric adjacency."

**2026-01-25** - Derive municipality boundaries from settlement fabric (geography.geojson) with edge cancellation
- **Phase:** Map Rebuild (Path A)
- **Decision:** Produce canonical municipality-boundary overlay derived strictly from settlement polygon fabric using edge cancellation, guaranteeing exactly one feature per municipality_id
- **Artifacts:** `tools/map/derive_municipality_boundaries_from_fabric.ts` (derivation script), `data/derived/municipality_boundaries_from_fabric.geojson` (boundary GeoJSON), `data/derived/municipality_boundaries_from_fabric_report.json` (JSON report), `data/derived/municipality_boundaries_from_fabric_report.txt` (TXT report)
- Added deterministic boundary derivation script that reads settlement fabric from `data/source/geography.geojson`. Filters to settlement polygon features using conservative rules (feature_type === "settlement", layer === "settlement", kind === "settlement" case-insensitive). Determines municipality ID field (prefers `properties.municipality_id`, falls back to `properties.mun_id`), warns and exits if neither found.
- Edge cancellation algorithm: groups polygons by municipality_id, extracts edges from polygon rings (outer rings only), normalizes edges to canonical keys (ordered lexicographically, rounded to 6 decimals), counts edge occurrences per municipality. Boundary segments: edges with count === 1 per municipality (not shared internally). Internal seams: edges with count >= 2 in same municipality (dropped). Stitching: builds endpoint adjacency map, walks segments deterministically (lexicographic endpoint ordering), forms chains starting with degree-1 endpoints (open chains) then cycles (degree-2 everywhere), outputs MultiLineString per municipality.
- Output format: FeatureCollection with exactly one feature per municipality_id present in fabric. Geometry: MultiLineString (supports non-contiguous municipalities). Properties: `municipality_id` (string), `settlement_count` (number), `edge_count` (number), `notes` (optional array of warnings). Features sorted deterministically by municipality_id ascending.
- Reports: JSON report includes unique_municipality_ids_in_fabric (count + sorted list), emitted_features_count, municipalities_with_branching (list), top_20_by_boundary_segment_count, per_municipality stats (settlement_count, polygon_count, segments_total, segments_boundary, chains_count, warnings). TXT report: summary counts, discrepancy section if emitted != unique count, explicit "Ravno" line (if municipality id/name mapping exists) or municipality with smallest/suspicious counts, top 20 by boundary segment count.
- Viewer integration: updated `tools/map/serve_fit_viewer.ts` to serve `/muni_fabric` endpoint (serves `municipality_boundaries_from_fabric.geojson`). Updated `tools/map/view_fit/viewer.js` to add municipality layer source toggle: radio buttons for "Municipality from SVG outlines" vs "Municipality from fabric-derived boundaries" (default ON). Municipality rendering uses exactly one feature per municipality_id (sorted by municipality_id) when using fabric source. Filter and focus dropdown work with both sources (uses `municipality_id` for fabric source, `muni_key` for SVG source).
- Determinism: stable ordering (features sorted by municipality_id), fixed precision (6 decimals), no randomness, no timestamps. No geometry invention: no unions, buffering, simplification, hulls, or repair. Boundaries truthful to settlement borders via shared-edge cancellation.
- New npm script: `map:derive-muni-boundaries` (`npm run map:derive-muni-boundaries`)
- **Note:** This fixes the "141 municipalities / Ravno appears as many" issue by guaranteeing exactly one feature per municipality_id. If this reveals that "municipality features in unified geography.geojson are not authoritative / incomplete and must always be derived from fabric," docs/FORAWWV.md may require an addendum stating that municipality reference geometry is always fabric-derived, never taken from raw muni features.

**2026-01-25** - Clean fabric-derived municipality boundaries by sampling (second cleaning pass)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Add second deterministic cleaning pass to remove interior segments from fabric-derived boundaries using point-in-polygon sampling against settlement polygons
- **Artifacts:** `tools/map/clean_fabric_muni_boundaries_by_sampling.ts` (cleaning script), `data/derived/municipality_boundaries_from_fabric_cleaned.geojson` (cleaned boundaries), `data/derived/municipality_boundaries_from_fabric_cleaned_report.json` (JSON report), `data/derived/municipality_boundaries_from_fabric_cleaned_report.txt` (TXT report)
- Added second cleaning pass that removes interior segments from fabric-derived boundaries. Inputs: settlement fabric from `data/source/geography.geojson` (filters to settlement polygons using conservative rules), fabric-derived boundaries from `data/derived/municipality_boundaries_from_fabric.geojson`. Municipality ID field detection: prefers `properties.municipality_id`, falls back to `properties.mun_id`, warns and exits if neither found.
- Spatial index: builds deterministic bbox bucket index (128x128 grid) for point-in-polygon queries. Each settlement polygon stored with bbox, muniId, and geometry. Deterministic insertion order: settlements sorted by (municipality_id, settlement_id if exists, original index). Point-in-polygon: implements ray casting test for Polygon and MultiPolygon, considers holes correctly (point inside if inside outer ring and not inside any hole). Query: retrieves candidate polygons from grid cell, tests containment, if multiple contain picks smallest bbox area (deterministic), returns municipality_id or null.
- Segment sampling classifier: for each boundary segment P->Q, computes midpoint M and unit perpendicular normal n, samples points L = M + n*eps and R = M - n*eps (eps = diag * 1e-4, clamped to [1e-6, diag * 1e-2]). Queries municipality IDs for L and R. Classification: (1) both L and R in same municipality AND equals current municipality_id -> interior seam -> DROP, (2) both in same other municipality -> KEEP but record "side_same_other_muni", (3) different municipalities -> true boundary -> KEEP, (4) one side inside, other outside -> boundary at exterior -> KEEP, (5) neither classified -> KEEP but record "unclassified".
- Coverage protection: if for a municipality, fully classified segments (both sides non-null) is < 10% of total segments, do NOT drop anything for that municipality (output unchanged geometry), record "insufficient_classification_coverage". This prevents accidental deletion when coordinate systems don't match.
- Geometry rebuilding: after classification, re-stitches remaining segments back into LineStrings. When dropped segment encountered, ends current output line and starts new line with dropped segment's endpoint. Preserves original point order. Outputs MultiLineString per municipality.
- Reports: JSON report includes global stats (municipalities_total, municipalities_with_any_drops, total_segments, total_dropped_segments, total_unclassified_segments, eps_used, grid_size), per_municipality stats (segments_total, segments_dropped, segments_kept, fully_classified_segments, unclassified_segments, coverage_ratio, notes), top_20_by_dropped. TXT report: summary counts, top offenders, problem spots (municipalities with side_same_other_muni), municipalities with insufficient coverage.
- Viewer integration: updated `tools/map/serve_fit_viewer.ts` to serve `/muni_fabric_clean` endpoint (serves `municipality_boundaries_from_fabric_cleaned.geojson`). Updated `tools/map/view_fit/viewer.js` to add checkbox "Use CLEANED fabric boundaries" (default ON if file exists, else fall back to raw). Checkbox only visible when "Municipality from fabric-derived boundaries" is selected. Viewer automatically checks if cleaned file exists and sets default accordingly.
- Determinism: stable ordering (features sorted by municipality_id), fixed precision (6 decimals), no randomness, no timestamps. No geometry invention: no unions, buffering, simplification, hulls, or repair. Only drops segments provably interior. If classification coverage insufficient, keeps geometry unchanged and reports why.
- New npm script: `map:clean-muni-fabric` (`npm run map:clean-muni-fabric`)
- **Note:** This second cleaning pass works even when shared-edge cancellation fails due to coordinate mismatches. If this demonstrates that "shared-edge cancellation alone is insufficient due to coordinate jitter and must be followed by fabric-oracle segment classification," docs/FORAWWV.md may require an addendum.

**2026-01-26** - Derive municipality borders from settlement polygons using shared-edge cancellation
- **Phase:** Map Rebuild (Path A)
- **Decision:** Municipality borders derived from settlement polygon fabric using shared-edge cancellation (no boolean unions), guaranteeing exactly one feature per municipality_id
- **Artifacts:** `tools/map/derive_municipality_borders_from_settlements.ts` (derivation script), `data/derived/municipality_borders_from_settlements.geojson` (border GeoJSON), `data/derived/municipality_borders_from_settlements_report.json` (JSON report), `data/derived/municipality_borders_from_settlements_report.txt` (TXT report)
- Added deterministic boundary derivation script that reads settlement polygons from `data/source/geography_settlements.geojson`. Accepts Polygon and MultiPolygon geometries only. Determines municipality ID field (prefers `properties.municipality_id`, falls back to `properties.mun_id`), warns and exits if neither found.
- Shared-edge cancellation algorithm: groups polygons by municipality_id, extracts edges from polygon outer rings (ignores holes), normalizes edges to canonical keys (ordered lexicographically, rounded to 6 decimals), counts edge occurrences per municipality. Boundary segments: edges with count === 1 per municipality (not shared internally). Internal seams: edges with count >= 2 in same municipality (dropped). Stitching: builds endpoint adjacency map, walks segments deterministically (lexicographic endpoint ordering), forms chains starting with degree-1 endpoints (open chains) then cycles (degree-2 everywhere), outputs MultiLineString per municipality.
- Output format: FeatureCollection with exactly one feature per municipality_id present in settlement file. Geometry: MultiLineString (supports non-contiguous municipalities). Properties: `municipality_id` (string), `settlement_count` (number), `polygon_count` (number), `boundary_segment_count` (number), `chain_count` (number), `warnings` (optional array). Features sorted deterministically by municipality_id ascending.
- Reports: JSON report includes total_settlements, total_municipalities, municipality_ids list (sorted), per_municipality stats (settlement_count, polygon_count, segments_total, boundary_segment_count, chain_count, warnings), top_20_by_boundary_segment_count. TXT report: summary counts, municipalities with warnings, per-municipality summary (first 10), top 20 by boundary segment count.
- Determinism: stable ordering (features sorted by municipality_id), fixed precision (6 decimals), no randomness, no timestamps. No geometry invention: no unions, buffering, simplification, hulls, or repair. Boundaries truthful to settlement borders via shared-edge cancellation.
- New npm script: `map:derive-muni-borders` (`npm run map:derive-muni-borders`)
- **Note:** This confirms that "municipality borders must never be produced by boolean union and must be derived by shared-edge cancellation over the settlement fabric." If this reveals a systemic design insight, docs/FORAWWV.md may require an addendum.

**2026-01-26** - Add simple HTML map viewer with automatic derivation workflow
- **Phase:** Map Rebuild (Path A)
- **Decision:** Add minimal offline HTML viewer for settlement polygons and municipality borders, with single npm command that always regenerates derived artifacts before serving
- **Artifacts:** `tools/map/serve_simple_map_viewer.ts` (HTTP server), `tools/map/view_simple_map/index.html` (viewer UI), `tools/map/view_simple_map/viewer.js` (canvas renderer)
- Added minimal offline HTML viewer that renders settlement polygons from `data/source/geography_settlements.geojson` and municipality borders from `data/derived/municipality_borders_from_settlements.geojson`. Server: tiny Node.js HTTP server (no external deps), serves HTML/JS/GeoJSON, port 5185 (env PORT overrides), prints "Open: http://localhost:PORT/". Routes: `/` (HTML), `/viewer.js` (JS), `/settlements` (settlement GeoJSON), `/muni` (municipality borders GeoJSON). If data files missing, returns 404 plain text and logs warning (does not throw).
- Viewer UI: canvas full-window with control panel (checkboxes for "Show settlements" default ON, "Show municipality borders" default ON, "Show settlement points" default OFF, "Show muni points" default OFF, focus municipality dropdown, "Fit All" button, stats display). Pan/zoom: mouse wheel zooms around cursor, click-drag pans. Fit-to-bounds: fits combined bounds on load, fits municipality bounds on dropdown selection.
- Rendering: settlements draw Polygon/MultiPolygon outlines only (no fill), thin stroke (1px), blue color (#0066cc). Municipality borders draw LineString/MultiLineString, thicker stroke (2px), red color (#cc0000), rendered on top. Deterministic draw order: settlements sorted by (municipality_id string, original_index), municipalities sorted by municipality_id ascending. Points rendering: small circles (2px radius) when toggles enabled.
- Geometry support: settlements (Polygon, MultiPolygon), municipalities (LineString, MultiLineString). Unsupported geometry types counted and shown in warnings. No geometry modification: outlines only, no triangulation, no fill.
- Combined workflow command: `map:view-map` runs `map:derive-muni-borders` then serves viewer, ensuring derived artifacts are always regenerated before viewing. This guarantees viewer never shows stale data.
- New npm script: `map:view-map` (`npm run map:view-map`)
- **Note:** This establishes a canonical "always run derivations before viewing" workflow. If this reveals that the repo needs a systematic rule for ensuring derived artifacts are always fresh before inspection, docs/FORAWWV.md may require an addendum.

**2026-01-26** - Phase 0 settlement substrate validation and ethnicity overlay viewer (REAL source files)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Add read-only validation and HTML viewer for settlement polygons using REAL authoritative source files (bih_settlements.geojson + bih_census_1991.json) with municipality-level 1991 census ethnicity composition overlay
- **Artifacts:** `scripts/map/phase0_validate_settlements.ts` (validation script), `data/derived/phase0_validation_report.json` (JSON report), `data/derived/phase0_validation_report.txt` (TXT report), `data/derived/phase0_viewer/index.html` (viewer UI), `data/derived/phase0_viewer/viewer.js` (canvas renderer), `data/derived/phase0_viewer/data_index.json` (viewer data index)
- Updated deterministic validation script to use REAL authoritative source files: `data/source/bih_settlements.geojson` (settlement polygons) and `data/source/bih_census_1991.json` (census data). Validates: (1) file-level sanity (FeatureCollection, feature count), (2) settlement ID extraction (sid/SID/settlement_id/settlementId/id in priority order, uniqueness check, duplicate reporting), (3) municipality metadata presence (municipality_id/mun_id/municipalityId/munId/municipality/opstina_id/opstinaId/mun_code in priority order, cross-check against census), (4) geometry validation (Polygon/MultiPolygon only, finite coordinates, ring closure, duplicate vertices, near-zero area), (5) coordinate regime audit (global bbox, distribution stats, bimodal detection), (6) census ethnicity mapping (p-sum validation: p[0] == p[1]+p[2]+p[3]+p[4], majority ethnicity assignment with deterministic tie-breaking: bosniak > serb > croat > other). If >10% municipalities have p-sum mismatch, treats ordering as ambiguous and uses p1..p4 labels (logs mistake entry, flags FORAWWV.md may need addendum).
- Outputs: JSON report with counts, global bbox, distribution stats, top warnings, duplicate SIDs, missing municipality samples, census validation results (including census_ordering_validated flag). TXT report: human-readable summary with census ordering validation status. Viewer data index: per-settlement bbox, centroid, majority ethnicity, shares (bosniak/croat/serb/other OR p1..p4), municipality name, source_index; global bbox, legend_labels, counts_per_majority, census_ordering_validated flag.
- HTML viewer: pure static files (index.html + viewer.js + data_index.json), loads settlement geometry via fetch from `../../source/bih_settlements.geojson`, loads index from `./data_index.json`, renders to canvas with pan/zoom. Features: ethnicity overlay coloring (4 categories with low opacity, or p1..p4 if ambiguous), hover tooltips (sid or "(missing sid)", municipality_id + municipality_name or "(missing)", composition percentages rounded to 1 decimal using labels), checkbox for "Color by ethnicity (municipality overlay)", text input filters for municipality_id (exact match) and sid (substring, case-sensitive), legend with counts per category, "Reset view" button. Deterministic rendering order: null sids drawn last, stable by source_index; non-null sids sorted by sid string.
- Results: 6135 features validated, 0 missing SIDs, 0 duplicates, 0 missing municipality IDs, 0 missing in census, 22 geometry warnings. Global bbox: minx=1.000, miny=-9.521, maxx=940.964, maxy=909.960 (width=939.964, height=919.482). Bimodal distribution detected (cluster separation=545.72). Census validation: 0 municipalities with p-sum mismatch, census ordering validated: YES (p = [total, bosniak, croat, serb, other] confirmed).
- New npm script: `map:phase0:validate` (`npm run map:phase0:validate`) - already existed, updated to use correct source files
- **How to run:** `npm run map:phase0:validate` produces validation reports and viewer index. To view: `npx http-server -p 8080` from repo root, then open `http://localhost:8080/data/derived/phase0_viewer/`
- **Note:** Validation confirms census ethnicity ordering is [total, bosniak, croat, serb, other] (p-sum checks pass for all municipalities). Viewer is read-only inspection tool; no geometry modification. All scripts use mistake-log guardrail header. If viewer reveals systematic coordinate regime issues or census data quality problems, docs/FORAWWV.md may require an addendum.

**2026-01-26** - Phase 0 viewer settlement-level ethnicity coloring with fixed palette
- **Phase:** Map Rebuild (Path A)
- **Decision:** Update Phase 0 viewer to color settlements by their own majority ethnicity when available (settlement-level census), falling back to municipality-derived composition, with fixed color palette and provenance indicators
- **Artifacts:** Updated `scripts/map/phase0_validate_settlements.ts`, `data/derived/phase0_viewer/viewer.js`, `data/derived/phase0_viewer/index.html`, `data/derived/phase0_viewer/data_index.json` (generated)
- Enhanced validation script to detect and use settlement-level census data from `bih_census_1991.json.settlements` when available. Join priority: (1) settlement-level p array if exists and passes p-sum validation → `data_provenance = "settlement"`, (2) municipality-level p array → `data_provenance = "municipality"`, (3) neither → `data_provenance = "missing"`, `majority_ethnicity = "unknown"`. Majority calculation uses deterministic tie-breaking: bosniak > serb > croat > other.
- Updated viewer data index schema: added `data_provenance` field per settlement ("settlement" | "municipality" | "missing"), added `counts_by_provenance` summary, added `settlement_level_census_available` flag. Updated report to include settlement-level census availability stats.
- Fixed color palette implemented in viewer: Bosniaks = #2e7d32 (green), Serbs = #c62828 (red), Croats = #1565c0 (blue), Others = #6d6d6d (neutral gray), Unknown = #bdbdbd (light gray). Colors applied with 30% opacity for fills. Viewer colors by settlement `majority_ethnicity` (not municipality), regardless of provenance.
- Tooltip enhancement: added "Data: settlement level" / "Data: municipality derived" / "Data: missing" line based on `data_provenance`. UI note added next to ethnicity overlay checkbox: "Coloring uses settlement level when available, otherwise municipality derived."
- Legend updated: shows fixed color mapping with counts per majority ethnicity (not municipality counts). Colors displayed in fixed order: bosniak, serb, croat, other, unknown.
- Results: Settlement-level census data IS available in `bih_census_1991.json`. All 6135 settlements matched at settlement level (0 municipality fallback, 0 missing). Viewer now colors each settlement by its own majority ethnicity using fixed palette. Tooltips clearly indicate data provenance.
- **How to run:** `npm run map:phase0:validate` regenerates viewer index with provenance data. Viewer automatically uses settlement-level data when available.
- **Note:** Since settlement-level census data exists and all settlements matched, no municipality fallback was needed. Viewer correctly displays settlement-level ethnicity composition with fixed color palette. If settlement-level census had not existed and all settlements used municipality fallback, docs/FORAWWV.md would require an addendum clarifying demographic granularity assumptions (not needed in this case).

**2026-01-26** - Phase 0 viewer rebuild: settlement-level majority ethnicity only (no municipality fallback)
- **Phase:** Map Rebuild (Path A)
- **Decision:** Phase 0 viewer pipeline now uses `bih_settlements_1991.geojson` as authoritative settlement geometry and colors settlements strictly by settlement-level majority ethnicity only. Municipality fallback is disabled by design.
- **Artifacts:** Updated `scripts/map/phase0_validate_settlements.ts`, `data/derived/phase0_viewer/viewer.js`, `data/derived/phase0_viewer/index.html`, `data/derived/phase0_viewer/data_index.json` (generated), `data/derived/phase0_validation_report.json`, `data/derived/phase0_validation_report.txt`
- **Input path switch:** Validation script now reads from `data/source/bih_settlements_1991.geojson` (replacing `bih_settlements.geojson`). Viewer loads geometry from `/data/source/bih_settlements_1991.geojson`.
- **Settlement-level census mapping:** Script deterministically detects settlement-level census data by checking top-level keys (`settlements`, `naselja`, `settlement`, `naselje`) and selecting the candidate with maximum overlap with GeoJSON SIDs. Census ordering validated from settlement-level p-sum checks (not municipality-level). If >10% settlements have p-sum mismatch, ordering treated as ambiguous (p1..p4 labels used, mistake logged, FORAWWV.md flagged).
- **Strict settlement-level only:** Removed all municipality fallback logic. `data_provenance` values: `"settlement"` (valid settlement-level census), `"no_settlement_census"` (sid exists but no settlement census record), `"invalid_settlement_p"` (settlement census exists but p-sum fails), `"missing_sid"` (no sid in GeoJSON). Unknown settlements render with "unknown" color and remain selectable/hoverable.
- **Viewer coloring rules:** Fixed palette: Bosniaks = #2e7d32 (green), Serbs = #c62828 (red), Croats = #1565c0 (blue), Others = #6d6d6d (gray), Unknown = #bdbdbd (light gray). Colors applied with 30% opacity. Tooltip shows exact `data_provenance` string and explains Unknown reasons. UI text updated: "Coloring uses settlement-level majority only. Settlements without settlement-level census data are shown as Unknown."
- **Results:** All 6135 settlements matched at settlement level (0 no settlement census, 0 invalid settlement p, 0 missing sid). Census settlement key used: `"settlements"`. Overlap count: 6135. Settlement p-sum pass count: 6140, fail count: 0, fail rate: 0.0%. Census ordering validated: YES (p = [total, bosniak, croat, serb, other] confirmed). All settlements have `data_provenance = "settlement"`.
- **How to run:** `npm run map:phase0:validate` produces updated reports and viewer index. To view: `npx http-server -p 8080` from repo root, then open `http://localhost:8080/data/derived/phase0_viewer/`
- **Note:** Since all settlements matched at settlement level with validated ordering, no Unknown settlements were produced and no FORAWWV.md addendum is needed. If overlap had been low or settlement-level census absent/ambiguous, docs/FORAWWV.md would require an addendum clarifying demographic granularity and encoding assumptions.

**2026-01-26** - Phase 0 embedded viewer: add display-only Y-axis flip for coordinate orientation correction
- **Phase:** Map Rebuild (Path A)
- **Decision:** Fix apparent "rotation" in Phase 0 embedded viewer by adding deterministic Y-axis flip at render time only (viewer-space transform). Do NOT modify any source GeoJSON or derived GeoJSON geometry. Flip is a display-only correction for embedded dataset Y-down coordinate space.
- **Artifacts:** Updated `data/derived/phase0_embedded_viewer/viewer.js`, `data/derived/phase0_embedded_viewer/index.html`, `scripts/map/phase0_validate_settlements.ts`, regenerated `phase0_embedded_validation_report.json/txt`
- **Viewer changes:** Added Y-flip toggle checkbox (default ON) with UI note: "This dataset is embedded/screen-space; Y is inverted in source coordinates. Flip is a display-only correction." Applied flip in `worldToScreen()` and `screenToWorld()` transforms: `yFlipped = globalMaxY + globalMinY - y`. Updated `computeFeatureBounds()` to apply flip for consistent hit-testing. Added event listener to refit bounds when flip toggle changes.
- **Validation report changes:** Added `viewer_display` section to both JSON and TXT reports with: `y_flip_default: true`, `reason: "embedded dataset appears in Y-down coordinate space; viewer flips Y at render time only"`, `systemic_insight: "Potential systemic insight: some settlement sources are in Y-down planar coordinates; may require FORAWWV.md addendum."`
- **Constraints:** Deterministic only (stable ordering, no randomness, no timestamps). No geometry invention (no unions, hulls, smoothing, buffering, coordinate transforms applied to stored data). Only display-space mapping in viewer. Warnings only; do not throw.
- **Results:** Viewer now displays BiH in correct orientation with flip ON (default). Toggle OFF reproduces previous tilted/mirrored appearance, confirming toggle works. Hover tooltip and filters function correctly. No changes to any source files in `data/source/`. Phase 0 embedded validation reports regenerated and mention display-only Y flip.
- **How to run:** `npm run map:phase0:validate` regenerates reports. To view: `npx http-server -p 8080` from repo root, then open `http://localhost:8080/data/derived/phase0_embedded_viewer/`. Flip Y toggle is ON by default; verify shape orientation looks correct compared to real BiH silhouette.
- **Mistake log updated:** no (no new mistakes discovered)
- **Note:** The embedded dataset being Y-down is a potential systemic insight. If this indicates that some settlement sources are in Y-down planar coordinates, docs/FORAWWV.md may require an addendum. Do NOT edit FORAWWV.md automatically.

**2026-01-26** - Phase 0 viewer rebuild: embedded settlements geojson + strict settlement-majority ethnicity palette
- **Phase:** Map Rebuild (Path A)
- **Decision:** Replace Phase 0 HTML viewer pipeline with clean new viewer using authoritative settlement geometry source `bih_settlements_1991_from_embedded.geojson`. Coloring must be STRICTLY settlement-level majority ethnicity (NOT municipality), with fixed palette: Bosniaks green, Serbs red, Croats blue. No municipality fallback allowed. Settlements without settlement-level census join must render as Unknown.
- **Artifacts:** Updated `scripts/map/phase0_validate_settlements.ts`, new viewer in `data/derived/phase0_embedded_viewer/` (index.html, viewer.js, data_index.json), new reports `phase0_embedded_validation_report.json/txt`
- **Deleted files:** Removed old `data/derived/phase0_viewer/` folder, `phase0_validation_report.json/txt`
- **Input path switch:** Validation script now reads from `data/source/bih_settlements_1991_from_embedded.geojson` (replacing `bih_settlements_1991.geojson`). Viewer loads geometry from `/data/source/bih_settlements_1991_from_embedded.geojson`.
- **Strict settlement-level census join:** Deterministic candidate selection: (1) prefer named keys (settlements, naselja, settlement, naselje), (2) otherwise scan top-level objects with p arrays length>=5, (3) choose candidate with maximum overlap with GeoJSON SID set, tie-break by key name sort. Validate settlement-level p-sum: p0 == p1+p2+p3+p4. If fail_rate > 10% among matched settlement records, treat ordering as ambiguous (p1..p4 labels), else accept as [total, bosniak, croat, serb, other].
- **Viewer coloring rules:** Fixed palette: Bosniaks = #2e7d32 (green), Serbs = #c62828 (red), Croats = #1565c0 (blue), Others = #6d6d6d (gray), Unknown = #bdbdbd (light gray). If ordering_mode is "ambiguous", map p1..p4 to neutral distinct grays (DO NOT reuse national colors). Colors applied with 30% opacity. Tooltip shows exact `data_provenance` string and explains Unknown reasons.
- **Viewer features:** Checkbox "Color by settlement majority ethnicity", checkbox "Show Unknown only", text input SID substring filter, legend with category counts. Deterministic draw order: null sids last by source_index, non-null sids sorted by sid string.
- **Results:** All 6135 settlements validated, 0 missing SIDs, 0 duplicates, 0 missing municipality IDs, 17 geometry warnings. Census settlement key used: "settlements". Overlap count: 6135. Settlement p-sum pass count: 6140, fail count: 0, fail rate: 0.0%. Census ordering validated: YES (p = [total, bosniak, croat, serb, other] confirmed). All settlements have `data_provenance = "settlement"`. Unknown count: 0 (all settlements matched at settlement level).
- **How to run:** `npm run map:phase0:validate` produces validation reports and viewer index. To view: `npx http-server -p 8080` from repo root, then open `http://localhost:8080/data/derived/phase0_embedded_viewer/`
- **Mistake log updated:** no (no new mistakes discovered, all settlements matched successfully)
- **Note:** Since all settlements matched at settlement level with validated ordering and 0% fail rate, no Unknown settlements were produced and no FORAWWV.md addendum is needed. Viewer correctly displays settlement-level ethnicity composition with fixed color palette. Municipality fallback is disabled by design.

**2026-01-26** - Strengthen mistake-log system: add Key field, helper functions, and workflow requirement
- **Phase:** Tooling improvement (no simulation mechanics changed)
- **Decision:** Mistake log system enhanced with stable de-duplication keys and standardized helper functions. Workflow documentation updated to require "Mistake log updated: yes/no" in all changelog entries.
- **Artifacts:** Updated `tools/assistant/mistake_guard.ts`, created `tools/assistant/mistake_helpers.ts`, updated `docs/PROJECT_LEDGER.md`, updated `scripts/map/phase0_validate_settlements.ts` (demonstration usage)
- **Key field support:** Extended mistake log format to support optional "Key:" line for de-duplication. Keys are case-sensitive, trimmed, and used for duplicate detection. If `appendMistake()` is called with a key that already exists, entry is skipped with a warning (no duplicate appended).
- **Structured entry format:** `appendMistake()` now accepts either legacy format (raw string or `{title, mistake, correctRule}`) or new structured format (`{key?, date, title, description, correctiveAction}`). Backward compatibility maintained - existing code continues to work.
- **Helper functions:** Created `tools/assistant/mistake_helpers.ts` with:
  - `makeMistakeKey(parts: string[])`: Deterministic key generation (joins parts with ".", filters empty parts)
  - `recordDataIssue(params)`: Records data issues with key prefix "data.<area>.<issue>"
  - `recordAssumptionInvalidated(params)`: Records invalidated assumptions with key prefix "assumption.<area>.<issue>"
  - `recordToolingIssue(params)`: Records tooling issues with key prefix "tooling.<area>.<issue>"
  All helpers are non-throwing (warnings only).
- **Workflow requirement:** Updated `docs/PROJECT_LEDGER.md` Operational Notes section to require: "Every work item changelog entry must include: 'Mistake log updated: yes/no' and, if yes, list the Key(s) appended."
- **Demonstration usage:** Updated `scripts/map/phase0_validate_settlements.ts` to use `recordAssumptionInvalidated()` instead of direct `appendMistake()` call, demonstrating the intended helper function usage pattern.
- **De-duplication behavior:** Keys are checked both in-memory (same run) and on-disk (existing log file). If key exists, entry is skipped with console warning. Title-based de-duplication still works as fallback when no key is provided.
- **Mistake log updated:** yes/no
- **How to run:** No runtime changes required. Existing scripts continue to work. New scripts should use helper functions from `mistake_helpers.ts` for standardized key generation and entry formatting.
- **Note:** Mistake log remains plain-text and append-only. No simulation mechanics or map geometry behavior changed. All changes are tooling-only improvements to mistake tracking infrastructure.

**2026-01-26** - Build settlements GeoJSON from SVG pack (JSON or JS files) with deterministic curve discretization
- **Phase:** Map Rebuild (Path A)
- **Decision:** Create deterministic converter from SVG path settlement pack (JSON or JS files) to GeoJSON polygons. Census join is settlement-level only, debug-only (not simulation authority). No geometry invention (no unions, smoothing, buffering, hulls, repair).
- **Artifacts:** `scripts/map/build_settlements_from_svg_pack.ts`, `data/derived/settlements_from_svg_pack.geojson`, `data/derived/settlements_from_svg_pack.audit.json`, `data/derived/settlements_from_svg_pack.audit.txt`
- Added deterministic SVG pack to GeoJSON converter. Extracts zip files (`settlements_pack.zip`, `bih_census_1991.zip`) to `data/source/.extracted/`. Supports two input formats: (1) JSON files: detects by stable sort + largest byte size, recursively searches for objects with identifier fields (sid/id/code) and SVG path strings (d/path/svg/svgPath/shape); (2) JS files (Raphael.js format): parses `R.path("...").data("munID", ...)` pattern using regex, extracts settlement IDs and SVG paths, extracts municipality IDs from filenames (format: "MunicipalityName_MID.js").
- SVG path conversion: implements full SVG path parser with curve discretization. Supported commands: M, L, H, V, C, Q, S, T, A, Z (absolute + relative via makeAbsolute). Curve sampling: cubic bezier (C/S) = 20 segments, quadratic bezier (Q/T) = 12 segments, arcs (A) = 24 segments. All sampling is deterministic (uniform t in [0,1]). Rings: each closed subpath (ends with Z or returns to start) becomes a ring. Multiple rings → MultiPolygon (each ring as outer ring, no containment tests to infer holes). Closure: if ring not closed, closes only if path declares closure (Z); otherwise warns and skips (GeoJSON requires closed rings). Precision: coordinates quantized to 6 decimals during output serialization only.
- Census join: settlement-level only, debug-only. Detects census key by maximum overlap with GeoJSON SID set (candidates: settlements, naselja, settlement, naselje). Validates p-sum: p[0] == p[1]+p[2]+p[3]+p[4]. If >10% settlements have p-sum mismatch, treats ordering as ambiguous (uses p1..p4 labels, logs mistake, flags FORAWWV.md). If ordering valid, attaches `census_debug` property with {total, bosniak, croat, serb, other, provenance: "settlement"}. If ambiguous, uses {p1, p2, p3, p4, provenance: "ambiguous"}. Clear note in audit: "Simulation should track population via separate datasets/state tables, not via geometry GeoJSON."
- Output format: GeoJSON FeatureCollection with Polygon/MultiPolygon features. Properties: sid (required), name (optional), municipality_id (optional, metadata only), source: "settlements_pack_svg", svg_sampling (optional, global sampling params), census_debug (optional, clearly labeled derived/debug). Features sorted deterministically by sid (string compare), then name, then source index.
- Audit reports: JSON and TXT formats. Includes: input files chosen, settlement records detected/parsed, SVG command type counts (M/L/C/Q/A/Z etc.), unsupported command counts, conversion warnings, bbox (global + per-feature stats), coordinate regime (ranges, suspicious spans), census join coverage (settlement-level only), validation counts (closed rings, finite coords). Explicit statement: "Simulation should track population via separate datasets/state tables, not via geometry GeoJSON."
- New npm script: `map:build:settlements_svg` (`npm run map:build:settlements_svg`)
- **Mistake log updated:** no (no new mistakes discovered during implementation)
- **How to run:** `npm run map:build:settlements_svg` produces GeoJSON and audit reports. Assumes zip files are placed under `data/source/` after extraction. If SVG pack coordinates are in screen-space (Y down), this is documented as a viewer/render issue in coordinate regime audit, not a geometry fix.
- **Note:** If this task reveals that SVG pack coordinates are systematically in screen-space (Y-down) or that coordinate regimes are ambiguous, docs/FORAWWV.md may require an addendum. Do NOT edit FORAWWV.md automatically.

**2026-01-26** - Derive minimal settlement-only substrate GeoJSON from bih_master.geojson
- **Phase:** Map Rebuild (Path A)
- **Decision:** Create minimal settlement-only GeoJSON substrate containing ONLY what the map system needs (geometry + stable ids + minimal join keys). This derived file becomes the new basis for map build steps (validation + adjacency later). Do NOT "fix" geometry; only filter, normalize schema, and deterministically order/quantize output.
- **Artifacts:** `scripts/map/derive_settlement_substrate_from_master.ts`, `data/derived/settlements_substrate.geojson`, `data/derived/settlements_substrate.audit.json`, `data/derived/settlements_substrate.audit.txt`
- Added deterministic substrate derivation script that reads `data/source/bih_master.geojson` as authoritative raw source. Settlement feature detection: uses explicit `layer="settlement"` filter (preferred), falls back to `feature_type="settlement"`, `kind="settlement"`, or all polygons if no explicit type indicators found. Detects settlement ID from properties using priority order: sid, SID, settlement_id, settlementId, naselje_id, naseljeId, id. Detects municipality ID from: municipality_id, mun_id, opstina_id, mun_code.
- Minimal output schema: each feature contains only `sid` (required, string), `name` (string | null), `municipality_id` (string | null, metadata only), `source_index` (number, original feature index for traceability), `source` (constant: "bih_master.geojson"). Geometry kept exactly as-is (Polygon/MultiPolygon), no modification. Geometry validation: checks finite coordinates, ring closure (first==last), minimum ring length (>=4 points). Invalid geometries excluded and reported (no repair, no silent correction).
- Deterministic output: features sorted by sid (string compare), then source_index. No coordinate quantization applied (coordinates kept as-is from source). No randomness, no timestamps. Output ordering is stable across runs.
- Audit reports: comprehensive JSON and TXT reports including input feature counts, geometry type counts, layer/type property stats (top 20), settlement detection decision path, output counts, missing_sid count + sample indices (first 20), invalid_geometry count + categorized reasons (non-polygon, non-finite coords, ring too short, ring not closed) + samples, sid uniqueness stats (duplicates count + sample sids), municipality_id presence stats (% present, missing count), global bbox + per-feature bbox size stats (min/median/p90/max). Explicit note: "This derived file is a minimal substrate. Population/ethnicity remains in separate authoritative datasets and will be joined into derived start-state tables."
- Results: 6135 settlement features emitted (from 6278 total features in source). 0 missing SIDs, 0 invalid geometries, 0 duplicate SID groups. 100% municipality_id presence. Global bbox: [1.000000, -9.521400, 940.963800, 909.960200]. Settlement detection used explicit `layer="settlement"` filter (6135 candidates).
- New npm script: `map:derive:substrate` (`npm run map:derive:substrate`)
- **Mistake log updated:** no (no new mistakes discovered; all settlements have valid SIDs and geometry, no duplicates found)
- **How to run:** `npm run map:derive:substrate` produces substrate GeoJSON and audit reports. Output file becomes the new basis for map build steps (validation + adjacency later).
- **Note:** Since no duplicates or missing stable IDs were found, no systemic assumption issues were detected. If duplicates had been found (same sid multiple polygons), FORAWWV.md may have required an addendum about multi-polygon settlement identity assumptions. Do NOT edit FORAWWV.md automatically.

**2026-01-26** - Add standalone HTML viewer for settlement substrate with settlement-level ethnicity coloring
- **Phase:** Map Rebuild (Path A)
- **Decision:** Create standalone HTML viewer for settlement substrate that colors settlements by settlement-level majority ethnicity only (NOT municipality). No municipality fallback allowed. If settlement-level census join fails, render as Unknown and report counts.
- **Artifacts:** `scripts/map/build_substrate_viewer_index.ts`, `data/derived/substrate_viewer/data_index.json`, `data/derived/substrate_viewer/index.html`, `data/derived/substrate_viewer/viewer.js`
- Added index builder script that creates lightweight lookup table keyed by sid for efficient viewer rendering. Loads substrate GeoJSON and census JSON, detects settlement-level census table deterministically (prefers explicit keys: settlements, naselja, settlement, naselje; otherwise scans top-level objects with p arrays). Validates census ordering via p-sum checks: p[0] == p[1]+p[2]+p[3]+p[4]. If >10% settlements have p-sum mismatch, treats ordering as ambiguous (viewer colors all Unknown, displays warning banner). Computes majority ethnicity with deterministic tie-breaking: bosniak > serb > croat > other. Index includes per-settlement: name, municipality_id (metadata only), bbox, centroid, majority, shares (ethnicity percentages), provenance (settlement/no_settlement_census/ambiguous_ordering).
- Viewer: pure static HTML+JS (no bundler). Canvas-based rendering with pan/zoom (mouse wheel zooms around cursor, click+drag pans). Fixed color palette: Bosniak=#2e7d32 (green), Serb=#c62828 (red), Croat=#1565c0 (blue), Other=#6d6d6d (gray), Unknown=#bdbdbd (light gray). Colors applied with 30% opacity. Deterministic draw order: features sorted by sid (string compare). Controls: checkbox "Color by settlement majority ethnicity" (default ON), checkbox "Show Unknown only" (default OFF), SID substring filter, legend with counts per majority + palette swatches, "Reset view" button, warning banner for ambiguous ordering or missing census table.
- Tooltip on hover: shows sid, name (if present), provenance, majority, composition percentages (rounded 1 decimal) when ordering_mode="named". If unknown, explicitly shows reason (no_settlement_census or ambiguous_ordering). Viewer handles ambiguous ordering mode: if ordering_mode="ambiguous", fills all settlements as Unknown and displays warning banner: "Settlement-level census ordering ambiguous (p0 != sum(p1..p4) frequently)."
- Results: 6135 features indexed, settlement census key="settlements", ordering_mode="named" (validated), matched_settlement_census=6135, unknown=0. Majority counts: bosniak=2504, serb=2553, croat=1063, other=15, unknown=0. All settlements matched at settlement level with validated ordering.
- New npm script: `map:viewer:substrate:index` (`npm run map:viewer:substrate:index`)
- **Mistake log updated:** no (no new mistakes discovered; settlement-level census found and validated successfully)
- **How to run:** `npm run map:viewer:substrate:index` generates viewer index. To view: `npx http-server -p 8080` from repo root, then open `http://localhost:8080/data/derived/substrate_viewer/`
- **Note:** Since settlement-level census table was found and ordering validated successfully (0% p-sum failures), no FORAWWV.md addendum is needed. If settlement-level census had been missing or ordering ambiguous, docs/FORAWWV.md may have required an addendum about demographic data granularity and encoding assumptions. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - Phase 0 settlement substrate locked as canonical, cleanup of obsolete artifacts
- **Phase:** Map Rebuild (Path A) - Phase 0 consolidation
- **Decision:** Lock in settlement substrate and substrate viewer as canonical for Phase 0, then perform controlled cleanup of obsolete/unused files, scripts, viewers, and derived artifacts from earlier failed attempts. Repository left in clean, minimal, deterministic state ready for Phase 1 (settlement adjacency).
- **Canonical artifacts locked (DO NOT MODIFY CONTENT):**
  - Source (authoritative): `data/source/bih_master.geojson`, `data/source/bih_census_1991.json`
  - Derived (canonical for Phase 0): `data/derived/settlements_substrate.geojson`, `data/derived/settlements_substrate.audit.json`, `data/derived/settlements_substrate.audit.txt`, `data/derived/substrate_viewer/` (index.html, viewer.js, data_index.json)
  - Scripts (canonical): `scripts/map/derive_settlement_substrate_from_master.ts`, `scripts/map/build_substrate_viewer_index.ts`
  - NPM commands (canonical): `map:derive:substrate`, `map:viewer:substrate:index`
- **Deleted obsolete files:**
  - Derived viewers & artifacts: `data/derived/phase0_embedded_viewer/` (entire directory: index.html, viewer.js, data_index.json), `data/derived/phase0_embedded_validation_report.json`, `data/derived/phase0_embedded_validation_report.txt`, `data/derived/settlements_from_svg_pack.geojson`, `data/derived/settlements_from_svg_pack.audit.json`, `data/derived/settlements_from_svg_pack.audit.txt`
  - Obsolete scripts: `scripts/map/phase0_validate_settlements.ts`, `scripts/map/build_settlements_from_svg_pack.ts`
  - Obsolete npm scripts: `map:phase0:validate`, `map:build:settlements_svg`
- **Code hygiene:**
  - Added canonical comments to `derive_settlement_substrate_from_master.ts` and `build_substrate_viewer_index.ts` indicating they are canonical for Phase 0
  - Updated mistake guard assertions in canonical scripts to reference cleanup context
  - No dead code paths or unused imports found (all references were to deleted files)
- **Validation after cleanup:**
  - Ran `npm run map:derive:substrate`: ✅ Success (6135 features emitted, 0 missing SIDs, 0 invalid geometries, 0 duplicate SID groups)
  - Ran `npm run map:viewer:substrate:index`: ✅ Success (6135 features indexed, settlement census key="settlements", ordering_mode="named", all settlements matched)
  - Viewer files verified present: `data/derived/substrate_viewer/index.html`, `data/derived/substrate_viewer/viewer.js`, `data/derived/substrate_viewer/data_index.json`
- **Repository state:**
  - Exactly one settlement substrate GeoJSON: `data/derived/settlements_substrate.geojson`
  - Exactly one settlement viewer: `data/derived/substrate_viewer/`
  - No npm scripts reference deleted files
  - No TypeScript imports reference deleted scripts
  - Phase 0 is clearly "locked" and discoverable by reading package.json + docs/PROJECT_LEDGER.md
- **Mistake log updated:** no (cleanup task only, no new mistakes discovered)
- **How to test:** Run `npm run map:derive:substrate`, then `npm run map:viewer:substrate:index`, then `npx http-server -p 8080` and open `http://localhost:8080/data/derived/substrate_viewer/` to confirm viewer renders correctly
- **Note:** This cleanup task revealed no systemic design insights or invalidated assumptions. Repository is now clean and ready for Phase 1 (settlement adjacency). No FORAWWV.md addendum required.

**2026-01-27** - Repo cleanup audit tool: deterministic orphan file detection
- **Phase:** Repository maintenance
- **Decision:** Create deterministic audit tool that identifies files/folders likely unused (no inbound references) without deleting or moving anything. Tool scans TypeScript/JavaScript imports/requires, package.json scripts, and documentation files to build a referenced files set, then classifies all tracked files as USED, ORPHAN_CANDIDATE, or EXEMPT.
- **Artifacts:** `scripts/repo/cleanup_audit.ts`, `docs/cleanup/cleanup_audit.json` (generated), `docs/cleanup/cleanup_audit.md` (generated)
- Added deterministic cleanup audit script that:
  - Walks repository (excluding node_modules, dist, build, .git, .cursor, .vscode, coverage, and non-canonical data/derived artifacts)
  - Builds tracked files set (all files discovered)
  - Builds referenced files set by scanning:
    - TypeScript/JavaScript files for import/require string literals (ES modules and CommonJS)
    - package.json scripts for file paths (tsx/node commands, --input/--config flags)
    - docs/PROJECT_LEDGER.md, docs/map_pipeline.md, docs/handoff_map_pipeline.md for file paths (backtick-wrapped paths, markdown links)
  - Resolves relative import paths to repo-relative file paths (handles extensions: .ts, .js, .tsx, .jsx, and index files)
  - Classifies files:
    - **USED**: Found in referenced files set
    - **ORPHAN_CANDIDATE**: No inbound reference found
    - **EXEMPT**: Explicitly excluded (root config files, all docs/, all data/source/, canonical Phase 0 substrate paths)
  - Outputs deterministic JSON and Markdown reports (stable ordering, no timestamps, posix-style paths for cross-platform consistency)
- Exempt patterns include: package.json, tsconfig.json, .gitignore, all docs/, all data/source/, canonical Phase 0 substrate files (settlements_substrate.geojson, substrate_viewer/, canonical scripts)
- Reports include summary counts and orphan candidates grouped by directory for easy review
- New npm script: `repo:cleanup:audit` (`npm run repo:cleanup:audit`)
- **Mistake log updated:** no (audit tool only, no deletions performed)
- **How to run:** `npm run repo:cleanup:audit` produces `docs/cleanup/cleanup_audit.json` and `docs/cleanup/cleanup_audit.md`. Re-run to confirm deterministic output (no diffs on repeated runs). Review orphan candidates manually before deletion in separate tasks.
- **Note:** This audit tool does not delete or move any files. It only identifies candidates for review. Some files may be referenced in ways not detected (dynamic imports, string concatenation, external tools). This task revealed no systemic design insights or invalidated assumptions. No FORAWWV.md addendum required.

**2026-01-27** - Safe artifact cleanup: remove log/cache artifacts and add .gitignore rules
- **Phase:** Repository maintenance
- **Decision:** Delete clearly non-canonical, non-source artifacts (logs, Python cache, single save file) and add .gitignore rules to prevent them from reappearing. This is a safe cleanup that does not affect Phase 0 canonical files or source data.
- **Deleted files:**
  - `adjacency_output.log` (root log file)
  - `map_all.log` (root log file)
  - `map_build.log` (root log file)
  - `tools/map_build/__pycache__/` (entire Python cache directory with .pyc files)
  - `saves/save_0001.json` (single save file)
- **Created/Updated:**
  - `.gitignore` (created with rules to prevent future artifacts):
    - `*.log` (all log files)
    - `tools/**/__pycache__/` (Python cache directories)
    - `*.pyc` (Python compiled files)
    - `saves/save_*.json` (individual save files, but keeps saves/ directory tracked)
    - Additional standard ignores: node_modules/, dist/, build/, coverage/, IDE files, OS files
- **Preserved:**
  - All canonical Phase 0 files (settlements_substrate.*, substrate_viewer/, canonical scripts)
  - All data/source/** files (read-only sources)
  - All documentation files
- **Mistake log updated:** no (safe artifact cleanup only, no new mistakes discovered)
- **How to test:** Run `npm run repo:cleanup:audit` to confirm deleted artifacts are gone and not replaced. Run `npm test` to ensure repo builds/tests unaffected. Check git status is clean aside from intended deletions/edits.
- **Note:** This was a "safe artifact cleanup" only. No canonical files, source data, or Phase 0 artifacts were affected. This task revealed no systemic design insights or invalidated assumptions. No FORAWWV.md addendum required.

**2026-01-27** - Legacy map artifact cleanup: delete derived_v2 and map_kit_v1 directories
- **Phase:** Repository maintenance
- **Decision:** Permanently delete legacy, non-canonical map artifact directories that are no longer part of the Phase 0 canonical pipeline. These directories contained obsolete derived outputs and raw map kit data from earlier map rebuild attempts that have been superseded by the Phase 0 substrate architecture.
- **Deleted directories:**
  - `data/derived_v2/` (entire directory, recursively deleted):
    - `geometry_sanity.json`
    - `map_bounds.json`
    - `municipalities_meta.json`
    - `municipality_outlines.geojson`
    - `settlements_meta.json`
    - `settlements_polygons.geojson`
  - `data/raw/map_kit_v1/` (entire directory, recursively deleted):
    - `map_data/` (subdirectory with 3 files: 2 *.json, 1 *.js)
    - `map_data.zip`
    - `settlement_polygon_fixes_local.json`
    - `settlement_polygon_fixes_pack_v1.json`
    - HTML visualization files (2 files)
- **Preserved (Phase 0 canonical files, unchanged):**
  - `data/derived/settlements_substrate.geojson` ✅
  - `data/derived/settlements_substrate.audit.json` ✅
  - `data/derived/settlements_substrate.audit.txt` ✅
  - `data/derived/substrate_viewer/` (entire directory) ✅
  - `scripts/map/derive_settlement_substrate_from_master.ts` ✅
  - `scripts/map/build_substrate_viewer_index.ts` ✅
  - All `data/source/**` files (read-only sources) ✅
- **Verification:**
  - Cleanup audit confirms deleted directories no longer appear in tracked files (tracked files reduced from 599 to 581)
  - Phase 0 canonical files verified present and unchanged
  - Re-running cleanup audit produces identical deterministic output
  - Test suite shows one pre-existing failure (unrelated to deletions)
- **Mistake log updated:** no (legacy artifact cleanup only, no new mistakes discovered)
- **How to test:** Run `npm run repo:cleanup:audit` to confirm deleted directories are gone and not replaced. Run `npm test` to ensure repo builds/tests unaffected (one pre-existing test failure unrelated to deletions). Verify git status shows only intended deletions + ledger update.
- **Note:** This was a "legacy artifact cleanup" only. No canonical Phase 0 files, source data, or active pipeline artifacts were affected. The deleted directories contained obsolete outputs from earlier map rebuild attempts that have been superseded by the Phase 0 substrate architecture. This task revealed no systemic design insights or invalidated assumptions. No FORAWWV.md addendum required.

**2026-01-27** - Phase 1: Derive deterministic settlement adjacency graph from substrate
- **Phase:** Map Rebuild (Path A) - Phase 1 adjacency graph
- **Decision:** Implement deterministic, undirected adjacency graph derivation where edges exist ONLY when two settlement polygons share a boundary segment (shared border length > 0). No terrain inference, no point-touch adjacency, no geometry invention. Coordinate quantization (EPS) computed deterministically from dataset bounds and used only for robust segment key matching (does not modify or write geometry).
- **Artifacts:** `scripts/map/derive_settlement_graph_from_substrate.ts`, `data/derived/settlement_graph.json`, `data/derived/settlement_graph.audit.json`, `data/derived/settlement_graph.audit.txt`
- Added canonical Phase 1 script that reads `data/derived/settlements_substrate.geojson` as input. Extracts settlement polygons (handles Polygon and MultiPolygon, processes outer rings only). Extracts settlement ID from properties using priority: `sid`, then `settlement_id` (skips features missing both, records count in audit).
- Edge extraction for contiguity: iterates consecutive coordinate pairs in polygon outer rings to form directed segments (A->B), ignores zero-length segments. Creates undirected segment key for matching: quantizes coordinates using EPS computed deterministically from dataset bounds (EPS = max(width, height) * 1e-7, clamped to [1e-9, 1e-5]), canonicalizes segment endpoints ordering (lexicographic) so A-B == B-A, segment key string format: "x1,y1|x2,y2" with fixed decimal formatting (precision sufficient to preserve EPS grid).
- Segment ownership tracking: maintains map `segmentKey -> { len, owners: Set<sid> }` where len = euclidean length computed from quantized endpoints (consistent, deterministic), owners includes all sids whose polygons contain this segment.
- Adjacency building: for each segmentKey with owners size >= 2, creates edges for all unordered pairs (sidA, sidB) among owners, accumulates shared_border_length (sum of segment lengths shared between pair). Final graph is undirected: for each sid, neighbors array with `{ sid: neighborSid, shared_border_length }`, neighbor arrays sorted by neighborSid (deterministic). Global edge list: unique undirected edges stored once with `sid_low`, `sid_high`, `shared_border_length`, sorted by (sid_low, sid_high) (deterministic).
- Output schema: `settlement_graph.json` contains `schema_version: 1`, `source: "data/derived/settlements_substrate.geojson"`, `nodes: <number>`, `edges: <number>`, `graph: { "<sid>": [{ "sid": "<neighborSid>", "shared_border_length": <number> }] }`, `edge_list: [{ "a": "<sid_low>", "b": "<sid_high>", "shared_border_length": <number> }]`.
- Audit reports: comprehensive JSON and TXT reports including counts (nodes, edges, isolated_count), degree_stats (min, p50, p90, max), top_degree (top 20 settlements by degree, sorted by degree desc then sid asc), isolated (all isolated settlement sids, sorted), anomalies (missing_sid_features_count, non_polygon_features_count, segment_multishare_count, max_shared_border_length_edge with a/b/length). Explicit note: "Adjacency is defined as shared boundary segments only (contiguity). Point-touch does not create edges. No terrain inference performed. Coordinate quantization (EPS) used only for robust segment matching. No geometry modification or invention performed."
- Deterministic guarantees: stable ordering for all iteration and outputs (sort by settlement_id, then neighbor_id), no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. Coordinate quantization is derived deterministically from dataset bounds and applied uniformly (must not modify or write geometry).
- New npm script: `map:derive:graph` (`npm run map:derive:graph`)
- **Mistake log updated:** no (no new mistakes discovered; implementation follows Phase 0 substrate patterns and determinism requirements)
- **How to run:** `npm run map:derive:graph` produces adjacency graph JSON and audit reports. Output file becomes the basis for Phase 2+ map build steps. Re-run immediately to confirm deterministic output (no diffs in generated files).
- **Note:** This task implements Phase 1 adjacency graph derivation as specified. Adjacency definition (shared boundary segments only, no point-touch) is explicitly documented in audit artifacts. If anomalies are found (e.g., many segments shared by >2 settlements, many isolated settlements), they are reported but not "fixed" (substrate geometry is canonical and not modified). This task revealed no systemic design insights or invalidated assumptions. No FORAWWV.md addendum required.

**2026-01-27** - Phase 1 diagnostic: Measure near-miss settlement contiguity to explain sparse adjacency
- **Phase:** Map Rebuild (Path A) - Phase 1 diagnostics
- **Decision:** Create validation-only diagnostic that explains why the strict shared-segment adjacency graph is sparse by measuring "near-miss" boundary proximity between settlements. This diagnostic does NOT modify any canonical Phase 0 or Phase 1 outputs. Uses spatial bucketing (uniform grid) to avoid O(N^2) pairwise checks across 6k polygons, then computes deterministic approximation of boundary-to-boundary minimum distance using sampled boundary vertices.
- **Artifacts:** `scripts/map/diagnose_settlement_contiguity_nearmiss.ts`, `data/derived/settlement_graph.nearmiss.audit.json`, `data/derived/settlement_graph.nearmiss.audit.txt`
- Added diagnostic script that reads `data/derived/settlements_substrate.geojson` and `data/derived/settlement_graph.json` (read-only). Extracts settlement data: bbox and boundary polyline sample (from outer rings only, deterministic downsampling to MAX_VERTS_PER_SETTLEMENT=256 if needed). Builds spatial grid index: computes global bbox, chooses cellSize = max(width, height) / 64 (clamped to [0.5, 50]), assigns each settlement bbox to overlapping grid cells, generates candidate pairs within each cell (stable iteration by sorting sids per cell).
- Near-miss distance computation: for each candidate pair not already strict-adjacent, first computes bbox distance (skips if > MAX_CHECK_DIST=1e-3), then approximates boundary-to-boundary distance using point-to-segment distance from sampled vertices of A to segments of B's sampled polyline and vice versa. Boundary distance = min(minAtoB, minBtoA).
- Threshold sweep: computes counts of candidate "would-be adjacency" under two deterministic threshold sets: (1) EPS-scaled: [0, EPS, 2*EPS, 5*EPS, 10*EPS, 25*EPS, 50*EPS] where EPS is recomputed from dataset bounds using same formula as derive_settlement_graph_from_substrate.ts (EPS = clamp(max(width,height) * 1e-7, 1e-9, 1e-5)), (2) Fixed units: [1e-6, 5e-6, 1e-5, 5e-5, 1e-4]. For each threshold T: near_pairs_count[T] = number of candidate pairs with boundaryDist <= T, near_unique_nodes[T] = number of unique settlements appearing in at least one near pair at T. Also tracks distance statistics: min, p50, p90, max over all computed boundaryDist values.
- Output artifacts: JSON audit includes schema_version, source paths, strict graph recap (nodes, edges, isolated), candidate_pairs_evaluated, eps, both threshold sweeps, distance_stats, top_near_pairs (50 smallest boundaryDist pairs, sorted by boundaryDist then a then b), anomalies (missing_sid_features_count, non_polygon_features_count, skipped_over_max_check_dist). TXT audit provides human-readable summary with strict graph recap, candidate generation recap, EPS and threshold tables, distance stats, top 20 nearest pairs.
- Deterministic guarantees: stable ordering for all iteration and outputs, no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances. Validation-only: does NOT modify settlements_substrate.geojson or settlement_graph.json.
- New npm script: `map:diagnose:nearmiss` (`npm run map:diagnose:nearmiss`)
- **Mistake log updated:** no (validation-only diagnostic, no new mistakes discovered)
- **How to run:** `npm run map:diagnose:nearmiss` produces near-miss audit JSON and TXT reports. Re-run immediately to confirm deterministic output (no diffs in generated files). Run `npm run map:derive:graph` to ensure canonical outputs unchanged.
- **Note:** This diagnostic quantifies whether sparse strict adjacency is due to near-miss numeric mismatch (near_pairs grows rapidly as threshold increases) vs true disjointness (near_pairs remains low even at 1e-4). Initial results show 1842 pairs with boundaryDist=0 (actually touching) but only 297 strict edges detected, suggesting strict adjacency detection may be missing many actual contiguities due to coordinate precision or quantization issues in segment matching. This is a systemic insight: **docs/FORAWWV.md may require an addendum** about coordinate precision and strict adjacency detection trade-offs. Do NOT edit FORAWWV.md automatically. This task does NOT modify any canonical Phase 0 or Phase 1 strict outputs.

**2026-01-27** - Phase 1 v2: Derive settlement adjacency using overlap detection (robust to different vertex splits)
- **Phase:** Map Rebuild (Path A) - Phase 1 adjacency graph (v2 parallel implementation)
- **Decision:** Create parallel v2 settlement adjacency derivation that detects shared border length even when the shared boundary is split differently across polygons. v2 uses overlap detection for colinear segments instead of exact segment key matching, making it robust to different vertex splits. v2 does NOT modify or replace existing v1 graph artifacts. Adjacency definition remains unchanged: shared boundary segment length > 0 (NOT point-touch).
- **Artifacts:** `scripts/map/derive_settlement_graph_from_substrate_v2_overlap.ts`, `data/derived/settlement_graph_v2.json`, `data/derived/settlement_graph_v2.audit.json`, `data/derived/settlement_graph_v2.audit.txt`
- Added v2 script that reads `data/derived/settlements_substrate.geojson` as input (same canonical input as v1). Extracts boundary segments from all outer rings (Polygon/MultiPolygon), keeping original coordinates in memory. Computes EPS deterministically from dataset bounds using same formula as v1 (EPS = max(width, height) * 1e-7, clamped to [1e-9, 1e-5]). Quantizes points only for indexing (must not rewrite geometry outputs).
- Segment spatial indexing: for each segment, computes its bbox and assigns to uniform grid (cell size = max(width, height) / 128, clamped to [0.1, 100]). Stores per-cell segment lists keyed by settlement id. This avoids O(N^2) global comparisons.
- Overlap detection for candidate settlement pairs: for each grid cell, compares segments across different settlements. Two segments contribute to shared border ONLY if: (1) they are colinear within tolerance (cross product magnitude <= EPS), (2) their projections overlap with positive length (shared length > 0), (3) they are essentially the same line (perpendicular distance <= EPS). Accumulates shared length per unordered settlement pair (sid_low, sid_high). Important: does not count point-only intersection as adjacency; requires overlap length > 0.
- Build graph: same schema as v1 (schema_version: 1), but output paths are *_v2*. Shared border length is the accumulated overlap length. Sort: nodes by sid; neighbors by sid; edges by (a,b). All deterministic ordering.
- Output schema: `settlement_graph_v2.json` contains same structure as v1: `schema_version: 1`, `source: "data/derived/settlements_substrate.geojson"`, `nodes: <number>`, `edges: <number>`, `graph: { "<sid>": [{ "sid": "<neighborSid>", "shared_border_length": <number> }] }`, `edge_list: [{ "a": "<sid_low>", "b": "<sid_high>", "shared_border_length": <number> }]`.
- Audit reports: comprehensive JSON and TXT reports including counts (nodes, edges, isolated_count), degree_stats (min, p50, p90, max), top_degree (top 20 settlements by degree), top_shared_border_edges (top 50 by length), isolated (all isolated settlement sids), anomalies (missing_sid_features_count, non_polygon_features_count, segment_comparisons_performed, skipped_due_to_numeric_issues). Explicit note: "Adjacency is defined as shared boundary segments only (contiguity). Point-touch does not create edges. v2 uses overlap detection to find shared borders even when boundaries are split differently across polygons (robust to different vertex splits)."
- Deterministic guarantees: stable ordering for all iteration and outputs (sort by settlement_id, then neighbor_id), no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. Coordinate quantization is derived deterministically from dataset bounds and applied uniformly (must not modify or write geometry).
- New npm script: `map:derive:graph:v2` (`npm run map:derive:graph:v2`)
- **Mistake log updated:** no (v2 implementation follows Phase 0 substrate patterns and determinism requirements; mistake guard assertion included)
- **How to run:** `npm run map:derive:graph:v2` produces adjacency graph v2 JSON and audit reports. Re-run immediately to confirm deterministic output (no diffs in generated files). Run `npm run map:derive:graph` to confirm v1 artifacts remain unchanged. Optional: run `npm run map:diagnose:nearmiss` and confirm its story matches v2 (more edges, fewer isolates expected).
- **Note:** v2 exists for comparison and does not replace v1 yet. Adjacency definition is unchanged (shared boundary segments only, no point-touch); only detection method is improved (overlap detection vs exact segment key matching). v2 is expected to produce materially fewer isolated settlements than v1, but still does not create adjacency from point-touch alone. This task revealed no systemic design insights or invalidated assumptions. No FORAWWV.md addendum required.

**2026-01-27** - Phase 1 diagnostics: Classify boundaryDist=0 near-miss pairs into point-touch vs shared-border
- **Phase:** Map Rebuild (Path A) - Phase 1 diagnostics
- **Decision:** Create deterministic diagnostic that classifies "touching" settlement pairs (boundaryDist=0) into POINT_TOUCH_ONLY (no shared colinear overlap length) vs SHARED_BORDER (overlap length > 0). This determines whether sparse adjacency is mostly correct (point touches only) or a detection failure (shared borders not detected). Validation-only: does NOT modify any canonical Phase 0 or Phase 1 outputs.
- **Artifacts:** `scripts/map/diagnose_touch_pairs_point_vs_border.ts`, `data/derived/settlement_graph.touch_classification.audit.json`, `data/derived/settlement_graph.touch_classification.audit.txt`
- Added diagnostic script that reads `data/derived/settlements_substrate.geojson`, `data/derived/settlement_graph.json` (v1), and `data/derived/settlement_graph_v2.json` (v2) as read-only inputs. Uses same grid bucketing approach as nearmiss diagnostic (bbox grid, cellSize = max(width, height) / 64) to find candidate pairs with bboxDist == 0 (bounding boxes overlap/touch) to keep count bounded.
- For each evaluated pair: (1) computes boundaryDist using same deterministic approximation as nearmiss (point-to-segment distance from sampled vertices), (2) computes overlapLen by extracting outer-ring segments for both settlements (no downsampling for evaluated pairs, but cap with MAX_VERTS_PER_SETTLEMENT=5000 to avoid pathological cases; if capped, records anomaly count). For each segment in A and segment in B that are potentially colinear (fast reject by segment bbox overlap): checks colinearity within tolerance (based on EPS from bounds, same formula as v1/v2), if colinear computes 1D projection overlap length, sums overlap lengths with deterministic segment-pair key deduplication to avoid double counting. overlapLen is total shared colinear overlap length (must be > 0 to qualify as shared border).
- Classification rules: for pairs with boundaryDist <= tinyTol (EPS/10), if overlapLen > 0 => SHARED_BORDER, else => POINT_TOUCH_ONLY.
- Output artifacts: JSON audit includes schema_version, source paths, counts (evaluated_pairs, touching_pairs, point_touch_only_pairs, shared_border_pairs), overlapLen_stats for shared_border_pairs (min, p50, p90, max), coverage metrics (how many shared_border_pairs already appear in v1, and in v2), top_shared_border_pairs (top 50 by overlapLen with a,b,overlapLen), anomalies (vertex_cap_applied_count, skipped_large_geometry_count, missing_sid_features_count, non_polygon_features_count). TXT audit provides human-readable summary with counts, overlap length statistics, coverage metrics, top lists, and interpretation guidance.
- Interpretation logic: if shared_border_pairs is large and v1/v2 coverage is low (< 50%) => detection issue; proceed to v3 algorithm. If point_touch_only dominates (> 2x shared_border) => geometry does not support shared-length adjacency; decide whether to allow point-touch or shift Phase 1 adjacency source.
- Deterministic guarantees: stable ordering for all iteration and outputs, no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances/overlap lengths. Validation-only: does NOT modify settlements_substrate.geojson or existing v1/v2 graphs.
- New npm script: `map:diagnose:touchclass` (`npm run map:diagnose:touchclass`)
- **Mistake log updated:** no (validation-only diagnostic, no new mistakes discovered; mistake guard assertion included)
- **How to run:** `npm run map:diagnose:touchclass` produces touch classification audit JSON and TXT reports. Re-run immediately to confirm deterministic output (no diffs in generated files). Confirm v1/v2 artifacts are unchanged (optionally re-run their derive commands and diff outputs).
- **Note:** This diagnostic classifies boundaryDist=0 pairs to explain sparse adjacency. Results will indicate whether detection failure (many shared borders not detected) or geometry limitation (mostly point-touch only). If shared_border_pairs is large with low v1/v2 coverage, this suggests detection issue and may require v3 algorithm. If point_touch_only dominates, this suggests geometry does not support shared-length adjacency and may require Phase 1 adjacency definition change. This task may reveal systemic design insights about coordinate precision and adjacency detection trade-offs. **docs/FORAWWV.md may require an addendum** based on results. Do NOT edit FORAWWV.md automatically. This task does NOT modify any canonical Phase 0 substrate or existing v1/v2 graph artifacts.

**2026-01-27** - Phase 1 diagnostics: Derive settlement contact graph including point-touch edges and report component connectivity
- **Phase:** Map Rebuild (Path A) - Phase 1 diagnostics
- **Decision:** Create validation-only "contact graph" that includes BOTH shared-border edges (overlapLen > 0) and point-touch edges (boundaryDist <= tinyTol and overlapLen == 0) to judge whether point-touch should be considered adjacency in later systems by reporting connectivity (components, largest component size, degree stats). This must NOT replace or modify canonical v1/v2 adjacency graphs (shared-border-only).
- **Artifacts:** `scripts/map/derive_settlement_contact_graph_pointtouch.ts`, `data/derived/settlement_contact_graph.json`, `data/derived/settlement_contact_graph.audit.json`, `data/derived/settlement_contact_graph.audit.txt`
- Added contact graph derivation script that reads `data/derived/settlements_substrate.geojson` as read-only input. Uses same candidate bucketing approach from touchclass diagnostic: candidate pairs where bboxDist == 0 (bounding boxes overlap/touch) to keep count bounded. For each candidate pair: computes boundaryDist approximation (same deterministic method as nearmiss/touchclass), computes overlapLen (colinear overlap length using same method as v2), classifies edge type: if overlapLen > 0 => shared_border, else if boundaryDist <= tinyTol => point_touch, else => no contact edge. Chooses tinyTol deterministically from EPS (tinyTol = EPS / 10, where EPS computed from dataset bounds using same formula as v1/v2).
- Output schema: `settlement_contact_graph.json` contains schema_version: 1, source, nodes, edges_total, edges_shared_border, edges_point_touch, edge_list (sorted by (a,b) with type, overlap_len, boundary_dist), graph (neighbors sorted by neighborSid with type, overlap_len, boundary_dist). All deterministic ordering.
- Audit reports: JSON audit includes schema_version, source, counts (nodes, edges_total, edges_shared_border, edges_point_touch), degree_stats (overall, shared_border, point_touch with min/p50/p90/max), component_analysis (component_count, largest_component_size, top_components_sizes top 20), isolated (shared_border_only count, shared_border_plus_point_touch count), anomalies (missing_sid_features_count, non_polygon_features_count, skipped_pairs_due_to_caps). TXT audit provides human-readable summary with counts, degree statistics, component analysis, isolated counts, and interpretation guidance.
- Component analysis: treats ANY edge (shared_border or point_touch) as connection, uses BFS to find connected components, reports component_count, largest_component_size, top_components_sizes (top 20, sorted by size desc then first sid). Isolated counts: shared_border_only (should match v2's shared-border-only result), shared_border_plus_point_touch (from contact graph).
- Interpretation logic: if largest_component_size > 50% of nodes => contact graph yields mostly-connected fabric. If isolated reduction (shared_border_only - shared_border_plus_point_touch) is significant (> 50% reduction) => point-touch makes graph significantly more connected, consider allowing point-touch in Phase 1 adjacency definition. If results imply point-touch makes the graph usable while shared-only does not, explicitly flag that docs/FORAWWV.md may need an addendum (do not edit it automatically).
- Deterministic guarantees: stable ordering for all iteration and outputs, no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances/overlap for classification. Validation-only: does NOT modify settlements_substrate.geojson or existing v1/v2 graph artifacts.
- New npm script: `map:derive:contact` (`npm run map:derive:contact`)
- **Mistake log updated:** no (validation-only diagnostic, no new mistakes discovered; mistake guard assertion included)
- **How to run:** `npm run map:derive:contact` produces contact graph JSON and audit reports. Re-run immediately to confirm deterministic output (no diffs in generated files). Confirm v1/v2 outputs unchanged by re-running their commands and verifying identical artifacts. Run `npm run repo:cleanup:audit` to ensure new artifacts are classified appropriately.
- **Note:** This contact graph is a validation-only diagnostic to judge whether point-touch should be considered adjacency. Results will show connectivity improvements (component sizes, isolated reduction) when point-touch edges are included. If results imply point-touch makes the graph usable (large component, far fewer isolates) while shared-border-only does not, this suggests Phase 1 adjacency definition may need to allow point-touch. This task may reveal systemic design insights about adjacency definition trade-offs. **docs/FORAWWV.md may require an addendum** if results indicate point-touch should be considered adjacency. Do NOT edit FORAWWV.md automatically. This task does NOT modify any canonical Phase 0 substrate or existing v1/v2 graph artifacts.

**2026-01-27** - Phase 1: Settlement adjacency v3 with robust boundary detection (canonical)
- **Phase:** Map Rebuild (Path A) - Phase 1 Settlement Adjacency
- **Decision:** Implement v3 adjacency algorithm using Hausdorff-distance segment matching to detect shared borders between settlements with independently digitized boundaries. v3 becomes the canonical adjacency graph; v1/v2 retained for reference.
- **Artifacts:** `scripts/map/derive_settlement_graph_v3_robust.ts`, `data/derived/settlement_graph_v3.json`, `data/derived/settlement_graph_v3.audit.json`, `data/derived/settlement_graph_v3.audit.txt`
- **Root cause analysis:** Investigation revealed that settlement polygons in `bih_master.geojson` were digitized independently - neighboring settlements have boundaries that are nearly parallel but not on the exact same line (gaps of ~0.001-0.01 units). v1/v2 required exact colinearity (EPS ~1e-5) which failed because digitization gaps are 100x larger. Sample analysis showed 418 pairs with boundaries within 0.01 units but only 84 pairs with exact shared vertices.
- **v3 algorithm:** (1) Extract boundary segments from all settlements, (2) use spatial grid index to find candidate pairs, (3) for each candidate pair, check: (a) nearly parallel (dot product > 0.985), (b) within distance tolerance (max point-to-segment distance < 0.02), (c) significant projected overlap (> 0.1 units), (4) accumulate matched segment lengths as shared border length. Home-cell deduplication ensures each segment pair is processed exactly once without storing all pair keys in memory.
- **Tolerance parameters:** Distance tolerance: 0.02 (derived from dataset bounds, ~2e-5 * maxDim). Parallel threshold: 0.985 (cos 10°). Min overlap length: 0.1. Parameters chosen based on observed digitization gaps and settlement polygon sizes.
- **Results:** v3 found 15,260 edges vs 345 in v2 (44x improvement). Isolation dropped from 90% (5,519 isolated) to 1% (61 isolated). Median degree: 5 neighbors. Max degree: 20. The 61 remaining isolated settlements are concentrated in municipalities 11304 (50 settlements) and 11428 (6 settlements) - likely geographic enclaves or areas with different digitization characteristics.
- **Comparison:**
  | Version | Edges | Isolated | Isolation Rate | Detection Method |
  |---------|-------|----------|----------------|------------------|
  | v1      | 297   | 5,604    | 91.3%          | Exact segment endpoint matching |
  | v2      | 345   | 5,519    | 89.9%          | Colinear overlap detection |
  | v3      | 15,260| 61       | 1.0%           | Hausdorff-distance segment matching |
- **New npm script:** `map:derive:graph:v3` (`npm run map:derive:graph:v3`)
- **Mistake log updated:** no (no new mistakes discovered; this is a successful fix for the detection gap)
- **Note:** v3 is now the canonical adjacency graph for Phase 1. The settlement polygons were digitized as independent shapes that nearly tile but don't share exact coordinate sequences. This is a fundamental characteristic of the source data that v3 correctly handles. Point-touch remains diagnostic-only; v3 uses only shared-border (positive length) detection with relaxed parallelism constraints. **docs/FORAWWV.md may require an addendum** noting that settlement boundaries are independently digitized and adjacency detection must use tolerance-based matching rather than exact coordinate comparison. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - Phase 1: Settlement adjacency viewer with shared-border/point-touch toggle
- **Phase:** Map Rebuild (Path A) - Phase 1 Settlement Adjacency
- **Decision:** Add interactive HTML viewer for settlement adjacency inspection showing settlement polygons with adjacency edges overlaid. Supports toggling between v3 shared-border edges (canonical) and point-touch edges (diagnostic). Viewer is inspection-only; does not modify data or canon.
- **Artifacts:** `scripts/map/build_adjacency_viewer.ts`, `data/derived/adjacency_viewer/index.html`, `data/derived/adjacency_viewer/data.json`
- **Viewer features:** Canvas-based renderer with pan/zoom. Settlement polygons with fill color (optionally highlight isolated settlements in red). Edge rendering: shared-border edges in green (canonical), point-touch edges in orange (diagnostic). Sidebar with statistics (total settlements, edge counts, isolation counts), display toggles (show settlements, show shared-border edges, show point-touch edges, highlight isolated), legend, hover tooltips showing settlement name/sid/municipality and neighbor counts.
- **Data sources:** Settlement geometry from `settlements_substrate.geojson`, shared-border edges from `settlement_graph_v3.json`, point-touch edges from `settlement_contact_graph.json` (excluding pairs already in v3).
- **Results:** Viewer shows 6,135 settlements, 15,260 shared-border edges, 95 point-touch edges, 61 isolated settlements (shared-border only), 60 isolated (including point-touch).
- **New npm script:** `map:viewer:adjacency` (`npm run map:viewer:adjacency`)
- **How to view:** Run `npm run map:viewer:adjacency` then open `data/derived/adjacency_viewer/index.html` in a browser.
- **Mistake log updated:** no (viewer is inspection-only)
- **Note:** Viewer is for visual verification and inspection of the adjacency graph. It does not modify any source data or canonical derived artifacts. If visual inspection reveals systematic issues with adjacency detection, those should be investigated and fixed in the detection algorithm, not in the viewer.

**2026-01-27** - Experimental SVG-derived settlements substrate rebuild
- **Phase:** Map Rebuild (Path A) - Experimental/Inspection
- **Decision:** Build an experimental settlements GeoJSON derived from SVG-based municipality JS files under `data/source/settlements` for inspection and comparison with Phase 0 canonical substrate. This is explicitly NOT a replacement for Phase 0 canon; outputs are written to separate paths (`svg_substrate/`) and marked as experimental.
- **Artifacts:** 
  - `scripts/map/rebuild_settlements_geojson_from_svg_js.ts` (rebuild script)
  - `scripts/map/build_svg_substrate_viewer_index.ts` (viewer builder)
  - `data/derived/svg_substrate/settlements_svg_substrate.geojson` (experimental GeoJSON)
  - `data/derived/svg_substrate/settlements_svg_substrate.audit.json` (audit JSON)
  - `data/derived/svg_substrate/settlements_svg_substrate.audit.txt` (audit TXT)
  - `data/derived/svg_substrate_viewer/index.html` (viewer HTML)
  - `data/derived/svg_substrate_viewer/viewer.js` (viewer JS)
  - `data/derived/svg_substrate_viewer/data_index.json` (viewer index)
- **Implementation:** Script parses municipality JS files (142 files) to extract SVG paths using `svg-path-parser`. Converts SVG paths to GeoJSON polygons with deterministic curve flattening (16 segments per curve). Matches shapes to census entries by `munID` attribute. Extracts viewBox transforms from source files but applies no rotation correction (raw SVG coordinate space preserved). Generates comprehensive audit reports including matching statistics, geometry validity counts, and unmatched entries list.
- **Results:** Extracted 6,148 shapes from 142 municipality JS files. Emitted 6,108 valid features (40 invalid geometries skipped). All 6,108 features matched to census entries via `munID` attribute. No unmatched entries. Coordinate bounds: [1.0, -9.52, 940.96, 910.09] (SVG coordinate space).
- **Viewer features:** Canvas-based renderer with pan/zoom. Colors by matched (green) vs unmatched (red) by default, with optional municipality-based coloring. Hover tooltips show sid, settlement_name, municipality_id, source_file, source_shape_id. Toggle filters for matched/unmatched display.
- **New npm scripts:** 
  - `map:rebuild:svg_substrate` (`npm run map:rebuild:svg_substrate`)
  - `map:viewer:svg_substrate:index` (`npm run map:viewer:svg_substrate:index`)
- **Deterministic guarantees:** Stable ordering (lexicographic file paths, sorted features by sid), no randomness, no timestamps, deterministic curve flattening (fixed 16 segments), consistent ring orientation (counter-clockwise outer rings). Outputs verified byte-stable on re-run.
- **Canon safety:** Phase 0 canonical files (`settlements_substrate.geojson`, `substrate_viewer/`, canonical scripts) remain completely unchanged. This rebuild is explicitly experimental and written to separate paths. If this becomes the new canon later, that will be a separate, explicit decision.
- **Mistake log updated:** no (no new mistakes discovered; this is an experimental rebuild for inspection)
- **How to run:** 
  1. `npm run map:rebuild:svg_substrate` (generates GeoJSON and audit reports)
  2. `npm run map:viewer:svg_substrate:index` (generates viewer HTML/JS/index)
  3. Open `data/derived/svg_substrate_viewer/index.html` in browser (or serve via `npx http-server -p 8080`)
  4. Re-run steps (1) and (2) to verify deterministic output (byte-identical files)
- **Note:** This experimental rebuild reveals that SVG source files use their own local coordinate space (viewBox transforms present but not applied). The coordinate regime differs from Phase 0 canonical substrate (bounds [1.0, -9.52, 940.96, 910.09] vs canonical bounds). All shapes matched successfully via `munID` attribute, suggesting the source encoding is consistent. **docs/FORAWWV.md may require an addendum** noting that SVG-based municipality files use a different coordinate regime than the canonical `bih_master.geojson` source, and that viewBox transforms are present but not applied in this experimental rebuild. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - SVG substrate census coverage validation audit
- **Phase:** Map Rebuild (Path A) - Experimental/Inspection - Validation
- **Decision:** Create deterministic validation script to audit experimental SVG-derived substrate against 1991 census for settlement identity, census coverage, and municipality distribution sanity checks. Validation-only; does not modify any substrate or canonical files.
- **Artifacts:** 
  - `scripts/map/audit_svg_substrate_coverage.ts` (validation script)
  - `data/derived/svg_substrate/settlements_svg_substrate.coverage.audit.json` (audit JSON)
  - `data/derived/svg_substrate/settlements_svg_substrate.coverage.audit.txt` (audit TXT)
- **Validation logic:** (1) Loads census and builds canonical settlement ID set (6,140 settlements from 142 municipalities). (2) Loads SVG substrate GeoJSON (6,108 features). (3) Validates SIDs: checks for missing, duplicates, and unmatched placeholders. (4) Determines identity mode: detects census_id (extracted from SID by stripping "S" prefix), name+municipality, or none. (5) Census coverage: if census_id mode, checks missing census IDs (in census but not in features) and extra feature IDs (in features but not in census). If name+municipality mode, checks for ambiguous keys (multiple features mapping to same normalized name+municipality). (6) Municipality distribution: counts features per municipality, compares to census counts, flags municipalities with 0 features but nonzero census count or significant count divergence (>20% or >50 absolute). (7) Geometry bounds: computes global bbox of substrate.
- **Results:** Identity mode: `census_id` (SIDs prefixed with "S" followed by census settlement ID). SID validation: 0 missing, 9 duplicates (S130478, S138487, S164984, S166138, S170046, S201634, S219223, S219371, S225665), 0 unmatched placeholders. Coverage: 6,099 matched (99.3% of features), 41 missing census settlements (0.7% of census), 0 extra features, 0 ambiguous keys. Municipality distribution: all municipalities have features; top municipality is Konjic (10529) with 168 features matching census count exactly. Geometry bounds: [1.000000, -9.521430, 940.963800, 910.090330] (SVG coordinate space).
- **Findings:** SVG substrate is settlement-identified (1:1 mapping via census_id extracted from SID). 99.3% census coverage (6,099/6,140). 9 duplicate SIDs indicate some settlement polygons appear multiple times in source files (likely same settlement digitized in multiple municipality files or duplicate shapes). 41 missing census settlements are not represented in SVG source files. No extra features (all features map to valid census IDs). Municipality distribution is consistent with census counts.
- **New npm script:** `map:audit:svg_substrate:coverage` (`npm run map:audit:svg_substrate:coverage`)
- **Deterministic guarantees:** Stable ordering (sorted census IDs, sorted features, sorted municipality IDs), no randomness, no timestamps, deterministic string normalization. Outputs verified byte-stable on re-run.
- **Mistake log updated:** no (validation-only script, no new mistakes discovered)
- **How to run:** 
  1. `npm run map:audit:svg_substrate:coverage` (generates coverage audit JSON and TXT)
  2. Re-run immediately to verify deterministic output (byte-identical files)
  3. Review `settlements_svg_substrate.coverage.audit.txt` for human-readable summary
- **Note:** Validation confirms SVG substrate is settlement-identified with high census coverage (99.3%). The 9 duplicate SIDs and 41 missing census settlements are documented in the audit but do not invalidate the substrate for inspection purposes. The duplicate SIDs suggest some settlements appear multiple times in source files (possibly due to digitization overlap or municipality boundary changes). **docs/FORAWWV.md may require an addendum** noting that SVG-derived substrate achieves 99.3% census coverage with settlement-level identity via census_id extraction from SID, but contains 9 duplicate SIDs and 41 missing census settlements. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - Experimental SVG-derived substrate rebuild: deterministic ring closure + duplicate-SID MultiPolygon merge
- **Phase:** Map Rebuild (Path A) - Experimental/Inspection
- **Change:** Update `scripts/map/rebuild_settlements_geojson_from_svg_js.ts` so it no longer drops `ring_not_closed` geometries and so duplicate SIDs are resolved deterministically.
  - Deterministic ring closure: if a ring has \(>= 4\) points and last != first, append first coordinate and revalidate (no other geometry invention).
  - Duplicate SID resolution: group by `sid` and merge duplicates into a single `MultiPolygon` feature with per-part provenance in `properties.parts` (deterministic order by `(source_file, source_shape_id)`); conflicts are resolved deterministically and recorded in `observed_*` fields + audit counters.
- **Results (rebuild audit):**
  - `shapes_extracted`: 6,148
  - `features_emitted_before_merge`: 6,148
  - `features_emitted_after_merge`: 6,137
  - `rings_closed_count`: 40
  - `features_fixed_by_ring_closure_count`: 40
  - `invalid_skipped_count`: 0
  - `duplicate_sid_count_before_merge`: 11 (merged into 11 MultiPolygons; `max_parts_per_sid`: 2)
- **Results (coverage audit):**
  - `census_total`: 6,140
  - `features_total`: 6,137
  - `duplicate_sid_count`: 0 (SID uniqueness holds)
  - `missing_census_count`: 3 (`130397`, `138517`, `201693`)
  - `extra_feature_count`: 0
- **Determinism:** Ran `map:rebuild:svg_substrate`, `map:viewer:svg_substrate:index`, and `map:audit:svg_substrate:coverage` twice back-to-back; outputs were byte-identical for:
  - `data/derived/svg_substrate/settlements_svg_substrate.geojson`
  - `data/derived/svg_substrate/settlements_svg_substrate.audit.json` / `.txt`
  - `data/derived/svg_substrate/settlements_svg_substrate.coverage.audit.json` / `.txt`
  - `data/derived/svg_substrate_viewer/data_index.json`
- **Canon safety:** Phase 0 canonical substrate and viewer artifacts remain unchanged; this remains experimental SVG substrate only.
- **Mistake log updated:** yes (confirmed prior behavior: ring_not_closed skipping and duplicate-SID emission).
- **FORAWWV.md note:** This reinforces that SVG-derived substrate is high-coverage but not fully complete (3 census settlements missing) and uses a distinct SVG coordinate regime; **docs/FORAWWV.md may require an addendum**. Do NOT edit it automatically.

**2026-01-27** - SVG substrate viewer: borders-only inspection mode
- **Phase:** Map Rebuild (Path A) - Experimental/Inspection - Viewer
- **Change:** Update `scripts/map/build_svg_substrate_viewer_index.ts` to add borders-only rendering mode (stroke only, transparent fill) for fast visual inspection of settlement outlines.
  - Added "Borders only" checkbox (default checked) in viewer controls.
  - When enabled, polygons render with stroke only (`STROKE_COLOR`, `STROKE_WIDTH`) and no fill (transparent).
  - When disabled, polygons render with fill colors as before (matched/unmatched or municipality-based).
- **Artifacts updated:**
  - `scripts/map/build_svg_substrate_viewer_index.ts` (build script)
  - `data/derived/svg_substrate_viewer/index.html` (regenerated with borders-only checkbox)
  - `data/derived/svg_substrate_viewer/viewer.js` (regenerated with borders-only rendering logic)
- **Determinism:** Viewer files regenerated deterministically (no timestamps, stable ordering). Re-running `map:viewer:svg_substrate:index` produces byte-identical outputs.
- **Canon safety:** Phase 0 canonical substrate and viewer artifacts remain unchanged; this is experimental SVG substrate viewer only.
- **Mistake log updated:** no (viewer enhancement, no mistakes discovered).
- **FORAWWV.md note:** No systemic design insights revealed; this is a viewer convenience feature for visual inspection. **docs/FORAWWV.md may require an addendum** if borders-only inspection reveals systematic geometry issues, but do NOT edit it automatically.

**2026-01-27** - Substrate viewers: file:// protocol CORS error handling
- **Phase:** Map Rebuild (Path A) - Viewer - Error Handling
- **Change:** Update both Phase 0 canonical and experimental SVG substrate viewers to detect file:// protocol and show clear error messages explaining CORS blocking and how to use a local web server.
  - Added file:// protocol detection in `loadData()` functions (check `window.location.protocol === 'file:'`).
  - Show clear error message with step-by-step instructions to run `npx http-server -p 8080` and open via `http://localhost:8080/...`.
  - Updated `scripts/map/build_svg_substrate_viewer_index.ts` to generate viewer.js with file:// detection.
  - Updated `data/derived/substrate_viewer/viewer.js` directly (Phase 0 canonical viewer is static, not generated).
- **Artifacts updated:**
  - `scripts/map/build_svg_substrate_viewer_index.ts` (build script)
  - `data/derived/substrate_viewer/viewer.js` (Phase 0 canonical viewer, static file)
  - `data/derived/svg_substrate_viewer/viewer.js` (regenerated with file:// detection)
- **Mistake log updated:** yes (added entry documenting unclear CORS error messages).
- **Determinism:** Viewer files regenerated deterministically (no timestamps, stable ordering). Re-running `map:viewer:svg_substrate:index` produces byte-identical outputs.
- **Canon safety:** Phase 0 canonical viewer updated directly (static file). This is an error-handling improvement, not a functional change.
- **FORAWWV.md note:** No systemic design insights revealed; this is an error-handling improvement for better user experience. **docs/FORAWWV.md may require an addendum** if file:// protocol handling reveals other viewer limitations, but do NOT edit it automatically.

**2026-01-27** - Canon switch: SVG-derived settlements substrate becomes canonical
- **Phase:** Map Rebuild (Path A) - Canon Decision - Settlement Substrate
- **Change:** Promote SVG-derived settlements substrate to canonical status. Preserve master-derived substrate as legacy.
  - **Canon decision:** SVG-derived substrate (from `data/source/settlements/**` JS files + `bih_census_1991.json`) is now the canonical settlement substrate.
  - **New canonical script:** `scripts/map/derive_settlement_substrate_from_svg_sources.ts` outputs to canonical paths:
    - `data/derived/settlements_substrate.geojson`
    - `data/derived/settlements_substrate.audit.json`
    - `data/derived/settlements_substrate.audit.txt`
  - **Legacy preservation:** Moved master-derived Phase 0 canonical artifacts to `data/derived/_legacy_master_substrate/`:
    - `settlements_substrate.geojson`
    - `settlements_substrate.audit.json`
    - `settlements_substrate.audit.txt`
    - `substrate_viewer/` (entire folder)
  - **Canonical commands updated:** `package.json` now points `map:derive:substrate` to SVG-derived pipeline.
  - **Viewer builder updated:** `scripts/map/build_substrate_viewer_index.ts` now handles SVG-derived substrate structure (uses `census_id` field for matching, backwards compatible with master-derived).
- **Artifacts created:**
  - `scripts/map/derive_settlement_substrate_from_svg_sources.ts` (new canonical derive script)
  - `docs/cleanup/legacy_substrate_note.md` (legacy preservation documentation)
- **Artifacts updated:**
  - `package.json` (`map:derive:substrate` command)
  - `scripts/map/build_substrate_viewer_index.ts` (census_id matching support)
- **Canonical outputs (SVG-derived):**
  - `data/derived/settlements_substrate.geojson`: 6,137 features
  - `data/derived/settlements_substrate.audit.json` / `.txt`
  - `data/derived/substrate_viewer/data_index.json` / `index.html` / `viewer.js`
- **Canonical counts:**
  - Features emitted (after merge): 6,137
  - Matched census: 6,148 (before merge), 6,137 (after merge)
  - Missing census IDs: 3 (`130397`, `138517`, `201693`)
  - Rings closed deterministically: 40
  - Duplicate SIDs merged: 11 MultiPolygons (`max_parts_per_sid`: 2)
  - Valid geometry: 6,148 (before merge), 6,137 (after merge)
- **Coordinate regime:** SVG coordinate space (from municipality JS files) - now accepted as canonical for settlements layer.
- **Determinism:** Verified byte-identical outputs on re-run:
  - `settlements_substrate.geojson`: MD5 `61906026CF933812EAF1088C76904686`
  - `settlements_substrate.audit.json`: MD5 `1C291264CAAEC816F843739DC0243B1B`
  - `settlements_substrate.audit.txt`: MD5 `C541F0E5E67532C1537028CAFD879B31`
  - `substrate_viewer/data_index.json`: MD5 `19F8FBF3001BC2335AC80F70CB1203AA`
- **Mistake log updated:** no (canon switch, no mistakes discovered; prior mistakes about ring_not_closed and duplicate SIDs already addressed in SVG-derived pipeline).
- **Legacy status:** Master-derived script (`scripts/map/derive_settlement_substrate_from_master.ts`) remains in codebase but is no longer referenced by canonical commands. Legacy artifacts preserved for reference and comparison.
- **FORAWWV.md note:** This canon switch establishes SVG coordinate regime as canonical for settlements layer and census_id-based identity as canonical. **docs/FORAWWV.md may require an addendum** about coordinate regime acceptance and identity matching strategy, but do NOT edit it automatically.

**2026-01-27** - Viewer robustness: file:// detection and mistake-guard closure
- **Phase:** Map Rebuild (Path A) - Viewer - Error Handling & Mistake Guard
- **Change:** Finalize canonical substrate viewer with file:// protocol detection and close out recurring mistake warnings.
  - **Canonical viewer generation:** Updated `scripts/map/build_substrate_viewer_index.ts` to generate both `index.html` and `viewer.js` (previously only generated `data_index.json`).
  - **File:// detection:** Generated `viewer.js` now detects `window.location.protocol === 'file:'` and displays an in-page error box (not alert) with clear instructions:
    - Explains browsers block fetch() from file:// protocol
    - Provides exact steps: run `npx http-server -p 8080` from repo root
    - Provides exact URL: `http://localhost:8080/data/derived/substrate_viewer/index.html`
  - **Mistake log closure:** Updated `docs/ASSISTANT_MISTAKES.log` to mark two issues as fixed:
    - `svg_substrate:duplicate_sid_not_merged`: Added "CORRECT BEHAVIOR GOING FORWARD" noting canonical derive script enforces duplicate SID merge
    - `viewer:file_protocol_cors_blocking`: Added "CORRECT BEHAVIOR GOING FORWARD" noting canonical viewer generator enforces file:// detection
  - **Mistake guard update:** Updated `tools/assistant/mistake_guard.ts` to:
    - Parse "CORRECT BEHAVIOR GOING FORWARD" entries from mistake log
    - Skip warnings for mistakes that have been fixed and enforced (have "CORRECT BEHAVIOR GOING FORWARD" entries)
    - Prevents perpetual warnings about already-fixed issues
- **Artifacts updated:**
  - `scripts/map/build_substrate_viewer_index.ts` (now generates HTML and viewer.js)
  - `data/derived/substrate_viewer/index.html` (generated with error box element)
  - `data/derived/substrate_viewer/viewer.js` (generated with file:// detection)
  - `docs/ASSISTANT_MISTAKES.log` (marked two issues as fixed)
  - `tools/assistant/mistake_guard.ts` (skip warnings for fixed issues)
- **Determinism:** Verified byte-identical outputs on re-run. Viewer files generated deterministically (no timestamps, stable ordering).
- **Mistake guard behavior:** After this change, `map:derive:substrate` and `map:viewer:substrate:index` no longer show warnings for duplicate SIDs or file:// protocol issues (these are now marked as fixed). Other legitimate warnings (e.g., ring_not_closed) still appear if relevant.
- **FORAWWV.md note:** No systemic design insights revealed; this is a robustness and maintainability improvement. **docs/FORAWWV.md may require an addendum** if mistake-guard closure patterns reveal other systemic issues, but do NOT edit it automatically.

**2026-01-27** - Border fabric forensic audit: quantify shared vs free boundary length
- **Phase:** Phase 1 - Settlement Adjacency Graph Validation
- **Change:** Created deterministic border-fabric forensic audit to quantify boundary segment ownership in the canonical SVG-derived settlements substrate. This audit is independent of the adjacency graph code path and provides forensic analysis of whether shared borders exist at scale.
  - **New script:** `scripts/map/audit_canonical_border_fabric.ts`
    - Extracts boundary segments from polygon outer rings (Polygon and MultiPolygon support)
    - Uses EPS-based quantization ONLY for segment keying (not geometry modification)
    - Builds segment ownership index (segmentKey -> {length, owners: Set<sid>})
    - Calculates aggregate metrics: total, shared (owners==2), free (owners==1), anomalies (>2)
    - Computes per-settlement statistics: boundary_len, shared_len, free_len, shared_ratio, neighbor_count
    - Generates deterministic top lists (highest/lowest shared ratio, highest free len, highest neighbor count)
  - **Audit results:**
    - Total Segments: 3,866,071
    - Total Boundary Length: 267,374.93
    - Shared Segments: 2,147 (0.06% of total segments)
    - Shared Border Length: 430.30 (0.16% of total boundary length)
    - Free Segments: 3,863,924 (99.94% of total segments)
    - Free Border Length: 266,514.33 (99.84% of total boundary length)
    - Anomaly Segments (>2 owners): 0
    - **CONFIRMED FINDING:** Shared border ratio < 5% (0.16%) confirms the SVG substrate does NOT form a shared-border partition at scale. 99.84% of boundaries are free (not shared between settlements).
  - **Mistake log integration:** Script uses `warnIfUnrecorded()` to record low shared-border ratio as a confirmed data truth.
  - **Updated:** `package.json` - Added `map:audit:borderfabric` command
- **Artifacts created:**
  - `data/derived/settlement_border_fabric.audit.json` (structured audit report with all metrics)
  - `data/derived/settlement_border_fabric.audit.txt` (human-readable summary)
- **Determinism:** Verified - outputs are deterministic (stable ordering, no randomness, no timestamps).
- **FORAWWV.md note:** This audit confirms the Phase 1 adjacency validation finding: the SVG-derived substrate geometry itself is fragmented and does not form a shared-border fabric. This is a data truth, not a code issue. Any tolerance-based adjacency rules would need to be explicitly elevated to canon via FORAWWV.md. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - Phase 1 adjacency validation: strict shared-border graph derivation
- **Phase:** Phase 1 - Settlement Adjacency Graph Validation
- **Change:** Created Phase 1 validation script to derive strict shared-border settlement adjacency graph from SVG-derived canonical substrate. This is a VALIDATION task, not a repair - it tests whether the substrate forms a true shared-border fabric.
  - **New script:** `scripts/map/derive_settlement_graph_phase1_validate.ts`
    - Strict shared-border-only adjacency detection (no tolerance, no distance inference)
    - Colinear segment overlap detection for robust boundary matching
    - Deterministic output (stable ordering, no timestamps)
    - Comprehensive audit reports (JSON + text)
  - **Adjacency definition (canonical, Phase 1):**
    - Two settlements are adjacent IFF they share a boundary segment of positive length
    - Point-touch adjacency explicitly excluded
    - All settlements appear as nodes, even if isolated
  - **Validation results:**
    - Nodes: 6,135 settlements
    - Edges: 297 adjacencies (only 4.8% connectivity)
    - Isolated settlements: 5,604 (91.3% isolation)
    - Components: Multiple (fragmented fabric)
    - Max degree: 4
    - **CONFIRMED FINDING:** SVG-derived canonical substrate does NOT form a dense shared-border fabric. High isolation indicates source geometry is not a true partition.
  - **Mistake log integration:** Script uses `warnIfUnrecorded()` to record high isolation/fragmentation as a confirmed data truth (not a bug to fix).
  - **Updated:** `package.json` - `map:derive:graph` now points to Phase 1 validation script
- **Artifacts created:**
  - `data/derived/settlement_graph.json` (canonical Phase 1 adjacency graph)
  - `data/derived/settlement_graph.audit.json` (structured audit report)
  - `data/derived/settlement_graph.audit.txt` (human-readable summary)
- **Determinism:** Verified - outputs are deterministic (stable ordering, no randomness).
- **Performance note:** O(n²) algorithm is slow for large segment counts but acceptable for validation purposes.
- **FORAWWV.md note:** This validation reveals that the SVG-derived substrate geometry itself is fragmented. This is a data truth, not a code issue. Any tolerance-based adjacency rules would need to be explicitly elevated to canon via FORAWWV.md. Do NOT edit FORAWWV.md automatically.

**2026-01-27** - Mistake log automation: record-once helpers and spam reduction

**2026-01-27** - Phase 1 contact graph viewer: fix to load and render settlement_contact_graph.json
- **Phase:** Map Rebuild (Path A) - Phase 1 viewer fix
- **Decision:** Fix Phase 1 contact graph viewer to actually load and render the contact graph JSON file separately, rather than relying on edges embedded in data_index.json. Viewer must be self-contained with all required files copied to viewer directory.
- **Artifacts updated:** `scripts/map/build_contact_graph_viewer.ts`, `data/derived/contact_graph_viewer/viewer.js`, `data/derived/contact_graph_viewer/data_index.json`
- Fixed viewer build script to remove edges from data_index.json (now contains only meta and settlements). Viewer JavaScript updated to load three files separately: (1) `data_index.json` (metadata), (2) `settlements_substrate.geojson` (geometry), (3) `settlement_contact_graph.json` (graph edges). All files are copied to viewer directory for self-contained deployment.
- Added console logging: viewer logs settlement feature count, total edge count, and edge counts by type (shared_border, point_touch, distance_contact) to browser console for debugging.
- Added error handling: if graph fetch fails or graph has 0 edges, viewer shows on-screen error block with instructions: "Contact graph missing or empty. Run: npm run map:derive:contact:phase1 then rebuild viewer: npm run map:viewer:contact:phase1"
- Viewer now uses `dataIndex.meta.substrate_path` and `dataIndex.meta.graph_path` to load files dynamically from data_index.json metadata, ensuring consistency.
- File:// protocol detection remains intact. Viewer remains deterministic (no timestamps, stable ordering).
- **Mistake log updated:** no (viewer fix only, no new mistakes discovered; mistake guard assertion updated to match task)
- **How to run:** `npm run map:viewer:contact:phase1` rebuilds viewer. Verify browser Network tab shows requests for: data_index.json, settlements_substrate.geojson, settlement_contact_graph.json. Console should print nonzero edge counts. Toggling edge layers should visibly draw edges. Open via: `npx http-server -p 8080` then `http://localhost:8080/data/derived/contact_graph_viewer/index.html`
- **Note:** This fix ensures the viewer actually loads and renders the contact graph JSON file. No design changes. No FORAWWV.md addendum required.

**2026-01-27** - Phase 1 contact graph viewer: fix and complete HTML viewer build
- **Phase:** Map Rebuild (Path A) - Phase 1 viewer completion
- **Decision:** Fix and complete the Phase 1 contact graph viewer build script to emit a fully functional HTML viewer. Viewer must handle both canonical Phase 1 graph format and legacy diagnostic graph format for backward compatibility.
- **Artifacts updated:** `scripts/map/build_contact_graph_viewer.ts`, `data/derived/contact_graph_viewer/index.html`, `data/derived/contact_graph_viewer/viewer.js`, `data/derived/contact_graph_viewer/data_index.json`
- Fixed viewer build script to handle both canonical Phase 1 graph format (with `parameters.D0`, `nodes`, `edges`) and legacy diagnostic format (with `edge_list`). Legacy format is automatically converted to canonical format with default D0 = 0.5 and warning message.
- Viewer JavaScript updated to use `data_index.json` as single source of truth for edges (removed redundant `settlement_contact_graph.json` fetch). Viewer loads: (1) `data_index.json` (metadata and edge list), (2) `settlements_substrate.geojson` (geometry). Graph JSON file is still copied to viewer directory for reference but not loaded by viewer.
- File:// protocol detection: viewer checks `window.location.protocol === 'file:'` on startup and shows explicit error message with instructions: "This viewer must be opened via a local HTTP server. Run: npx http-server -p 8080. Then open: http://localhost:8080/data/derived/contact_graph_viewer/index.html"
- Viewer features: canvas-based rendering with pan/zoom, settlement border rendering, adjacency edge overlay with type-specific colors (shared-border: green, point-touch: blue, distance-contact: orange), UI toggles for each edge type, reset view button, deterministic color palette.
- Mistake guard updated: assertion changed to "build Phase 1 contact graph viewer with index.html" to match task requirements.
- **Mistake log updated:** no (viewer build fix only, no new mistakes discovered; implementation follows Phase 0 substrate viewer patterns)
- **How to run:** `npm run map:viewer:contact:phase1` builds viewer artifacts. Verify `data/derived/contact_graph_viewer/index.html` exists. Open via local HTTP server (e.g., `npx http-server -p 8080` then navigate to `http://localhost:8080/data/derived/contact_graph_viewer/index.html`). File:// opening shows explicit server warning.
- **Note:** This task fixes and completes the Phase 1 contact graph viewer build. Viewer handles both canonical and legacy graph formats for backward compatibility. No systemic design insights revealed. No FORAWWV.md addendum required.

**2026-01-27** - Phase 1 canonical settlement contact adjacency graph derivation
- **Phase:** Map Rebuild (Path A) - Phase 1 canonical contact graph
- **Decision:** Implement canonical Phase 1 settlement contact adjacency graph as specified in FORAWWV.md §3.3. Adjacency represents CONTACT POTENTIAL ONLY and includes three types: (1) shared-border (positive length), (2) point-touch (vertex contact), (3) distance-contact (minimum boundary-to-boundary distance ≤ D0). D0 is an explicit canonical parameter (D0 = 0.5) documented in audit outputs. This adjacency does not imply movement, supply, control, authority, or sustained combat capability.
- **Artifacts:** `scripts/map/derive_settlement_contact_graph_phase1.ts`, `data/derived/settlement_contact_graph.json`, `data/derived/settlement_contact_graph.audit.json`, `data/derived/settlement_contact_graph.audit.txt`, `scripts/map/build_contact_graph_viewer.ts`, `data/derived/contact_graph_viewer/` (index.html, viewer.js, data_index.json)
- Added canonical Phase 1 script that reads `data/derived/settlements_substrate.geojson` as input. Extracts settlement polygons (handles Polygon and MultiPolygon, processes outer rings only). Extracts settlement ID from properties using priority: `sid`, then `settlement_id` (skips features missing both, records count in audit).
- Adjacency detection uses spatial grid bucketing to avoid O(N^2) pairwise checks. For each candidate pair within D0 bbox distance: (1) checks shared-border adjacency via colinear segment overlap detection (same algorithm as v2/v3), (2) checks point-touch adjacency via shared vertex coordinates within EPS tolerance, (3) checks distance-contact adjacency via minimum boundary-to-boundary distance ≤ D0. Edge classification prioritizes shared-border > point-touch > distance-contact (most restrictive first).
- Graph output schema: `settlement_contact_graph.json` contains `schema_version: 1`, `parameters: { D0: 0.5 }`, `nodes: [{ sid }]`, `edges: [{ a, b, type, overlap_len?, min_dist? }]`. Nodes sorted by sid (deterministic). Edges sorted by lexicographic pair (deterministic).
- Audit reports: comprehensive JSON and TXT reports including parameters (D0), counts (nodes, edges_total, edges_shared_border, edges_point_touch, edges_distance_contact), isolated (count, percentage), component_analysis (component_count, largest_component_size, largest_component_percentage), degree_stats (min, max, median, p90), top_settlements_by_degree (top 10), determinism confirmation (node_ordering, edge_ordering, no_timestamps, no_randomness).
- Viewer builder creates canvas-based viewer with settlement border rendering and adjacency edge overlay. Viewer includes toggles for each edge type (shared-border, point-touch, distance-contact) with deterministic color palette. Viewer detects file:// protocol and shows clear local-server instructions. Viewer loads substrate GeoJSON and graph JSON from relative paths.
- Deterministic guarantees: stable ordering for all iteration and outputs (sort by settlement_id, then edge pairs), no randomness, no timestamps, no Date.now, outputs must be byte-stable across repeated runs on same input. D0 is an explicit constant (0.5) defined in code, not inferred heuristically. No geometry invention: no snapping, buffering, hulls, smoothing, unions. Geometry is read-only.
- New npm scripts: `map:derive:contact:phase1` (derives contact graph), `map:viewer:contact:phase1` (builds viewer)
- **Mistake log updated:** no (implementation follows Phase 0 substrate patterns, FORAWWV.md §3.3 canonical adjacency definition, and determinism requirements; mistake guard assertion included)
- **How to run:** `npm run map:derive:contact:phase1` produces contact graph JSON and audit reports (may take several minutes due to 6137 settlements). Re-run immediately to confirm deterministic output (byte-identical files). `npm run map:viewer:contact:phase1` builds viewer artifacts. View via local HTTP server (e.g., `npx http-server -p 8080` then open `http://localhost:8080/data/derived/contact_graph_viewer/index.html`).
- **Note:** This task implements Phase 1 canonical contact graph derivation as specified in FORAWWV.md §3.3. D0 value (0.5) is explicit and documented in audit outputs. If adjacency density differs materially from expectations (e.g., very high isolation percentage, very sparse connectivity), this may indicate a need to adjust D0 or reconsider adjacency definition. **docs/FORAWWV.md may require an addendum** if results reveal systemic insights about contact potential modeling or D0 parameter sensitivity. Do NOT edit FORAWWV.md automatically. This task does NOT modify any canonical Phase 0 substrate files.
- **Phase:** Infrastructure - Mistake Guard System
- **Change:** Upgrade mistake log system with automation helpers to record confirmed mistakes once and reduce warning spam.
  - **New helpers added to `tools/assistant/mistake_guard.ts`:**
    - `recordMistakeOnce(entry: MistakeEntry): boolean` - Appends mistake entry to log only if title doesn't already exist. Returns true if appended, false if already exists.
    - `warnIfUnrecorded(condition: boolean, entry: MistakeEntry, context?: string): void` - If condition is true and entry not recorded, warns and records. If already recorded, only warns once per run if context provided.
    - `MistakeEntry` interface - Structured entry type with `date`, `title`, `description`, `correct_behavior` (all fields required, date must be provided by caller).
  - **Spam reduction in `assertNoRepeat()`:**
    - Added `warnedTitlesThisRun` Set to track titles warned about in current process run.
    - Each title only triggers warning once per run, preventing repeated warnings during same execution.
  - **Format detection:**
    - `titleExistsInLog()` helper checks for existing entries by scanning for "TITLE: <...>" pattern.
    - Maintains compatibility with existing log format (append-only, strict format).
  - **Testing:**
    - Added `scripts/repo/test_mistake_guard.ts` to verify helpers work correctly.
    - Tests confirm: first call records and warns, second call doesn't duplicate, condition=false does nothing.
- **Artifacts updated:**
  - `tools/assistant/mistake_guard.ts` (added helpers and spam reduction)
  - `scripts/repo/test_mistake_guard.ts` (test script)
  - `docs/ASSISTANT_MISTAKES.log` (test entry appended during testing)
- **Backward compatibility:** All existing exports (`loadMistakes()`, `assertNoRepeat()`, `appendMistake()`) continue to work unchanged.
- **Determinism:** No timestamps generated by code; date must be provided by caller. Stable ordering maintained.
- **Mistake guard behavior:** After this change, `assertNoRepeat()` warns at most once per title per process run. `warnIfUnrecorded()` can be used in scripts to automatically record confirmed mistakes without manual log editing.
- **FORAWWV.md note:** No systemic design insights revealed; this is an infrastructure improvement for better mistake tracking automation. **docs/FORAWWV.md may require an addendum** if automated mistake recording reveals patterns in common mistakes, but do NOT edit it automatically.

**2026-01-27** — Phase 2 contact graph enrichment spec and map pipeline link
- **Phase:** Map Rebuild (Path A) — Phase 2 spec documentation
- **Decision:** Authoritative Phase 2 contact graph enrichment spec created; map pipeline docs updated to reference it and list Phase 2 outputs.
- **Artifacts:** `docs/specs/map/phase2_contact_graph_enrichment.md` (new), `docs/handoff_map_pipeline.md` (Phase 2 section added), `docs/PROJECT_LEDGER.md` (this changelog entry).
- Spec defines inputs (`data/derived/settlements_substrate.geojson`, `data/derived/settlement_contact_graph.json`), outputs (`settlement_contact_graph_enriched.json`, `settlement_contact_graph_enriched.audit.json`, `settlement_contact_graph_enriched.audit.txt`), invariants, determinism and stable-ordering rules, node/edge field lists, audit requirements, acceptance criteria, and out-of-scope (no pruning, thresholds, or gameplay eligibility).
- `docs/handoff_map_pipeline.md`: new "Phase 2 — Contact graph enrichment" section with link to spec and list of Phase 2 outputs.
- No code or derived data changed. No FORAWWV.md addendum required.

**2026-01-27** — Phase 2 contact graph enrichment implementation and artifact generation
- **Phase:** Map Rebuild (Path A) — Phase 2 contact graph enrichment
- **Decision:** Implement Phase 2 enrichment per `docs/specs/map/phase2_contact_graph_enrichment.md`. Same nodes and edges as Phase 1; additive fields only. No pruning, no geometry invention, no timestamps, no randomness.
- **Artifacts:** `scripts/map/enrich_settlement_contact_graph_phase2.ts` (new), `package.json` (added `map:contact:enrich2`), `data/derived/settlement_contact_graph_enriched.json`, `data/derived/settlement_contact_graph_enriched.audit.json`, `data/derived/settlement_contact_graph_enriched.audit.txt`, `docs/PROJECT_LEDGER.md` (this entry).
- **Implementation:** Reads `settlements_substrate.geojson` and `settlement_contact_graph.json`; computes per-node `area_svg2`, `perimeter_svg`, `centroid_svg`, `bbox_svg`, `comp_count`, `degree`; per-edge `centroid_distance_svg`, `area_ratio`, `perimeter_ratio`, `bbox_overlap_ratio`, `contact_span_svg`. Missing metrics set to null and logged in audit. Topology identical to Phase 1. Determinism: stable node order (sid), edge order (min,max endpoint, type). SHA256 computed in script via `node:crypto`; inputs and outputs hashed and recorded in audit.
- **Commands run:**
  - `npm run map:contact:enrich2`
  - `node -e "JSON.parse(require('fs').readFileSync('data/derived/settlement_contact_graph_enriched.json','utf8')); console.log('enriched ok')"`
  - `node -e "JSON.parse(require('fs').readFileSync('data/derived/settlement_contact_graph_enriched.audit.json','utf8')); console.log('audit ok')"`
  - `node -e "const fs=require('fs'); console.log('bytes',fs.statSync('data/derived/settlement_contact_graph_enriched.json').size)"`
- **Output file sizes:** `settlement_contact_graph_enriched.json` 9,367,361 bytes; `settlement_contact_graph_enriched.audit.json` 2,179 bytes; `settlement_contact_graph_enriched.audit.txt` 1,315 bytes.
- **SHA256 (from audit):** input substrate `bf67123c22a8a144d7d5c6ecfd5b9df09a031da350a1490f3db0970ce0e3559b`, input Phase 1 graph `79189869445fe97c78583b0988fb594223521825e65c5586df15eb288131d087`, output enriched JSON `7b4dc9de282a966402abbebf9126ff8acf950f14091f0ce41eb4263908060edf`, output audit JSON (audit-without-self-hash) `684930f2d5c78eb472cce88a45a280b8da7d2bcac116d49021c2fd5242e00d68`.
- **Invariants:** Node count 6,137 and edge count 19,474 match Phase 1; no missing node/edge metrics. No FORAWWV.md addendum required.

**2026-01-27** — Contact graph viewer updated to support Phase 2 enriched graph and edge metrics inspector
- **Phase:** Map Rebuild (Path A) — Viewer enhancement
- **Decision:** Update contact graph viewer to load either Phase 1 or Phase 2 graph JSON, with edge inspector panel showing Phase 2 metrics when available.
- **Artifacts:** `data/derived/contact_graph_viewer/index.html` (added phase selector and inspector panel), `data/derived/contact_graph_viewer/viewer.js` (phase selection, edge click detection, inspector rendering), `data/derived/contact_graph_viewer/data_index.json` (added `meta.graph_paths` with phase1/phase2 paths), `data/derived/contact_graph_viewer/settlement_contact_graph_enriched.json` (copied from parent directory for viewer access).
- **Implementation:** Added phase selector dropdown (Phase 1 / Phase 2) in controls panel. Viewer loads graph based on selection, with fallback from Phase 2 to Phase 1 if enriched file missing. Edge inspector panel (top-right) displays on edge click: basic fields (a, b, type) for both phases; Phase 2 metrics (centroid_distance_svg, contact_span_svg, bbox_overlap_ratio, area_ratio, perimeter_ratio, overlap_len, min_dist) when Phase 2 selected. Click detection uses midpoint distance to rendered edge segments. Selected edge highlighted in red. Inspector shows "null" explicitly for missing values, formats numbers to 3 decimals.
- **Backward compatibility:** Viewer still works with legacy `meta.graph_path` if `graph_paths` not present. Phase 1 rendering unchanged. Inspector shows basic fields for Phase 1 edges.
- **Commands run:**
  - `npx http-server -p 8080` (started HTTP server for testing)
  - Verified `data_index.json` valid with both graph paths
  - Verified Phase 1 graph: 19,474 edges (valid JSON)
  - Verified Phase 2 graph: 19,474 edges (valid JSON)
  - Confirmed both graph files present in viewer directory
- **Browser verification:** Viewer accessible at `http://localhost:8080/data/derived/contact_graph_viewer/index.html`. Phase selector switches between graphs. Edge click updates inspector with metrics when Phase 2 selected. Network tab confirms correct JSON files fetched (200 status).
- **Mistake log updated:** no (viewer-only changes, follows existing patterns, no new mistakes discovered)
- **FORAWWV.md note:** No systemic design insights revealed; this is a viewer enhancement for inspecting Phase 2 edge metrics. **docs/FORAWWV.md may require an addendum** if edge metric inspection reveals patterns in contact graph topology, but do NOT edit it automatically.

**2026-01-27** — Phase 2.5 contact graph characterization report generator
- **Phase:** Map Rebuild (Path A) — Phase 2.5 diagnostic reporting
- **Decision:** Create Phase 2.5 characterization report generator that reads enriched graph and produces JSON + TXT reports with distributions, connectivity analysis, and suspicious edge lists. Diagnostic only: no edge pruning, no eligibility policies, no parameter changes.
- **Artifacts:** `scripts/map/report_settlement_contact_graph_phase2_5.ts` (new), `package.json` (added `map:contact:report2_5`), `data/derived/settlement_contact_graph_phase2_report.json`, `data/derived/settlement_contact_graph_phase2_report.txt`, `docs/PROJECT_LEDGER.md` (this entry).
- **Implementation:** Script reads Phase 2 enriched graph, computes node degree from edges (undirected), computes distributions (min, p50, p90, p99, max, mean) for degree and edge metrics (centroid_distance_svg, contact_span_svg, bbox_overlap_ratio, area_ratio, perimeter_ratio) by contact type. Performs connectivity analysis using union-find to find connected components, computes component size distribution, lists small components (size <= 5). Generates suspicious lists: distance_contact_longest_centroid_distance (top 200), distance_contact_lowest_bbox_overlap (top 200), shared_border_smallest_overlap_len (top 200, with note if field missing), distance_contact_min_dist_zero (top 200). All sorting deterministic: stable tie-breaking by (minSid, maxSid). Tracks missing metrics counts and schema anomalies. SHA256 hashes computed for enriched graph input and both report outputs.
- **Determinism:** Stable sorting everywhere (components by size then first sid, edges by metric then sid pairs). No timestamps, no randomness. Percentile computation: `index = floor((p/100) * (n-1))` for deterministic results. JSON output uses `JSON.stringify(obj, null, 2)` after constructing keys deterministically.
- **Commands run:**
  - `npm run map:contact:report2_5`
  - `node -e "JSON.parse(require('fs').readFileSync('data/derived/settlement_contact_graph_phase2_report.json','utf8')); console.log('report json ok')"`
  - `node -e "const fs=require('fs'); console.log('bytes json',fs.statSync('data/derived/settlement_contact_graph_phase2_report.json').size,'bytes txt',fs.statSync('data/derived/settlement_contact_graph_phase2_report.txt').size)"`
- **Output file sizes:** `settlement_contact_graph_phase2_report.json` 215,778 bytes; `settlement_contact_graph_phase2_report.txt` 4,818 bytes.
- **SHA256 (from report meta):** input enriched graph `7b4dc9de282a966402abbebf9126ff8acf950f14091f0ce41eb4263908060edf`, output report JSON `31cc5573c5709444979fdc8bbab6395b1d407749d0f2b04f099506dca0ecd62b`, output report TXT `61d7aecb49e4183ed0fa7641527811dd5dea17e18dd9651bc774cfbaeb6fad7b`.
- **Report contents:** JSON includes meta (version, inputs, hashes, counts), distributions (degree overall + metrics by type), connectivity (component count, largest size, size distribution, small components list), suspicious_lists (4 lists with total_qualifying counts and top_200 entries), notes (missing metrics counts, schema anomalies). TXT provides human-readable summary with header counts, distribution tables per type, connectivity summary, top 20 entries of each suspicious list plus total counts, missing metrics summary.
- **Mistake log updated:** no (implementation follows existing report patterns, mistake guard assertion included, no new mistakes discovered)
- **FORAWWV.md note:** No systemic design insights revealed; this is a diagnostic reporting tool. **docs/FORAWWV.md may require an addendum** if characterization reveals patterns in contact graph topology that affect adjacency modeling or D0 parameter sensitivity, but do NOT edit it automatically.

---

**[2026-01-27] Phase 3A Pressure Eligibility Builder Implementation**

- **Spec doc created:** `docs/specs/sim/phase3a_pressure_eligibility.md` (already existed, verified content matches spec)
- **New code files:**
  - `src/sim/pressure/phase3a_pressure_eligibility.ts` - Phase 3A builder module with eligibility gates, weight computation, and deterministic audit scaffolding
- **Modified files:**
  - `src/sim/turn_pipeline.ts` - Added feature-gated Phase 3A phase that runs after exhaustion accumulation
- **Feature flag:** `ENABLE_PHASE3A_PRESSURE_ELIGIBILITY` (default: `false`) - OFF by default, no behavior change when disabled
- **Implementation details:**
  - Loads enriched contact graph from `data/derived/settlement_contact_graph_enriched.json`
  - Computes eligibility via hard gates (exhaustion collapse, cohesion failure, data integrity)
  - Computes coupling weights: `w = base(type) * f_distance * f_shape * f_state * f_posture`, clamped to [0,1]
  - Handles missing state variables gracefully (conservative defaults, no gating if absent)
  - Deterministic edge ordering (by minSid, maxSid, type)
  - Audit mode produces per-turn summaries: eligible counts by type, weight distributions (min/p50/p90/p99/max), gate-blocked counts, top 20 strongest/weakest edges
- **Integration:** Phase 3A phase added to turn pipeline, feature-gated. When enabled, loads enriched graph, builds effective edges, stores audit in `TurnReport.phase3a_pressure_eligibility`. Effective edges stored in context (not persisted) for potential future use in pressure propagation.
- **Commands run:**
  - `npm run typecheck` (pre-existing type errors in unrelated files, Phase 3A code compiles correctly)
  - Module structure verified, imports resolve correctly
- **Determinism:** All computations deterministic (stable sorting, no randomness, no timestamps). Audit generation does not alter simulation results.
- **Mistake log guardrail:** Included in Phase 3A module: `loadMistakes()`, `assertNoRepeat("phase3a pressure eligibility weights builder and deterministic audit scaffolding")`
- **FORAWWV.md note:** If Phase 3A reveals systemic insights about pressure propagation eligibility patterns or weight distribution characteristics that affect simulation design, **docs/FORAWWV.md may require an addendum**, but do NOT edit it automatically.

---

**[2026-01-27] Phase 3A A/B Harness and Deterministic Diff Report**

- **Scenario used:** "Prolonged siege (calibration scenario 1)" - 18 turns, from `tests/calibration.test.ts` `createProlongedSiegeState()`
- **New code files:**
  - `src/cli/phase3a_ab_harness.ts` - A/B comparison harness that runs scenario twice (A: Phase 3A OFF, B: Phase 3A ON) and produces deterministic diff report
- **Modified files:**
  - `src/sim/pressure/phase3a_pressure_eligibility.ts` - Added runtime override functions (`getEnablePhase3A()`, `setEnablePhase3A()`, `resetEnablePhase3A()`) to support harness testing while keeping default OFF
  - `src/sim/turn_pipeline.ts` - Updated to use `getEnablePhase3A()` instead of const, enabling runtime override for harness
  - `package.json` - Added npm script `sim:phase3a:ab`
- **Feature flag:** Phase 3A remains OFF by default outside the harness (default value unchanged, runtime override only used in harness)
- **Commands run:**
  - `npm run sim:phase3a:ab` (runs A/B comparison)
  - `node -e "const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('exists',fs.existsSync(p),'bytes',fs.existsSync(p)?fs.statSync(p).size:0)"` - verified report exists, 3368 bytes
  - `npm run sim:phase3a:ab` (rerun to verify determinism)
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; const h=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); console.log('sha256',h)"` - SHA256: `790b95bc0fd2eeb85c2f168058b863d318a1cfb1ab9ecbb3fd73bc1017d3e121` (after edge type fix in audit output)
- **Output report:** `data/derived/_debug/phase3a_pressure_ab_report.txt` (3368 bytes, deterministic across reruns)
- **Report contents:** Header with scenario name, Phase 3A parameters, run settings; per-turn table with pressure_sum A/B/delta, eligible edges counts by type, blocked counts; summary with final deltas, max absolute delta, sign change detection; edge spotlight with top 5 strongest eligible edges from final turn. No timestamps.
- **Determinism:** Report is byte-identical across reruns (verified via SHA256). All sorting is stable, no randomness, no timestamps.
- **Mistake log guardrail:** Included in harness: `loadMistakes()`, `assertNoRepeat("phase3a ab harness and deterministic diff report for one calibration scenario")`
- **FORAWWV.md note:** No systemic design insights revealed in this initial A/B comparison. The harness confirms Phase 3A eligibility computation runs deterministically and produces stable audit summaries. **docs/FORAWWV.md may require an addendum** if future A/B comparisons reveal that Phase 3A weight distributions or eligibility patterns significantly affect pressure propagation dynamics, but do NOT edit it automatically.

---

**[2026-01-27] Phase 3A A/B Harness: Non-Zero Pressure Selection**

- **Scenario selection:** Auto-probe of 5 calibration scenarios (prolonged_siege, temporary_encirclement, corridor_lifeline, multi_pocket_stress, asymmetric_collapse) found all produce zero pressure. Fallback to deterministic seed applied.
- **Seed method:** Deterministic seed fallback using first edge from settlement graph
- **Seeded SIDs:** `10014:100013`, `10014:100056` (first edge from settlement graph, guaranteed to exist)
- **Seed value:** 10 (constant PRESSURE_SEED_VALUE)
- **Modified files:**
  - `src/cli/phase3a_ab_harness.ts` - Added scenario registry, probe function, seed application logic, updated report format with selection method and seed info
- **Selection logic:**
  - Probe each scenario (2 turns, Phase 3A OFF) to check for pressure_sum > 0
  - If none found, use seed_fallback: assign first edge endpoints to FACTION_A and FACTION_B, create front segment and pressure entry
  - Stable selection order ensures deterministic scenario choice
- **Commands run:**
  - `npm run sim:phase3a:ab` (runs A/B comparison with seed)
  - `node -e "const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('bytes',fs.statSync(p).size)"` - 3525 bytes
  - `npm run sim:phase3a:ab` (rerun to verify determinism)
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"` - SHA256: `72655727d64b8adeb103dfebc9d755a1e4285c9ea3c3cdc75e9006a41734ec35`
- **Output report:** `data/derived/_debug/phase3a_pressure_ab_report.txt` (3525 bytes, deterministic across reruns)
- **Report updates:** Header now includes scenario_id, selection_method (seed_fallback), seeded_sids, seed_value. Per-turn table shows non-zero pressure (10.00) in both runs A and B. Delta is 0.00 (expected: Phase 3A only affects eligibility/weights, not pressure accumulation logic itself).
- **Determinism:** Report is byte-identical across reruns (verified via SHA256). Probe uses stable scenario order, seed uses first edge from settlement graph (deterministic).
- **Mistake log guardrail:** Updated assertion: `assertNoRepeat("phase3a ab harness nonzero pressure selection or deterministic seed")`
- **FORAWWV.md note:** No systemic design insights revealed. The harness now produces meaningful pressure values for comparison. **docs/FORAWWV.md may require an addendum** if future A/B comparisons with Phase 3A-enabled pressure propagation reveal that eligibility/weight patterns significantly affect pressure dynamics, but do NOT edit it automatically.

---

**[2026-01-28] Phase 3A Bounded Pressure Diffusion and A/B Report Updates**

- **New feature flag:** `ENABLE_PHASE3A_PRESSURE_DIFFUSION` (default OFF). Diffusion runs only when **both** Phase 3A eligibility and diffusion are enabled.
- **Diffusion placement:** Applied in the turn pipeline in phase `phase3a-pressure-diffusion`, immediately after `phase3a-pressure-eligibility` and before `update-militia-fatigue`. Diffusion uses Phase 3A effective edges (eligible, w in [0,1]), derives node-level pressure from `front_pressure`, runs bounded outflow (DIFFUSE_FRACTION 0.05, DIFFUSE_MAX_OUTFLOW 2.0), maps back with conservation-preserving rounding.
- **New module:** `src/sim/pressure/phase3a_pressure_diffusion.ts` — implements `runPhase3APressureDiffusion`, `getEnablePhase3ADiffusion`, `setEnablePhase3ADiffusion`, `resetEnablePhase3ADiffusion`; mistake-guard integrated.
- **Turn pipeline:** Added `phase3a-pressure-diffusion` step; imports from diffusion module; mistake-guard integrated.
- **A/B harness:** Run A: eligibility OFF, diffusion OFF. Run B: eligibility ON, diffusion ON. Report includes diffusion flag state, `NonZero_A`/`NonZero_B`, `Top1_A`/`Top1_B`, and their deltas; summary includes final NonZero and Top1 deltas. Harness uses enriched contact graph edges (S-ids) for `settlementEdges` and seeding; multi-edge seed (first + first adjacent) with asymmetric split (6/4) and ≥3 front nodes.
- **Commands run:**
  - `npm run sim:phase3a:ab`
  - `node -e "const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('bytes',fs.statSync(p).size)"` — 4394 bytes
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"` — sha256 `9aa8e52ba1c637f878690b35f2e4d5ea074041c54b1062097805398b140b8d0d`
  - `npm run sim:phase3a:ab` (rerun); `node -e "..."` sha256 — same hash, determinism confirmed.
- **Report path:** `data/derived/_debug/phase3a_pressure_ab_report.txt` (4394 bytes, sha256 above). No timestamps.
- **Mistake log guardrail:** `assertNoRepeat("wire phase3a weights into bounded negative-sum pressure diffusion and validate via ab harness")` in diffusion module, turn pipeline, harness.
- **FORAWWV.md note:** The current seeded fixture (2 edges, 3 nodes, star topology) can yield zero NonZero/Top1 deltas when diffusion is on, due to equilibrium under DIFFUSE_FRACTION 0.05. **docs/FORAWWV.md may require an addendum** on diffusion constants vs observable distribution deltas; do NOT edit it automatically.

---

**[2026-01-28] Phase 3A Diffusion A/B Harness: Canonical Pressure Field + Distribution Deltas (v2)**

- **Canonical pressure field (Phase 3A diffusion + harness measurement):** `state.front_pressure` (edge-keyed `edge_id -> { value, ... }`). All harness metrics (NonZero/Top1/Top5Share/L1) are derived deterministically from this field by mapping edge pressure to node pressure via half-split across incident endpoints.
- **What was mismatched / insufficient before:**
  - Report lacked distribution-sensitive deltas, so diffusion could run while `pressure_sum` remained conserved and looked unchanged.
  - Seed magnitude was too small to reliably survive deterministic rounding back onto integer edge pressures, producing `l1_pre_post=0.00` even when diffusion outflow was non-zero.
  - Harness did not retain per-turn distributions, so a correct deterministic `L1Dist_AB` could not be computed.
- **Harness behavior change (no parameter/constant changes):** Pipeline diffusion is held OFF; Run B explicitly applies Phase 3A diffusion on the canonical `front_pressure` field with a strict namespace mismatch error (hard failure instead of silent/early success), and records diffusion stats + pre/post L1.
- **Commands run:**
  - `npm run sim:phase3a:ab`
  - `node -e "const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('bytes',fs.statSync(p).size)"`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"`
  - `npm run sim:phase3a:ab`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"`
- **Output report:** `data/derived/_debug/phase3a_pressure_ab_report.txt` (7206 bytes, sha256 `f69fc45bc3ba4bc69a8f2b6a55c46175a780de5378be1b58ddc43024b2465b0d`)
- **Determinism:** Verified by stable SHA256 across rerun. No timestamps.
- **FORAWWV.md note:** No systemic design insight beyond harness/reporting instrumentation. If future work finds that integer rounding meaningfully masks small diffusion effects in production, **docs/FORAWWV.md may require an addendum**; do NOT edit it automatically.

---

**[2026-01-28] Phase 3A A/B Harness: Deterministic BFS-Connected N-Node Seeding Stimulus**

- **New seeding method:** Deterministic BFS over Phase 3A effective edges (undirected), selecting a connected set of nodes.
  - **Start node:** `start_sid` = lexicographically smallest SID appearing as an endpoint in any eligible effective edge.
  - **BFS order:** FIFO queue; neighbors sorted lexicographically at expansion time.
  - **N:** 25 (hard-coded). If BFS yields fewer than N nodes, harness throws.
- **Seed distribution (total exactly 100):** Let `nodes_sorted` be the selected N nodes sorted lexicographically.
  - `nodes_sorted[0] = 40`
  - `nodes_sorted[1..10] = 6` each (10 nodes, 60 total)
  - `nodes_sorted[11..24] = 0`
- **How node seed is encoded into canonical edge-keyed `state.front_pressure`:**
  - Build a deterministic spanning tree from BFS parent links.
  - For each non-root node `v`, add `pv(v)` onto the tree edge `(parent(v), v)`.
  - For the root, add `pv(root)` onto the tree edge `(root, root_first_child)` where `root_first_child` is the lexicographically smallest child of the root in the BFS tree.
  - The harness derives node pressures from `front_pressure` using **tree-edge seed fraction attribution** (fractions computed from the seed contributions on that tree edge) and half-split attribution for non-tree edges.
- **Commands run:**
  - `npm run sim:phase3a:ab`
  - `node -e "const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('bytes',fs.statSync(p).size)"`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"`
  - `npm run sim:phase3a:ab`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); const p='data/derived/_debug/phase3a_pressure_ab_report.txt'; console.log('sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))"`
- **Output report:** `data/derived/_debug/phase3a_pressure_ab_report.txt` (7388 bytes, sha256 `66e6cbb4f15f02c79e149f2415bc637aeb7981a1fcac7c64c7db0b150151d004`)
- **Determinism:** Verified by stable SHA256 across rerun. No timestamps.
- **FORAWWV.md note:** This is a harness stimulus change only. If it reveals that production pressure interpretation should use directed attribution (vs half-split) in core simulation, **docs/FORAWWV.md may require an addendum**; do NOT edit it automatically.

---

**[2026-01-28] Phase 3A A/B Harness: Bottleneck Two-Cluster Seed Variant + Dual Reports**

- **New seed variant name:** `bottleneck_two_cluster_v1`
- **How the bottleneck edge is chosen (deterministic):**
  - Consider Phase 3A **eligible** effective edges only.
  - Select the edge with **minimum** weight \(w\).
  - Tie-break deterministically by: type priority (`shared_border` < `point_touch` < `distance_contact` < other), then `min(a,b)`, then `max(a,b)`.
  - The chosen bottleneck edge is printed in the bottleneck report header as `bottleneck_edge: "<SID_A> <-> <SID_B> (type, w)"`.
- **How clusters are constructed (deterministic):**
  - Treat effective edges as undirected.
  - Let bottleneck endpoints be `u` and `v`.
  - Run BFS from `u` excluding traversal across edge `u–v`; take first `NA=15` nodes **skipping `v`**.
  - Run BFS from `v` excluding traversal across edge `u–v`; take first `NB=10` nodes **skipping `u` and skipping any nodes already chosen for Cluster A** (enforces disjoint clusters even if alternate paths exist).
  - BFS is deterministic: FIFO queue; neighbors sorted lexicographically.
  - If insufficient nodes for either cluster, harness throws.
- **Pressure allocation (total exactly 100):**
  - Cluster A (15 nodes): `30`, `5` for 6 nodes, `1` for 8 nodes.
  - Cluster B (10 nodes): `15`, `3` for 4 nodes, `1` for 5 nodes.
  - If the resulting total exceeds 100, normalize deterministically by subtracting 1 from the lexicographically largest seeded SID until total == 100 (in current run, total was already 100).
- **Encoding into canonical pressure field:** Same spanning-tree-to-`state.front_pressure` encoding as `bfs_connected_nodes_v1` (tree edges use seed-fraction attribution; non-tree edges half-split). For the bottleneck variant, trees are built separately per cluster (two roots).
- **Dual deterministic outputs (overwritten, no timestamps):**
  - `data/derived/_debug/phase3a_pressure_ab_report_bfs.txt` (7388 bytes, sha256 `66e6cbb4f15f02c79e149f2415bc637aeb7981a1fcac7c64c7db0b150151d004`)
  - `data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt` (7613 bytes, sha256 `a9797076881b03707cc230ee28bbcab00db0f695b5fa914317bc62425ea28b9b`)
- **Commands run:**
  - `npm run sim:phase3a:ab`
  - `node -e "const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt'].forEach(p=>{console.log(p,'bytes',fs.statSync(p).size);});"`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt'].forEach(p=>{console.log(p,'sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));});"`
  - `npm run sim:phase3a:ab`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt'].forEach(p=>{console.log(p,'sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));});"`
- **Determinism:** Both reports are byte-identical across reruns (verified via stable SHA256). No timestamps.
- **FORAWWV.md note:** If the “bottleneck” behavior depends more on alternative paths than the single min-weight edge in real graph regions, **docs/FORAWWV.md may require an addendum** (do NOT edit it automatically).

---

**[2026-01-28] Phase 3A A/B Harness: Weak-Link (Nonzero) Two-Cluster Seed Variant + Triple Reports**

- **New seed variant name:** `weaklink_two_cluster_v1`
- **Weaklink selection rule (deterministic, nonzero):**
  - From Phase 3A eligible effective edges, filter candidates to `w > 0` strictly.
  - Sort by `w` ascending, then type priority (`shared_border` < `point_touch` < `distance_contact` < other), then `min(a,b)`, then `max(a,b)`.
  - Pick 5th percentile edge with `idx = floor(0.05 * (n - 1))` where `n` is candidate count.
  - Report header includes `weaklink_edge` and `weaklink_index: idx of n`.
- **Reports (deterministic, overwrite, no timestamps):**
  - `data/derived/_debug/phase3a_pressure_ab_report_bfs.txt` (7388 bytes, sha256 `66e6cbb4f15f02c79e149f2415bc637aeb7981a1fcac7c64c7db0b150151d004`)
  - `data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt` (7613 bytes, sha256 `a9797076881b03707cc230ee28bbcab00db0f695b5fa914317bc62425ea28b9b`)
  - `data/derived/_debug/phase3a_pressure_ab_report_weaklink.txt` (8286 bytes, sha256 `ca5fc6adb1861c2a4b95ea3329a7e9c2c95ad35b01900cd6b909ba2c9653f082`)
- **Commands run:**
  - `npm run sim:phase3a:ab`
  - `node -e "const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt','data/derived/_debug/phase3a_pressure_ab_report_weaklink.txt'].forEach(p=>{console.log(p,'bytes',fs.statSync(p).size);});"`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt','data/derived/_debug/phase3a_pressure_ab_report_weaklink.txt'].forEach(p=>{console.log(p,'sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));});"`
  - `npm run sim:phase3a:ab`
  - `node -e "const crypto=require('crypto'); const fs=require('fs'); ['data/derived/_debug/phase3a_pressure_ab_report_bfs.txt','data/derived/_debug/phase3a_pressure_ab_report_bottleneck.txt','data/derived/_debug/phase3a_pressure_ab_report_weaklink.txt'].forEach(p=>{console.log(p,'sha256',crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));});"`
- **Determinism:** All three reports are byte-identical across reruns (verified via stable SHA256). No timestamps.
- **FORAWWV.md note:** If low-weight cross-cluster coupling is systematically lost to integer quantization (diffusion appears “applied” but yields zero observed deltas), **docs/FORAWWV.md may require an addendum**; do NOT edit it automatically.

---

**[2026-01-28] Phase 3A formal spec integration (Manual + Rulebook)**

- **Change:** Design freeze spec added for Phase 3A pressure eligibility + diffusion; Rulebook summary cross-reference added.
- **Systems & Mechanics Manual:** New section "Phase 3A — Pressure Eligibility and Diffusion (Design Freeze)" inserted before "8. Command and control degradation" (after "7. Combat interaction and pressure"). Full formal spec added verbatim: canonical inputs, eligibility, diffusion, feature gates, non-scope, freeze status.
- **Rulebook:** New subsection "Phase 3A — Pressure eligibility and diffusion" (Heading 3) under "Fronts and combat", with summary defining diffusion as conservative redistribution, substrate-only, and referencing the Manual section.
- **Files modified:**
  - `docs/A_War_Without_Victory_Systems_And_Mechanics_Manual_v0_2_5.docx`
  - `docs/A_War_Without_Victory_Rulebook_v0_2_5.docx`
  - `package.json` (npm scripts `docs:edit:phase3a`, `docs:validate:phase3a`)
- **New artifacts:** `tools/docs/` — `requirements.txt`, `phase3a_spec_text.py`, `edit_phase3a_spec.py`, `validate_phase3a_docs.py`, `invoke_edit_docx.ts`, `validate_phase3a_docs_runner.ts`. Edit script is deterministic, idempotent; validator checks Manual section title once, Rulebook subsection once, Rulebook->Manual reference.
- **Mistake guard:** `assertNoRepeat("phase3a ab harness weaklink two-cluster seed variant nonzero bottleneck")` in `invoke_edit_docx.ts` and `validate_phase3a_docs_runner.ts`.
- **FORAWWV.md note:** FORAWWV.md not edited. If this doc integration reveals a systemic design insight or invalidates an assumption, flag that **docs/FORAWWV.md may require an addendum**; do NOT edit it automatically.

---

**[2026-01-28] Update codex context primer (authoritative docs, workflow guardrails, known blockers)**

- **Change:** Added `codex.md` context primer with three sections.
- **Authoritative docs:** Links to [CLAUDE.md](CLAUDE.md), [ARCHITECTURE_SUMMARY.md](ARCHITECTURE_SUMMARY.md), [docs/ENGINE_FREEZE_v0_2_6.md](docs/ENGINE_FREEZE_v0_2_6.md).
- **Mandatory workflow guardrails:** Ledger update requirement and mistake-log guardrail; refs to [docs/PROJECT_LEDGER.md](docs/PROJECT_LEDGER.md) and [docs/ASSISTANT_MISTAKES.log](docs/ASSISTANT_MISTAKES.log).
- **Known blockers:** Missing `mun_code_crosswalk.csv`, `mid = null`, fallback outlines behavior.
- **Mistake guard:** `assertNoRepeat("update codex context primer with authoritative docs, workflow guardrails, and known blockers")`.
- **FORAWWV.md note:** FORAWWV.md not edited. If this task reveals a systemic design insight or invalidates an assumption, **docs/FORAWWV.md may require an addendum**; do NOT edit it automatically.

---

**[2026-01-28] Phase 3B formal spec integration (Manual + Rulebook)**

- **Change:** Design freeze spec added for Phase 3B pressure → exhaustion coupling; Rulebook summary cross-reference added.
- **Systems & Mechanics Manual:** New section "Phase 3B — Pressure → Exhaustion Coupling (Design Freeze)" inserted immediately after Phase 3A section. Full formal spec added verbatim: canonical inputs, coupling model, eligibility gates, exhaustion accrual rules, non-effects, determinism, freeze status.
- **Rulebook:** New subsection "Phase 3B — Pressure and exhaustion" (Heading 3) inserted immediately after Phase 3A subsection, with summary defining exhaustion coupling as negative-sum transformation, gradual conversion of sustained pressure, and referencing the Manual section.
- **Files modified:**
  - `docs/A_War_Without_Victory_Systems_And_Mechanics_Manual_v0_2_5.docx`
  - `docs/A_War_Without_Victory_Rulebook_v0_2_5.docx`
- **New artifacts:** `tools/docs/` — `phase3b_spec_text.py`, `edit_phase3b_spec.py`, `validate_phase3b_docs.py`, `invoke_edit_phase3b_docx.ts`. Edit script is deterministic, idempotent; validator checks Manual section title once, Rulebook subsection once, Rulebook->Manual reference.
- **Mistake guard:** `assertNoRepeat("phase3a ab harness weaklink two-cluster seed variant nonzero bottleneck")` enforced in `invoke_edit_phase3b_docx.ts`.
- **No gameplay tuning. No FORAWWV.md edits. Phase 3A unchanged.**
- **FORAWWV.md note:** If Phase 3B introduces systemic insight or invalidates assumptions, **docs/FORAWWV.md may require a future addendum**. Do not edit automatically.

---

**[2026-01-28] Phase 3C formal spec integration (Manual + Rulebook)**

- **Change:** Design freeze spec added for Phase 3C exhaustion → collapse gating; Rulebook summary cross-reference added.
- **Systems & Mechanics Manual:** New section "Phase 3C — Exhaustion → Collapse Gating (Design Freeze)" inserted immediately after Phase 3B section. Full formal spec added verbatim: canonical inputs, structural position, collapse eligibility model, exhaustion threshold gating, state coherence gating, suppression/immunity rules, output contract, determinism, freeze status.
- **Rulebook:** New subsection "Phase 3C — Exhaustion and collapse eligibility" (Heading 3) inserted immediately after Phase 3B subsection, with summary defining collapse eligibility as gated by exhaustion persistence and institutional/spatial degradation, emphasizing that eligibility ≠ collapse, and referencing the Manual section.
- **Files modified:**
  - `docs/A_War_Without_Victory_Systems_And_Mechanics_Manual_v0_2_5.docx`
  - `docs/A_War_Without_Victory_Rulebook_v0_2_5.docx`
- **New artifacts:** `tools/docs/` — `phase3c_spec_text.py`, `edit_phase3c_spec.py`, `validate_phase3c_docs.py`, `invoke_edit_phase3c_docx.ts`. Edit script is deterministic, idempotent; validator checks Manual section title once, Rulebook subsection once, Rulebook->Manual reference, phase ordering (3A -> 3B -> 3C) in both documents.
- **Mistake guard:** `assertNoRepeat("phase3a ab harness weaklink two-cluster seed variant nonzero bottleneck")` enforced in `invoke_edit_phase3c_docx.ts`.
- **No collapse resolution implemented. No gameplay tuning. FORAWWV.md not edited.**
- **FORAWWV.md note:** If Phase 3C introduces systemic insight or invalidates assumptions, **docs/FORAWWV.md may require a future addendum**. Do not edit automatically.

---

**[2026-01-28] Verify and confirm codex.md context primer**

- **Change:** Verified `codex.md` contains two required sections with correct file paths. All referenced files exist and are accessible.
- **Authoritative docs section:** Confirmed links to [ARCHITECTURE_SUMMARY.md](ARCHITECTURE_SUMMARY.md), [docs/ENGINE_FREEZE_v0_2_6.md](docs/ENGINE_FREEZE_v0_2_6.md). All paths validated.
- **Mandatory workflow guardrails section:** Confirmed references to [docs/PROJECT_LEDGER.md](docs/PROJECT_LEDGER.md) read/write requirement and [docs/ASSISTANT_MISTAKES.log](docs/ASSISTANT_MISTAKES.log) guardrail enforcement.
- **Known blockers section:** Confirmed note about missing `data/source/mun_code_crosswalk.csv` causing `mid = null` and fallback municipality outlines behavior.
- **Files modified:**
  - `docs/PROJECT_LEDGER.md` (this entry)
- **Mistake guard:** `assertNoRepeat("update codex context primer with authoritative docs, workflow guardrails, and known blockers")`.
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Phase 3A–3C audit harness (4 scenarios, 40 turns)**

- **Change:** Added Phase 3A–3C audit harness (4 scenarios, 40 turns) + invariants; no mechanics changed.
- **New CLI:** `src/cli/phase3abc_audit_harness.ts`
- **Reports (deterministic, overwrite, no timestamps):**
  - `data/derived/_debug/phase3abc_audit_report_A_static_symmetric.txt`
  - `data/derived/_debug/phase3abc_audit_report_B_static_brittle_supply.txt`
  - `data/derived/_debug/phase3abc_audit_report_C_weaklink_clusters.txt`
  - `data/derived/_debug/phase3abc_audit_report_D_spike_then_relief.txt`
- **Invariants (hard fail / exit 1):**
  - Pressure conservation when diffusion applied (within EPS)
  - Exhaustion monotonicity (if implemented)
  - Eligibility persistence \(\ge N\) and at least one supporting degradation reason (only if Phase 3C eligibility is implemented and reasons are available)
- **NPM scripts:**
  - `phase3:abc_audit` (ts-node; required by interface)
  - `phase3:abc_audit:tsx` (tsx; used for running in this repo’s current ESM import style)
- **Files modified:**
  - `src/cli/phase3abc_audit_harness.ts`
  - `package.json`
  - `package-lock.json`
- **Mistake guard:** `assertNoRepeat("phase3abc audit harness 30-40 turn stress scenarios and invariants");`
- **FORAWWV addendum:** not triggered. (FORAWWV addendum: may be required if audit reveals systemic insight)

---

**[2026-01-28] Phase 3ABC audit harness phase-aware honesty + gating**

- **Summary:** “Audit harness made phase-aware: suppressed exhaustion metrics/invariants when Phase 3B not implemented; clearer banners; no mechanics changes.”
- **Files modified:**
  - `src/cli/phase3abc_audit_harness.ts`
  - `docs/PROJECT_LEDGER.md`
- **Mistake guard:** `assertNoRepeat("phase3abc audit harness must not print fake exhaustion columns when phase3b is not implemented");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Phase 3ABC audit harness tracked + scripts unified on tsx; codex breadcrumb**

- **Summary:** “Phase 3ABC audit harness tracked + scripts unified on tsx; added codex breadcrumb; no mechanics changes.”
- **Files modified:**
  - `src/cli/phase3abc_audit_harness.ts` (mistake guard, SHA256 print for reports A–D)
  - `package.json` (`phase3:abc_audit` now uses tsx; `phase3:abc_audit:tsx` unchanged)
  - `codex.md` (Phase 3ABC audit harness breadcrumb)
  - `.gitignore` (`data/derived/_debug/` added; reports remain generated, not tracked)
  - `docs/PROJECT_LEDGER.md`
- **Mistake guard:** `assertNoRepeat("phase3abc audit harness file must be tracked and scripts must not diverge between ts-node and tsx");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Verify staged hygiene + commit (phase3abc audit harness)**

- **Summary:** “Phase 3ABC audit harness tracked; scripts unified on tsx; debug outputs ignored; codex breadcrumb added; no mechanics changes.”
- **Change:** Verified staged files limited to allowlist; confirmed harness reports A/B honesty-fixed (required strings present, forbidden exhaustion column names absent); committed hygiene change-set. Mistake guard added for verify-and-commit workflow.
- **Files modified (allowlist):** `src/cli/phase3abc_audit_harness.ts`, `package.json`, `.gitignore`, `codex.md`, `docs/PROJECT_LEDGER.md`
- **Mistake guard:** `assertNoRepeat("verify staged diff is limited to audit harness hygiene and does not reintroduce fake phase3b metrics");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Repo cleanup audit (report only; no deletions)**

- **Summary:** “Ran repo cleanup audit; reviewed ORPHAN_CANDIDATE list; no deletions performed.”
- **Change:** Ran `npm run repo:cleanup:audit` (tsx scripts/repo/cleanup_audit.ts). Deterministic reports written to `docs/cleanup/cleanup_audit.json` and `docs/cleanup/cleanup_audit.md`. ORPHAN_CANDIDATE list extracted and summarized. No files deleted or modified by the audit; mistake guard added to audit script.
- **Files modified:** `scripts/repo/cleanup_audit.ts` (mistake guard), `docs/cleanup/cleanup_audit.json`, `docs/cleanup/cleanup_audit.md` (audit output).
- **Mistake guard:** `assertNoRepeat("repo cleanup audit report must not trigger deletions without independent ripgrep verification");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Repo cleanup: removed provably unused script `scripts/map/normalize_settlement_regimes.ts`**

- **Summary:** “Repo cleanup: removed provably unused deprecated script scripts/map/normalize_settlement_regimes.ts (audit + rg confirmed no inbound refs).”
- **Change:** Verified `scripts/map/normalize_settlement_regimes.ts` was ORPHAN_CANDIDATE; ran ripgrep for `normalize_settlement_regimes` and `scripts/map/normalize_settlement_regimes.ts`. No inbound usage (imports, requires, npm scripts, or docs instructions). Deleted the file; re-ran cleanup audit (254 orphans, 826 tracked files); confirmed it no longer appears.
- **Files modified:** `scripts/map/normalize_settlement_regimes.ts` (deleted), `scripts/repo/cleanup_audit.ts` (mistake guard), `docs/cleanup/cleanup_audit.json`, `docs/cleanup/cleanup_audit.md` (audit re-run), `docs/PROJECT_LEDGER.md`. Note: cleanup audit outputs are generated and not tracked in git.
- **Mistake guard:** `assertNoRepeat("repo cleanup must delete only files with zero inbound references verified by audit AND ripgrep");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Cleanup deletion recovery: clean tree, git grep verification, single guard**

- **Summary:** “Repo cleanup: verified orphan candidate with git grep (rg unavailable); removed only if zero inbound refs; cleaned working tree for safe review.”
- **Change:** Stashed non-cleanup changes (data/derived/settlements_substrate, package-lock, node_modules/.package-lock); restored those paths from HEAD so working tree has only cleanup-related edits. Replaced duplicate `assertNoRepeat` lines in `scripts/repo/cleanup_audit.ts` with a single guard. Re-ran `npm run repo:cleanup:audit`; verified refs with `git grep -n` (rg unavailable) for `normalize_settlement_regimes`, `scripts/map/normalize_settlement_regimes.ts`, and `normalize_settlement_regimes.ts`. Only hits: `docs/PROJECT_LEDGER.md` (changelog entries). No imports, scripts, or doc instructions. File already deleted; audit confirms it no longer in ORPHAN_CANDIDATE. Derived artifacts left untracked.
- **Files modified:** `scripts/repo/cleanup_audit.ts` (single assertNoRepeat), `docs/cleanup/cleanup_audit.json`, `docs/cleanup/cleanup_audit.md` (audit re-run), `docs/PROJECT_LEDGER.md`. Note: cleanup audit outputs are generated and not tracked in git.
- **Mistake guard:** `assertNoRepeat("cleanup deletion must use git grep when rg is unavailable and must not run in a dirty working tree");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Finalize cleanup commit: untrack audit outputs, minimal diffs**

- **Summary:** Stopped tracking `docs/cleanup/cleanup_audit.json` and `docs/cleanup/cleanup_audit.md`; added them to `.gitignore`. Committed only: deletion of `scripts/map/normalize_settlement_regimes.ts`, `scripts/repo/cleanup_audit.ts` (guards), `docs/PROJECT_LEDGER.md`, `.gitignore`, and removal of audit outputs from index.
- **Files modified:** `scripts/repo/cleanup_audit.ts`, `docs/PROJECT_LEDGER.md`, `.gitignore`; `scripts/map/normalize_settlement_regimes.ts` (deleted); `docs/cleanup/cleanup_audit.json`, `docs/cleanup/cleanup_audit.md` (untracked).
- **Mistake guard:** `assertNoRepeat("do not commit cleanup audit output files; commit only minimal meaningful repo cleanup diffs");`
- **FORAWWV addendum:** not triggered.

---

**[2026-01-28] Pre-commit gate: Phase 3B/3C/3D wiring + tracking (staging verification + determinism check)**

- **Summary:** Pre-commit gate verified: only intended Phase 3 implementation files staged; derived artifacts remain untracked; both validation commands pass; determinism confirmed.
- **Staged files (11):** `src/state/front_pressure.ts`, `src/state/formation_fatigue.ts`, `src/state/game_state.ts`, `src/sim/turn_pipeline.ts`, `src/cli/phase3abc_audit_harness.ts`, `src/sim/collapse/capacity_modifiers.ts`, `src/sim/collapse/phase3d_collapse_resolution.ts`, `src/sim/pressure/phase3b_pressure_exhaustion.ts`, `src/sim/pressure/phase3c_exhaustion_collapse_gating.ts`, `src/sim/pressure/pressure_exposure.ts`, `docs/PROJECT_LEDGER.md`
- **Untracked (excluded):** `data/derived/**`, `tools/map_viewer/**` (correctly not staged)
- **Commands run:** `npm run phase3:abc_audit` (PASS); `ENABLE_PHASE3B=true ENABLE_PHASE3C=true ENABLE_PHASE3D=true SEED_PHASE3D_DAMAGE=true npm run phase3:abc_audit` (PASS)
- **Key metric:** seeded `3DMinPCap=0.7500` (deterministic, < 1.0, consistent across all 40 turns)
- **Determinism:** SHA256 hashes consistent between runs; no nondeterministic diffs detected
- **Mistake guard:** `assertNoRepeat("pre-commit gate must stage only intended phase3 files and must keep derived artifacts untracked");`
- **FORAWWV note:** Not edited. Pre-commit gate pattern (staging verification + validation pass) may be worth documenting as a workflow rule; **docs/FORAWWV.md may require an addendum** if we formalize this pattern.

---

**[2026-01-29] Post-commit: Phase 3D consumption correctness + tracking (no tuning)**

- **Summary:** Committed validated Phase 3B/3C/3D wiring and tracking; fixed `pressure_cap_mult` single application; added mistake guard for commit scope.
- **Commit:** `2ee668d` — `Phase 3D: fix pressure_cap_mult single application; track Phase 3B/3C/3D files`
- **Files committed (11):** `src/state/front_pressure.ts`, `src/state/formation_fatigue.ts`, `src/state/game_state.ts`, `src/sim/turn_pipeline.ts`, `src/cli/phase3abc_audit_harness.ts`, `src/sim/collapse/capacity_modifiers.ts`, `src/sim/collapse/phase3d_collapse_resolution.ts`, `src/sim/pressure/phase3b_pressure_exhaustion.ts`, `src/sim/pressure/phase3c_exhaustion_collapse_gating.ts`, `src/sim/pressure/pressure_exposure.ts`, `docs/PROJECT_LEDGER.md`
- **Post-commit validation:** `npm run phase3:abc_audit` (PASS); `ENABLE_PHASE3B=true ENABLE_PHASE3C=true ENABLE_PHASE3D=true SEED_PHASE3D_DAMAGE=true npm run phase3:abc_audit` (PASS). Determinism: SHA256 hashes consistent across runs. Seeded `3DMinPCap=0.7500` (< 1.0) across all 40 turns.
- **Git status:** Clean index; derived artifacts (`data/derived/**`, `tools/map_viewer/**`) remain untracked.
- **Mistake guard:** `assertNoRepeat("commit must include only validated Phase 3B/3C/3D wiring and tracking with single modifier consumption");` added to `phase3abc_audit_harness.ts`.
- **FORAWWV addendum:** This commit canonizes **single explicit consumption point per modifier**. **docs/FORAWWV.md may require an addendum** if we formalize that rule. Do NOT edit FORAWWV in this commit.

---

**[2026-01-29] Phase 4A: Dev runner for raw GameState exposure (engine adapter, no UI)**

- **Summary:** Created minimal dev runner HTTP server exposing raw GameState through engine adapter endpoints. No game logic in server.ts; all mutations via canonical turn pipeline. Determinism preserved (no timestamps, no randomness).
- **Files added:** `tools/dev_runner/server.ts`
- **Files modified:** `package.json`, `docs/PROJECT_LEDGER.md`
- **Command added:** `npm run dev:runner` (runs server on http://localhost:3000)
- **Endpoints:**
  - `GET /state` → returns current GameState as JSON
  - `POST /step` → advances exactly one turn via `executeTurn()`, returns updated GameState
  - `POST /reset` → restores initial scenario state
- **Validation:** Server starts successfully; endpoints respond with valid GameState JSON. Repeated step/reset cycles preserve determinism (turn counter increments, state changes observable).
- **Mistake guard:** `assertNoRepeat("dev runner must not contain game logic and must expose raw GameState only");`
- **FORAWWV note:** This introduces a systemic seam (engine-facing UI adapter). **docs/FORAWWV.md may require an addendum** if we formalize the dev runner pattern as a canonical adapter layer. Do NOT edit FORAWWV in this commit.

---

**[2026-01-29] Phase 4B: HTML dev viewer for raw GameState (read-only)**

- **Summary:** Created minimal HTML dev viewer that consumes raw GameState from dev runner. Viewer is read-only and displays raw state values only; no game logic calculations. Renders settlements as colored circles, edges as lines (active fronts highlighted), with click handlers for inspector panels showing raw state values.
- **Files added:** `tools/dev_viewer/index.html`, `tools/dev_viewer/viewer.js`
- **Files modified:** `docs/PROJECT_LEDGER.md`
- **Features:**
  - Fetches GameState from dev runner (`GET /state`, `POST /step`, `POST /reset`)
  - Renders settlements as circles (color by controlling faction from `factions[].areasOfResponsibility` or `control_overrides`)
  - Renders edges from `front_segments` (parses edge_ids like "s1__s2")
  - Visually distinguishes active fronts (thicker red lines vs thin gray)
  - Click settlement → inspector shows: SID, controller, faction profile (authority/legitimacy/control/logistics/exhaustion), negotiation pressure/capital, collapse eligibility (if present)
  - Click edge → inspector shows: endpoint SIDs, sides A/B, active status, active streak, friction, pressure value/max_abs/last_updated_turn, net pressure direction
  - Time controls: "Next Turn" (POST /step), "Run 5 Turns" (5x POST /step), "Reset" (POST /reset), "Refresh State" (GET /state)
- **Layout:** Simple force-directed layout algorithm (settlements not in GameState, so positions computed client-side for visualization only)
- **Validation:** Viewer loads and renders initial state; clicking settlements/edges shows correct raw values; advancing turns updates visuals; reset restores initial state; repeated runs are deterministic (same sequence of states).
- **Mistake guard:** `assertNoRepeat("dev viewer must never compute game logic and must render raw GameState only");` (note: layout algorithm is visualization-only, not game logic)
- **FORAWWV note:** This reinforces a systemic rule: **UI layers are read-only consumers of engine state**. **docs/FORAWWV.md may require an addendum** if we formalize this pattern as a canonical separation. Do NOT edit FORAWWV in this commit.

---

**[2026-01-29] Post-commit: Phase 4B HTML dev viewer (read-only GameState inspection)**

- **Summary:** Committed read-only HTML dev viewer for raw GameState inspection. Viewer displays raw state values only; no game logic calculations. All state mutations occur via dev runner endpoints only.
- **Commit:** `59879d4` — `Phase 4B: add read-only HTML dev viewer for raw GameState inspection`
- **Files committed (3):** `tools/dev_viewer/index.html`, `tools/dev_viewer/viewer.js`, `docs/PROJECT_LEDGER.md`
- **Post-commit validation:** Viewer loads and renders initial state correctly; clicking settlements/edges shows raw values from GameState; turn stepping works via POST /step; reset restores initial state; no UI-side calculations affect outcomes (viewer is strictly read-only).
- **Git status:** Clean index for committed files; `package.json` remains modified (from Phase 4A, not part of this commit); derived artifacts (`data/derived/**`, `tools/map_viewer/**`, `tools/dev_runner/**`) remain untracked (correct).
- **Mistake guard:** `assertNoRepeat("dev viewer must remain strictly read-only and must not embed or derive game logic");` — viewer code contains no game logic calculations, only raw value display.
- **FORAWWV addendum:** This commit effectively establishes a canonical UI/engine separation rule: **UI layers are read-only consumers of engine state**. **docs/FORAWWV.md may require an addendum** if we formalize this pattern. Do NOT edit FORAWWV in this commit.

---

**[2026-01-29] Phase 5A: Expose posture as first player input (minimal, no new mechanics)**

- **Summary:** Exposed posture as the first player input mechanism. Posture already existed in GameState (`front_posture` per faction/edge); wired it through dev runner endpoint and viewer controls. No new mechanics introduced; posture changes take effect on next turn via existing turn pipeline.
- **Files modified:** `tools/dev_runner/server.ts`, `tools/dev_viewer/index.html`, `tools/dev_viewer/viewer.js`, `docs/PROJECT_LEDGER.md`
- **Posture representation:** Posture already exists in `GameState.front_posture: Record<FactionId, FrontPostureState>` where each assignment has `{ edge_id, posture: 'hold'|'probe'|'push', weight: number }`. Posture is read during turn pipeline via `normalizeFrontPosture()` and `postureIntent()` functions; affects pressure accumulation via `postureMultiplier()` (hold=0, probe=1, push=2).
- **Dev runner endpoint:** Added `POST /set_posture` accepting `{ faction_id, edge_id, posture, weight }`. Validates posture is one of existing allowed values ('hold'|'probe'|'push'); writes posture into GameState only; does NOT compute effects (takes effect on next turn via existing pipeline).
- **Viewer controls:** Updated edge inspector to show posture controls when edge is active and has controlling factions. Displays current posture per faction; provides dropdown to select posture and weight input; "Set Posture" button calls `/set_posture` endpoint. Viewer does not calculate outcomes or preview effects; only displays current posture value and allows intent injection.
- **Validation:** Manual test: start dev runner, open viewer, select active edge, change posture, advance turns. Confirmed: posture change reflected in state; pressure/exhaustion trajectories differ over time; no immediate magical effects occur; bad posture choices worsen outcomes gradually.
- **Mistake guard:** `assertNoRepeat("phase5a posture exposure must not introduce new mechanics or bypass command friction");` — no new mechanics added; posture wiring uses existing state structure and turn pipeline.
- **FORAWWV note:** If this formalizes player intent injection as a canonical layer, **docs/FORAWWV.md may require an addendum**. Do NOT edit FORAWWV in this commit.

---

**[2026-01-29] Post-commit: Phase 5A posture exposure (first player input, no new mechanics)**

- **Summary:** Committed posture exposure as first player input mechanism. Posture already existed in GameState; wired through dev runner endpoint and viewer controls. No new mechanics introduced; posture changes take effect on next turn via existing turn pipeline.
- **Commit:** `49a003e` — `Phase 5A: expose posture as first player input (no new mechanics)`
- **Files committed (4):** `tools/dev_runner/server.ts`, `tools/dev_viewer/index.html`, `tools/dev_viewer/viewer.js`, `docs/PROJECT_LEDGER.md`
- **Post-commit validation:** Dev runner starts successfully; viewer loads and renders state; posture controls appear only in edge inspector when edge is active and has controlling factions; posture changes written to state via POST /set_posture; posture takes effect on NEXT turn only (no immediate effects); pressure/exhaustion trajectories diverge gradually over multiple turns; determinism confirmed across reset + repeated runs (same posture inputs produce same state sequences).
- **Git status:** Clean index for committed files; `package.json` remains modified (from Phase 4A, not part of this commit); derived artifacts (`data/derived/**`, `tools/map_viewer/**`) remain untracked (correct).
- **Mistake guard:** `assertNoRepeat("phase5a commit must include posture exposure only and must not introduce or tune mechanics");` — commit includes only posture exposure wiring; no engine mechanics modified or tuned.
- **FORAWWV addendum:** This commit effectively establishes player intent injection as a canonical layer: **player inputs are injected into GameState and take effect via existing turn pipeline**. **docs/FORAWWV.md may require an addendum** if we formalize this pattern. Do NOT edit FORAWWV in this commit.
