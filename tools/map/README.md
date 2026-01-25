# Map Build Pipeline (Path A)

This directory contains tools for rebuilding the deterministic map substrate from source files using **Path A**: polygons are territorial micro-areas, separate from settlement entities.

## Overview

The map build pipeline reads source files and produces a complete set of map artifacts:

**Sources:**
- `data/source/master_settlements.xlsx` - Settlement census data by municipality (authoritative settlement universe)
- `data/source/settlements_map_CURRENT_dark_zoom_v2_added_breza_centar_jezero.html` - HTML file with FEATURES constant containing SVG polygon paths
- `data/source/mun_code_crosswalk.csv` (optional) - Crosswalk mapping polygon `mun_code` to canonical `mid`

**Outputs (in `data/derived/`):**
- `polygon_fabric.json` - Polygon features extracted from HTML (poly_id, mun_code, name_html, d)
- `polygon_fabric.geojson` - GeoJSON polygons (poly_id, mun_code) in LOCAL_PIXELS_V2
- `polygon_fabric_with_mid.geojson` - Polygons with mid added via crosswalk (poly_id, mun_code, mid) - only if crosswalk exists
- `settlements_meta.csv` - Settlement metadata from Excel (sid, name, mid, municipality_name, lat, lon, source_row_id)
- `settlement_points_from_excel.geojson` - Settlement points (sid, mid, synthetic flag) in LOCAL_PIXELS_V2
- `municipality_outline.geojson` - Derived municipality outlines (mid) in LOCAL_PIXELS_V2 - empty if no crosswalk
- `national_outline.geojson` - National outline fallback (union of all polygons) - only if crosswalk missing
- `mun_code_summary.csv` - Diagnostic summary of mun_code values in polygon fabric
- `settlements_inspector.html` - Visual inspection tool (always shows polygon fabric)
- `geometry_report.json` - Build statistics and validation metrics
- `municipality_coverage_report.json` - Municipality coverage audit (expected vs borders; see **Municipality coverage audit**)
- `municipality_missing_borders.csv` - One row per missing municipality id (borders absent)
- `municipality_missing_borders.json` - `{ missing, extra }` sorted arrays from coverage audit

## Path A Architecture

**Key Principle:** Polygons and settlements are separate entities.

- **Polygons** (`poly_id`): Territorial micro-areas from SVG, identified by `poly_id`. Linked to municipalities via `mun_code` → `mid` crosswalk.
- **Settlements** (`sid`): Simulation entities from Excel, identified by `sid`. Linked to municipalities via `mid`.
- **Municipalities** (`mid`): Pre-1991 municipality IDs. Polygons and settlements both link to municipalities, but not directly to each other.

This separation allows:
- Polygons to be used for visualization and territorial substrate
- Settlements to remain point+graph entities for simulation
- No forced 1:1 matching between incompatible ID schemes

## Usage

### Building the Map

```bash
pnpm build:map
# or
npm run build:map
```

This will:
1. Extract polygon features from HTML file → `polygon_fabric.json`
2. Convert SVG paths to GeoJSON polygons → `polygon_fabric.geojson`
3. Read Excel metadata, filter aggregate rows (∑) → `settlements_meta.csv`
4. Apply municipality code crosswalk (if exists) → `polygon_fabric_with_mid.geojson`
5. Derive municipality outlines from polygon fabric (or settlement points if no crosswalk) → `municipality_outline.geojson`
6. Generate settlement points from Excel (true coords or synthetic placement) → `settlement_points_from_excel.geojson`
7. Build visual inspection HTML → `settlements_inspector.html`
8. Generate geometry report → `geometry_report.json`

### Municipality coverage audit

```bash
npm run audit:muni
```

Compares expected municipalities (from `settlements_meta.csv`) vs present municipalities (from `municipality_borders.geojson`). **Requires explicit ID crosswalk** to normalize 5-digit border IDs to 7-digit canonical municipality IDs.

**Inputs:**
- `data/derived/settlements_meta.csv` — expected municipalities (7-digit `mid` values)
- `data/derived/municipality_borders.geojson` — present municipality borders (5-digit `munID` values from drzava.js)
- `data/refs/municipality_id_crosswalk.csv` — explicit mapping table (required)

**Crosswalk file format:**
- Columns: `munid_5,mid_7,name`
- `munid_5`: 5-digit ID from `municipality_borders.geojson` features
- `mid_7`: 7-digit canonical pre-1991 municipality ID from `settlements_meta.csv`
- `name`: optional, for human readability
- Must have no duplicates in either `munid_5` or `mid_7` columns
- Sorted by `munid_5` ascending (deterministic)

**Outputs:**

- `data/derived/municipality_coverage_report.json` — counts, `missing` / `extra` arrays, `unmapped_border_ids`, `crosswalk_stats`, `id_scheme` metadata, input file mtimes
- `data/derived/municipality_missing_borders.csv` — `municipality_id` column, one row per missing id, sorted
- `data/derived/municipality_missing_borders.json` — `{ "missing": [...], "extra": [...] }` sorted

**“Missing”** means a municipality id appears in settlements metadata but has **no** corresponding feature in `municipality_borders.geojson` (after crosswalk normalization). Do not infer geometry from settlements; the audit only reports the discrepancy.

**ID normalization:**
- Border features are read with their raw 5-digit `munID` values
- Each `munID` is mapped to a 7-digit `mid_7` via the crosswalk
- Unmapped border IDs are tracked in `unmapped_border_ids` (not counted as "present")
- Comparison is done using normalized 7-digit IDs: `expected_mid_7_set` vs `present_mid_7_set`

**"Unmapped border IDs"** are 5-digit IDs from border features that have no entry in the crosswalk. These are reported separately and are not counted as "present" municipalities in the coverage comparison.

### Border ID extraction diagnostic

```bash
npm run audit:muni:diagnose-borders
```

Deterministic diagnostic to explain why only 13/138 border features map via the crosswalk. **Read-only analysis**: reports raw vs normalized ID differences, no geometry changes, no inference, no remapping heuristics.

**Inputs:**
- `data/derived/municipality_borders.geojson` — border features (same one used by audit)
- `data/refs/municipality_id_crosswalk.csv` — crosswalk mapping table

**Outputs:**
- `data/derived/municipality_audit/border_id_diagnostic.json` — detailed diagnostic array (stable sorted by feature_index)
- `data/derived/municipality_audit/border_id_diagnostic.csv` — same fields in CSV format

**For each border feature, the diagnostic reports:**
- `feature_index` — 0-based feature index
- `extracted_raw_id` — the current extraction result before any trimming/casting
- `extracted_raw_id_type` — "string" | "number" | "null"
- `extracted_from_key` — which property key actually produced it
- `all_candidate_keys_present` — compact object listing presence/value of candidate keys (mid, munID, mun_id, mun_code, id, ID, MUNID, municipality_id)
- `normalized_id_attempt` — diagnostic normalization attempts (raw_string, trimmed, digits_only, padded_5_if_digits)
- `crosswalk_match_status` — match results for each normalization strategy (direct_match, trimmed_match, digits_only_match, padded_5_match, matched_munid_5, matched_mid_7)

**This diagnostic helps identify:**
- Wrong key used for extraction
- Formatting differences (whitespace, leading zeros)
- Mixed ID schemes in the GeoJSON
- Why mapping rate is low (13/138)

**Note:** This is diagnostic only. It does NOT change the audit logic or geometry. Use the results to understand the schema/format mismatch before expanding the crosswalk.

### Settlement-to-municipality alignment audit

```bash
npm run audit:settlements:muni
```

Validates settlement metadata municipality references against the authoritative post-1995 municipality set as present in the border GeoJSON (drzava.js lineage). **No geometry generation or modification**. No inference, no heuristics, no automatic remapping. Purely reports mismatches and coverage gaps.

**Inputs:**
- `data/derived/settlements_meta.csv` — settlement metadata (same canonical source used by previous audits)
- `data/derived/municipality_borders.geojson` — authoritative post-1995 municipality set (drzava.js lineage)

**Outputs (in `data/derived/municipality_audit/`):**

- `settlement_muni_alignment_report.json` — summary statistics and lists:
  - `authoritative_municipalities`: count and sorted IDs from borders GeoJSON
  - `settlements`: total/used/skipped rows, counts by reference status (valid/missing/unknown)
  - `municipalities`: counts of municipalities with zero vs some settlements
  - `unknown_muni_refs`: sorted list of unknown municipality reference values
  - `id_scheme`: metadata describing ID schemes used
- `settlements_missing_muni_ref.csv` — settlements where no municipality field found at all (columns: `sid_excel`, `settlement_name`, `source_field`, `raw_value`)
- `settlements_unknown_muni_ref.csv` — settlements where a municipality value exists but is not in authoritative set (columns: `sid_excel`, `settlement_name`, `source_field`, `raw_value`)
- `municipalities_zero_settlements.csv` — authoritative municipalities that have zero settlements referencing them (columns: `munid_5`, `municipality_name`)

**Municipality reference extraction:**
- For each settlement row, checks municipality fields in priority order:
  1. `munid_5`
  2. `munID`
  3. `mun_id`
  4. `mun_code`
  5. `mid`
- Records which field was used (`source_field`) and the raw value as string
- Considered valid ONLY if raw value exactly matches an authoritative `munid_5` from borders GeoJSON
- **No normalization** (no trimming, padding, digits-only extraction) — exact matching only

**"Missing"** means no municipality field found at all in the settlement row.

**"Unknown"** means a municipality value exists but does not exactly match any authoritative municipality ID from the borders GeoJSON.

**"Zero settlements"** means an authoritative municipality (present in borders) has no settlements referencing it in the settlement metadata.

**Note:** This audit does NOT generate or modify geometry. Borders remain reference-only. The audit purely reports alignment status to identify data quality issues.

### Municipality borders extraction (drzava.js) and visual check

```bash
npm run map:extract:muni:drzava
```

Extracts **municipality-only** borders from `data/source/drzava.js` and writes GeoJSON, extraction report, failures CSV, and a **deterministic visual check viewer**. The viewer is diagnostic only: no geometry generation, modification, smoothing, or inference.

**Mixed-layer source:** `drzava.js` contains multiple administrative layers (entities, cantons, regions, district, state) in addition to municipalities. All use `.data("munID", …)` and `R.path(…)`. The extractor **explicitly** classifies each feature by name prefix (`Kanton:`, `Entitet:`, `Regija:`, `Distrikt:`, `Država:`) and **exports only municipality-level** polygons. Cantons, entities, and other layers are counted in the report (`admin_layer_breakdown`) and sampled in `sample_non_municipality`; they are **not** exported to GeoJSON or rendered in the viewer.

**Outputs (in `data/derived/`):**
- `municipality_borders_from_drzava.geojson` — municipality features only (stable order, `feature_index`, `munid_5` string, `name`, `source`)
- `municipality_borders_extraction_report.json` — counts, `failed_entities`, `admin_layer_breakdown`, `sample_non_municipality`, bounds, `municipality_failures`, `municipality_failures_by_reason`, `municipality_failed_ids`
- `municipality_borders_extraction_failures.csv` — `munid_5,name,reason,layer` for municipality-classified items that failed geometry parse (layer fixed to `municipality`)
- `municipality_borders_from_drzava_viewer.html` — static HTML viewer; renders only municipality borders; legend includes `admin_layer_breakdown`

**Geometry failure diagnostic (in `data/derived/municipality_audit/`):**
- `municipality_geometry_failures_diagnostic.json` — per-failure diagnostics (munid_5, name, raw_geometry_kind, failure_stage, failure_reason, detail, basic_stats), sorted by munid_5; diagnostics only, no repair or inference
- `municipality_geometry_failures_diagnostic.csv` — same fields in CSV form. Inspect this file to understand why specific municipalities fail geometry conversion (e.g. parse_path, to_rings, polygon_validate).

**How to open the viewer:**

Open `data/derived/municipality_borders_from_drzava_viewer.html` in a browser. It loads `./municipality_borders_from_drzava.geojson` and `./municipality_borders_extraction_report.json` via relative paths. If opened via `file://`, some browsers block fetch; use a local static server from `data/derived/` if needed (e.g. `npx serve data/derived` then open the viewer URL).

**What to check:**
- Presence of expected municipalities (e.g. search by `munid_5` or name); **no** giant entity/canton outlines
- `admin_layer_breakdown` in legend and report (muni / canton / entity / other) — non-municipal layers should be non-zero, confirming they were detected and filtered
- Obvious geometry anomalies (gaps, self-intersections, wrong scale)
- **Failures** panel: lists `failed_entities` from the report (munid_5, name, reason); no geometry is rendered for failed entities

The viewer provides a legend (features, failures, admin layers breakdown), search-by-munid/name with thicker highlight, click-to-inspect (munid_5 + name), and pan/zoom. All outputs are deterministic (no timestamps, stable ordering).

### Municipality border reconstruction from legacy settlement-derived outlines

```bash
npm run map:reconstruct:muni
```

Reconstructs a complete municipality border layer from legacy settlement-derived outlines. This is an approved reconstruction step that creates an authoritative municipality layer when drzava.js geometry is incomplete or unreliable.

**Inputs:**
- `data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.zip` — legacy ZIP containing municipality outlines derived from settlements
- `data/derived/settlements_meta.csv` — settlement metadata (for municipality IDs and names)

**Outputs:**
- `data/derived/municipality_borders_reconstructed.geojson` — reconstructed municipality borders (authoritative layer)
- `data/derived/municipality_reconstruction_report.json` — reconstruction report with statistics

**Each feature includes properties:**
- `munid_5`: string — municipality ID
- `name`: string|null — municipality name
- `source`: "reconstructed_from_settlement_outlines"
- `reconstruction_method`: "settlement_outline_union"
- `legacy_source_file`: "settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5"
- `feature_index`: number — stable feature index

**Allowed operations:**
- Load legacy municipality outlines from ZIP
- Accept geometry as-is if valid Polygon/MultiPolygon
- Union multiple geometries per municipality deterministically
- Merge fragments belonging to the same municipality
- Ring closure and geometry normalization
- **NOT allowed:** simplification, smoothing, snapping to borders or rivers

**ID & name resolution:**
- Municipality identity from legacy outline attributes where present
- If legacy outline lacks `munid_5`: derive via explicit lookup table (authored in-code)
- Log any municipality where ID resolution is ambiguous
- Do NOT invent new municipalities

**Reconstruction report includes:**
- `total_municipalities`: total from metadata
- `reconstructed`: successfully reconstructed count
- `geometry_fixes_applied`: ring closures and fragment unions
- `unresolved_id_count`: municipalities not found in legacy outlines
- `unresolved_ids`: sorted list of unresolved municipality IDs
- `notes`: provenance and reconstruction method notes

**Note:** These borders are reconstructed from settlement outlines and are not surveyed. This layer supersedes drzava-derived municipality geometry.

### Municipality outlines derived from settlement polygon fabric

```bash
npm run map:derive:muni-from-fabric
```

Derives municipality outlines by unioning polygons (poly_id micro-areas) from the settlement polygon fabric. This is a **derived/reconstructed layer** intended for reference/visualization and for ensuring complete municipality coverage. These borders are **not authoritative surveyed boundaries**.

**CRITICAL RULES:**
- Do NOT assume polygon↔settlement 1:1 mapping
- Do NOT invent municipalities
- Municipality identity must come from explicit municipality reference field in polygon fabric (mid if available, otherwise mun_code)
- Determinism is mandatory (stable ordering, no timestamps, no randomness)

**Inputs:**
- `data/derived/polygon_fabric.geojson` (or `polygon_fabric_with_mid.geojson` if available)
- `data/derived/settlements_meta.csv` (for expected municipality set)

**Outputs (in `data/derived/`):**

- `municipality_outlines_from_settlement_fabric.geojson` — FeatureCollection of Polygon/MultiPolygon per municipality
  - Properties: `mun_id`, `name`, `source: "derived_from_settlement_polygon_fabric"`, `method` ("polygon_union" or "polygon_collection_fallback"), `poly_count`, `normalization_level` (0/1/2 or null for fallback), `feature_index`
- `municipality_outlines_derivation_report.json` — derivation statistics and coverage audit
  - `inputs`: polygon fabric path and polygon-to-municipality mapping path
  - `totals`: polygons loaded, polygons with municipality, municipalities expected / with_polygons / emitted / missing
  - `missing_municipalities`: sorted list of expected municipalities with zero polygons
  - `geometry_stats`: union attempts, successes, failures, fallbacks_used, `unions_succeeded_by_level` (counts per level 0/1/2)
  - `normalization_params`: `eps1`, `area_eps`, `clamp` (deterministic normalization parameters)
  - `failures`: list of municipalities where union failed (with reason and detail)
- `municipality_union_status.csv` — per-municipality union status
  - Columns: `mun_id`, `poly_count`, `union_attempted`, `union_result`, `failure_reason`, `failure_detail`, `normalization_level_attempted`, `normalization_level_succeeded`, `union_error_message`
- `municipality_outlines_missing.csv` — missing municipalities (columns: `mun_id`, `name`)
- `muni_from_fabric_viewer.html` — visual inspection tool

**Derivation method:**
- For each municipality, collects all polygons (micro-areas) assigned to that municipality
- Performs **deterministic boolean union** via `polyclip-ts` in stable order (sorted by `poly_id` before union)
- Uses a **normalization ladder** to increase union success rate:
  - **Level 0:** Ring closure + remove duplicate consecutive points
  - **Level 1:** Level 0 + quantize coordinates to grid step EPS1 (deterministic from polygon fabric bbox)
  - **Level 2:** Level 1 + remove nearly-collinear points + drop rings with < 4 distinct points
- Union is attempted at each level (0, 1, 2) until success or all levels exhausted
- Allowed geometry normalization: ring closure, duplicate removal, quantization to fixed grid, removing degenerate/collinear points, dropping invalid tiny rings
- NOT allowed: hulls, smoothing, Douglas-Peucker simplification, snapping to borders/rivers
- If union fails at all levels: fallback to MultiPolygon as collection of original polygons (`method`: `"polygon_collection_fallback"`)

**Normalization parameters:**
- `EPS1`: Computed deterministically from polygon fabric bbox as `max(width, height) * 1e-7`, clamped to `[1e-6, 1e-3]`
- `AREA_EPS`: Derived from EPS1 as `EPS1 * EPS1` (for collinear point removal)
- Parameters are recorded in `normalization_params` in the derivation report

**Coverage audit:**
- Expected municipalities: from `settlements_meta.csv` when using `mid`; otherwise from unique mun_ids in polygon fabric
- `municipalities_missing` = expected − emitted; explicitly lists municipalities with zero polygons (data gap, not rendering bug)

**Viewer features:**
- Renders municipality outlines (default on)
- **Union success:** normal stroke; **fallback collection:** dashed stroke, thicker outline, red tint
- Shows on-click inspector: mun_id, name, poly_count, method, normalization_level
- Pan/zoom support
- Statistics: expected, missing, with polygons, unions succeeded/failed, fallbacks used, unions succeeded by level

**What "derived" means:**
These borders are reconstructed from the polygon fabric, not from authoritative surveyed boundaries. They serve as a reference layer for visualization and coverage validation. The derivation report explicitly tracks union failures and missing municipalities to identify data gaps.

### Validating the Map

```bash
pnpm map:check
# or
npm run map:check
```

This performs structural validation without rendering:
- ✓ ∑ filtering rule applied (no aggregate rows in settlements)
- ✓ settlements_meta integrity: unique sid, every sid has mid
- ✓ polygon_fabric integrity: unique poly_id, valid geometry
- ✓ Municipality outlines integrity: every mid in settlements_meta has outline (if crosswalk exists)
- ✓ Settlement points integrity: every point sid exists in meta

## Key Features

### Deterministic Builds
- Stable sorting by poly_id/sid/mid
- Fixed coordinate precision (3 decimals for LOCAL_PIXELS_V2)
- Canonical JSON key ordering
- No timestamps in outputs

### Aggregate Row Filtering
**CRITICAL RULE:** Any row containing the "∑" symbol in ANY cell is excluded from settlement-level data. Aggregate rows are for validation only and must never become settlements, points, or polygons.

The build script:
- Detects and filters aggregate rows during Excel parsing
- Reports the count of filtered rows in `geometry_report.json`
- Validates that no "∑" symbols appear in final outputs

### Municipality Code Crosswalk

The optional `mun_code_crosswalk.csv` file maps polygon `mun_code` values to canonical `mid` values:

```csv
mun_code,mid
12345,1012345
67890,1016789
```

**Without `data/source/mun_code_crosswalk.csv`:**
- Polygon fabric is still fully generated and visible in the inspector
- All polygons have `mid = null`
- Municipality outlines cannot be derived (empty FeatureCollection)
- National outline fallback is created: `national_outline.geojson` (union of all polygons)
- Inspector shows warning: "No municipality outlines (mun_code_crosswalk.csv missing)"
- Settlement points are placed in deterministic grid (synthetic)
- "Points inside municipality" validation checks are skipped

**With `data/source/mun_code_crosswalk.csv`:**
- Polygons are enriched with `mid` property
- Municipality outlines are derived from polygon fabric (union by mid)
- More accurate territorial representation
- Settlement points can be placed inside municipality outlines
- Full validation checks are enabled

### Settlement Points

Settlement points are generated from Excel metadata:

1. **If Excel has lon/lat coordinates:** Use those (assumed to be in LOCAL_PIXELS_V2, or transform if needed)
2. **If Excel does not have coordinates:**
   - If municipality outline exists: Place point deterministically inside outline using hash(sid) for jitter
   - If no outline: Place in deterministic grid based on mid hash

Synthetic points are marked with `synthetic: true` in properties. These are for **visual inspection only** and must never be used for simulation logic beyond debugging.

### Municipality Outlines

Municipality outlines are **always derived**, never hand-authored:

1. If crosswalk exists and municipality has ≥1 polygon with mid: union of polygons
2. Else if municipality has ≥3 settlement points: deterministic concave hull from points
3. Else: no outline generated (warning logged)

### Geometry Processing
- SVG paths are parsed and converted to GeoJSON polygons
- Polygons are validated and repaired when possible
- Invalid polygons are dropped with reasons recorded
- Coordinate precision: 3 decimals for LOCAL_PIXELS_V2

## Build Parameters

Default parameters (recorded in `geometry_report.json`):
- `coordinate_precision`: 3 decimals (LOCAL_PIXELS_V2)
- `concave_hull_concavity`: 2.0
- `concave_hull_length_threshold`: 0

## Error Handling

- Invalid polygons are dropped (not crashed)
- Drop reasons are recorded in `geometry_report.json`
- Municipalities with no geometry are skipped (no outline generated)
- Build continues even if some polygons fail geometry processing
- Missing crosswalk file is handled gracefully (warnings, diagnostic outlines)

## Before Making Changes

**Always run context check before starting work:**

```bash
npm run context
```

This displays:
- Current project phase and top non-negotiables
- Top next tasks from the project ledger
- Last 5 mistake log entries

**Then read:**
- `docs/PROJECT_LEDGER.md` - Current phase, decisions, allowed/disallowed work, geometry contract
- `docs/ASSISTANT_MISTAKES.log` - Canonical "do not repeat" source

## Mistake Guard Integration

The build script integrates with the mistake guard system:
- Loads past mistakes from `docs/ASSISTANT_MISTAKES.log`
- Asserts no repeat of known mistakes
- Validates aggregate row filtering rule
- Enforces Path A separation (polygons ≠ settlements)

**Project Ledger Integration:**
- All scripts also load and validate against `docs/PROJECT_LEDGER.md`
- Checks current phase alignment
- Warns if context implies disallowed work
- Provides project context summary via `getLedgerSummary()`

## Output Format

All GeoJSON files:
- Use LOCAL_PIXELS_V2 CRS (declared in `crs` property)
- Features sorted by poly_id/sid/mid for determinism
- Coordinates rounded to fixed precision (3 decimals)
- Canonical JSON formatting (sorted keys)

CSV files:
- UTF-8 encoding
- Quoted fields (handles commas and quotes in names)
- LF line endings

## Visual Inspection

A visual inspection tool is available to review the map:

```bash
# After building, open the inspector HTML file directly in your browser:
# data/derived/settlements_inspector.html
```

The inspector displays:
- **Polygon fabric** (always visible, blue for polygons with mid, red dashed for polygons without mid)
- **National outline** (cyan, thick) - shown when crosswalk is missing
- **Municipality outlines** (orange, thick) - shown when crosswalk exists
- **Settlement points** (green for true coords, semi-transparent magenta for synthetic) - hidden by default if >90% synthetic
- **Layer toggles** - control visibility of polygons, points, outlines, and national outline
- **HUD** - shows polygon/point counts and warnings about missing crosswalk
- Interactive features: click to see full properties, hover for tooltip
- Text search by poly_id, sid, or mid
- Statistics panel showing polygon/settlement counts
- Pan and zoom support (mouse wheel zoom, click-drag pan)

The inspector helps verify:
- Polygon fabric coverage (always visible, even without crosswalk)
- Municipality outline accuracy (when crosswalk exists)
- Settlement point placement
- Crosswalk effectiveness (polygons_with_mid vs polygons_without_mid)
- National outline fallback (when crosswalk is missing)

## Troubleshooting

**Build fails with "Aggregate row detected":**
- Check that Excel parsing correctly filters rows with "∑"
- Verify no aggregate rows made it into settlement metadata

**Municipality outlines missing:**
- Check if `mun_code_crosswalk.csv` exists
- If no crosswalk: outlines are derived from settlement points (diagnostic only)
- If crosswalk exists: check `geometry_report.json` for municipalities with zero polygons

**Polygons dropped:**
- Check `geometry_report.json` → `polygon_drop_reasons` for counts
- Review geometry validity issues

**Points outside municipality outlines:**
- Check `geometry_report.json` → `municipality_coverage`
- Review `offenders.mids_failed_coverage` for specific municipality IDs
- This is a warning, not an error (tolerance-based check)

**Viewer shows "Loading..." or no data:**
- Ensure the build has completed successfully (`pnpm build:map`)
- Check browser console for CORS or file loading errors
- Use a local HTTP server instead of opening the file directly (file:// protocol has CORS restrictions)

## Path A vs Previous Approach

**Previous approach (removed):**
- Attempted to match polygons 1:1 to settlements by re-keying polygon IDs to settlement IDs
- Required complex crosswalk matching
- Failed when ID schemes were incompatible

**Path A (current):**
- Polygons are territorial micro-areas (poly_id)
- Settlements are simulation entities (sid)
- Only linked via municipalities (mid)
- Clean separation, no forced matching
