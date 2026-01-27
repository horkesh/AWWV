# Repo Cleanup Audit Report

## Summary

- **Total files scanned:** 581
- **Used files:** 120
- **Orphan candidates:** 232
- **Exempt files:** 229

## Orphan Candidates

Files that appear to have no inbound references (imports, requires, package.json scripts, or documentation mentions).

### By Directory

#### `.` (2 files)

- `IDENTITY_MIGRATION_SUMMARY.md`
  - no inbound reference found
- `PHASE_21_SUMMARY.md`
  - no inbound reference found

#### `data` (4 files)

- `data/edges.json`
  - no inbound reference found
- `data/municipalities.json`
  - no inbound reference found
- `data/settlement_attributes.json`
  - no inbound reference found
- `data/settlements.json`
  - no inbound reference found

#### `data/derived` (71 files)

- `data/derived/adjacency_calibration.json`
  - no inbound reference found
- `data/derived/adjacency_report.json`
  - no inbound reference found
- `data/derived/build_fingerprint.txt`
  - no inbound reference found
- `data/derived/excel_meta_stats.json`
  - no inbound reference found
- `data/derived/fallback_geometries.json`
  - no inbound reference found
- `data/derived/fix_edges_canonicalize_sids.report.json`
  - no inbound reference found
- `data/derived/front_edges.json`
  - no inbound reference found
- `data/derived/geometry_coverage_by_municipality.json`
  - no inbound reference found
- `data/derived/geometry_report.json`
  - no inbound reference found
- `data/derived/hull_inflation_report.json`
  - no inbound reference found
- `data/derived/hull_inflation_report.txt`
  - no inbound reference found
- `data/derived/index.html`
  - no inbound reference found
- `data/derived/join_stats.json`
  - no inbound reference found
- `data/derived/map_bounds.json`
  - no inbound reference found
- `data/derived/map_build_report.json`
  - no inbound reference found
- `data/derived/map_raw_audit_report.json`
  - no inbound reference found
- `data/derived/mapkit_regime_diagnosis.json`
  - no inbound reference found
- `data/derived/mapkit_regime_normalization.report.md`
  - no inbound reference found
- `data/derived/mapkit_regime_normalization.summary.json`
  - no inbound reference found
- `data/derived/missing_edge_sids.summary.json`
  - no inbound reference found
- `data/derived/muni_from_fabric_viewer.html`
  - no inbound reference found
- `data/derived/municipalities_meta.json`
  - no inbound reference found
- `data/derived/municipality_borders_extraction_failures.csv`
  - no inbound reference found
- `data/derived/municipality_borders_extraction_report.json`
  - no inbound reference found
- `data/derived/municipality_borders_from_drzava_viewer.html`
  - no inbound reference found
- `data/derived/municipality_borders_from_drzava.geojson`
  - no inbound reference found
- `data/derived/municipality_borders_reconstructed_viewer.html`
  - no inbound reference found
- `data/derived/municipality_borders_reconstructed.geojson`
  - no inbound reference found
- `data/derived/municipality_borders_report.json`
  - no inbound reference found
- `data/derived/municipality_borders_viewer.html`
  - no inbound reference found
- `data/derived/municipality_borders.geojson`
  - no inbound reference found
- `data/derived/municipality_boundaries_derivation_report.json`
  - no inbound reference found
- `data/derived/municipality_boundaries_unstitchable.csv`
  - no inbound reference found
- `data/derived/municipality_boundaries_viewer.html`
  - no inbound reference found
- `data/derived/municipality_coverage_report.json`
  - no inbound reference found
- `data/derived/municipality_missing_borders.csv`
  - no inbound reference found
- `data/derived/municipality_missing_borders.json`
  - no inbound reference found
- `data/derived/municipality_outline_rekeyed.geojson`
  - no inbound reference found
- `data/derived/municipality_outlines_derivation_report.json`
  - no inbound reference found
- `data/derived/municipality_outlines_from_settlement_fabric.geojson`
  - no inbound reference found
- `data/derived/municipality_outlines_missing.csv`
  - no inbound reference found
- `data/derived/municipality_outlines.geojson`
  - no inbound reference found
- `data/derived/municipality_reconstruction_report.json`
  - no inbound reference found
- `data/derived/municipality_union_status.csv`
  - no inbound reference found
- `data/derived/orphan_whitelist.json`
  - no inbound reference found
- `data/derived/orphans.json`
  - no inbound reference found
- `data/derived/polygon_fabric_with_mid.geojson`
  - no inbound reference found
- `data/derived/polygon_fabric.geojson`
  - no inbound reference found
- `data/derived/polygon_fabric.json`
  - no inbound reference found
- `data/derived/polygon_failures.json`
  - no inbound reference found
- `data/derived/settlement_edges.json`
  - no inbound reference found
- `data/derived/settlement_orphans.json`
  - no inbound reference found
- `data/derived/settlement_orphans.report.md`
  - no inbound reference found
- `data/derived/settlement_points_from_excel.geojson`
  - no inbound reference found
- `data/derived/settlement_points_rekeyed.geojson`
  - no inbound reference found
- `data/derived/settlement_points.geojson`
  - no inbound reference found
- `data/derived/settlement_polygons_rekeyed.geojson`
  - no inbound reference found
- `data/derived/settlement_polygons.geojson`
  - no inbound reference found
- `data/derived/settlement_polygons.zip`
  - no inbound reference found
- `data/derived/settlement_svgpaths.json`
  - no inbound reference found
- `data/derived/settlements_index.json`
  - no inbound reference found
- `data/derived/settlements_inspector.html`
  - no inbound reference found
- `data/derived/settlements_meta.csv`
  - no inbound reference found
- `data/derived/settlements_meta.json`
  - no inbound reference found
- `data/derived/settlements_outside_municipality.report.md`
  - no inbound reference found
- `data/derived/settlements_outside_municipality.summary.json`
  - no inbound reference found
- `data/derived/sid_crosswalk_unresolved.csv`
  - no inbound reference found
- `data/derived/sid_crosswalk.csv`
  - no inbound reference found
- `data/derived/svg_geometry_failures_by_municipality.json`
  - no inbound reference found
- `data/derived/svg_geometry_failures_by_municipality.txt`
  - no inbound reference found
- `data/derived/visualize_awwv_municipalities.html`
  - no inbound reference found

#### `data/derived/municipality_audit` (6 files)

- `data/derived/municipality_audit/border_id_diagnostic.csv`
  - no inbound reference found
- `data/derived/municipality_audit/municipalities_zero_settlements.csv`
  - no inbound reference found
- `data/derived/municipality_audit/municipality_geometry_failures_diagnostic.csv`
  - no inbound reference found
- `data/derived/municipality_audit/municipality_geometry_failures_diagnostic.json`
  - no inbound reference found
- `data/derived/municipality_audit/settlements_missing_muni_ref.csv`
  - no inbound reference found
- `data/derived/municipality_audit/settlements_unknown_muni_ref.csv`
  - no inbound reference found

#### `data/diagnostics` (1 file)

- `data/diagnostics/suspects.csv`
  - no inbound reference found

#### `data/refs` (1 file)

- `data/refs/municipality_id_crosswalk.csv`
  - no inbound reference found

#### `data/source_v2` (1 file)

- `data/source_v2/master_municipalities.json`
  - no inbound reference found

#### `dev_ui` (4 files)

- `dev_ui/index.html`
  - no inbound reference found
- `dev_ui/main.ts`
  - no inbound reference found
- `dev_ui/ui0_map.html`
  - no inbound reference found
- `dev_ui/ui0_map.ts`
  - no inbound reference found

#### `res/scenes` (1 file)

- `res/scenes/MapTestScene.gd`
  - no inbound reference found

#### `res/scripts/map` (3 files)

- `res/scripts/map/MapData.gd`
  - no inbound reference found
- `res/scripts/map/MapLayer.gd`
  - no inbound reference found
- `res/scripts/map/SettlementPolygons.gd`
  - no inbound reference found

#### `scripts/map` (1 file)

- `scripts/map/normalize_settlement_regimes.ts`
  - no inbound reference found

#### `src/data` (1 file)

- `src/data/geography.ts`
  - no inbound reference found

#### `src/map` (6 files)

- `src/map/adjacency_map.ts`
  - no inbound reference found
- `src/map/filter_active_settlements.ts`
  - no inbound reference found
- `src/map/front_edges.ts`
  - no inbound reference found
- `src/map/front_regions.ts`
  - no inbound reference found
- `src/map/municipalities.ts`
  - no inbound reference found
- `src/map/settlements.ts`
  - no inbound reference found

#### `src/sim` (1 file)

- `src/sim/turn_pipeline.ts`
  - no inbound reference found

#### `src/state` (33 files)

- `src/state/acceptance_constraints.ts`
  - no inbound reference found
- `src/state/brcko.ts`
  - no inbound reference found
- `src/state/competence_valuations.ts`
  - no inbound reference found
- `src/state/competences.ts`
  - no inbound reference found
- `src/state/control_effective.ts`
  - no inbound reference found
- `src/state/control_flip_proposals.ts`
  - no inbound reference found
- `src/state/displacement.ts`
  - no inbound reference found
- `src/state/end_state_snapshot.ts`
  - no inbound reference found
- `src/state/exhaustion.ts`
  - no inbound reference found
- `src/state/formation_fatigue.ts`
  - no inbound reference found
- `src/state/front_breaches.ts`
  - no inbound reference found
- `src/state/front_posture_commitment.ts`
  - no inbound reference found
- `src/state/front_posture_regions.ts`
  - no inbound reference found
- `src/state/front_posture.ts`
  - no inbound reference found
- `src/state/front_pressure.ts`
  - no inbound reference found
- `src/state/front_segments.ts`
  - no inbound reference found
- `src/state/game_state.ts`
  - no inbound reference found
- `src/state/identity.ts`
  - no inbound reference found
- `src/state/militia_fatigue.ts`
  - no inbound reference found
- `src/state/negotiation_capital.ts`
  - no inbound reference found
- `src/state/negotiation_offers.ts`
  - no inbound reference found
- `src/state/negotiation_pressure.ts`
  - no inbound reference found
- `src/state/schema.ts`
  - no inbound reference found
- `src/state/serialize.ts`
  - no inbound reference found
- `src/state/supply_reachability.ts`
  - no inbound reference found
- `src/state/sustainability.ts`
  - no inbound reference found
- `src/state/territorial_valuation.ts`
  - no inbound reference found
- `src/state/treaty_acceptance.ts`
  - no inbound reference found
- `src/state/treaty_apply.ts`
  - no inbound reference found
- `src/state/treaty_builder.ts`
  - no inbound reference found
- `src/state/treaty_clause_library.ts`
  - no inbound reference found
- `src/state/treaty_package_warnings.ts`
  - no inbound reference found
- `src/state/treaty.ts`
  - no inbound reference found

#### `src/turn` (2 files)

- `src/turn/pipeline.ts`
  - no inbound reference found
- `src/turn/steps.ts`
  - no inbound reference found

#### `src/validate` (15 files)

- `src/validate/aor_contiguity.ts`
  - no inbound reference found
- `src/validate/ceasefire.ts`
  - no inbound reference found
- `src/validate/competence_valuations.ts`
  - no inbound reference found
- `src/validate/control_overrides.ts`
  - no inbound reference found
- `src/validate/end_state.ts`
  - no inbound reference found
- `src/validate/factions.ts`
  - no inbound reference found
- `src/validate/formations.ts`
  - no inbound reference found
- `src/validate/front_posture_regions.ts`
  - no inbound reference found
- `src/validate/front_posture.ts`
  - no inbound reference found
- `src/validate/front_pressure.ts`
  - no inbound reference found
- `src/validate/front_segments.ts`
  - no inbound reference found
- `src/validate/militia_pools.ts`
  - no inbound reference found
- `src/validate/supply_rights.ts`
  - no inbound reference found
- `src/validate/supply_sources.ts`
  - no inbound reference found
- `src/validate/validate.ts`
  - no inbound reference found

#### `tests` (45 files)

- `tests/acceptance_brcko_completeness.test.ts`
  - no inbound reference found
- `tests/acceptance_constraints.test.ts`
  - no inbound reference found
- `tests/artifact_determinism.test.ts`
  - no inbound reference found
- `tests/calibration.test.ts`
  - no inbound reference found
- `tests/competence_valuations.test.ts`
  - no inbound reference found
- `tests/competences.test.ts`
  - no inbound reference found
- `tests/control_flip_proposals.test.ts`
  - no inbound reference found
- `tests/dev_ui_exports_deterministic.test.ts`
  - no inbound reference found
- `tests/dev_ui_phase16.test.ts`
  - no inbound reference found
- `tests/dev_ui_phase17.test.ts`
  - no inbound reference found
- `tests/dev_ui_phase18.test.ts`
  - no inbound reference found
- `tests/displacement.test.ts`
  - no inbound reference found
- `tests/end_state.test.ts`
  - no inbound reference found
- `tests/exhaustion_accumulate.test.ts`
  - no inbound reference found
- `tests/formations_deterministic.test.ts`
  - no inbound reference found
- `tests/formations_validate.test.ts`
  - no inbound reference found
- `tests/freeze_regression.test.ts`
  - no inbound reference found
- `tests/front_breaches.test.ts`
  - no inbound reference found
- `tests/front_posture_commitment.test.ts`
  - no inbound reference found
- `tests/front_posture_normalize.test.ts`
  - no inbound reference found
- `tests/front_posture_regions_expand.test.ts`
  - no inbound reference found
- `tests/front_pressure_accumulate.test.ts`
  - no inbound reference found
- `tests/front_pressure_supply_modulation.test.ts`
  - no inbound reference found
- `tests/front_regions.test.ts`
  - no inbound reference found
- `tests/front_segments_validate.test.ts`
  - no inbound reference found
- `tests/front_segments.test.ts`
  - no inbound reference found
- `tests/generate_formations.test.ts`
  - no inbound reference found
- `tests/identity_migration.test.ts`
  - no inbound reference found
- `tests/militia_pools.test.ts`
  - no inbound reference found
- `tests/negotiation_capital.test.ts`
  - no inbound reference found
- `tests/negotiation_offers.test.ts`
  - no inbound reference found
- `tests/negotiation_pressure.test.ts`
  - no inbound reference found
- `tests/phase10_ops_fatigue.test.ts`
  - no inbound reference found
- `tests/phase5_check.test.ts`
  - no inbound reference found
- `tests/sim_formations_report.test.ts`
  - no inbound reference found
- `tests/sim_scenario.test.ts`
  - no inbound reference found
- `tests/state.test.ts`
  - no inbound reference found
- `tests/supply_reachability.test.ts`
  - no inbound reference found
- `tests/sustainability.test.ts`
  - no inbound reference found
- `tests/territorial_valuation.test.ts`
  - no inbound reference found
- `tests/treaty_apply_military.test.ts`
  - no inbound reference found
- `tests/treaty_apply_territorial.test.ts`
  - no inbound reference found
- `tests/treaty_brcko.test.ts`
  - no inbound reference found
- `tests/treaty.test.ts`
  - no inbound reference found
- `tests/turn_pipeline.test.ts`
  - no inbound reference found

#### `tools` (2 files)

- `tools/map_viewer.html`
  - no inbound reference found
- `tools/README.md`
  - no inbound reference found

#### `tools/map` (15 files)

- `tools/map/build_crosswalk.ts`
  - no inbound reference found
- `tools/map/build_inspector_html.ts`
  - no inbound reference found
- `tools/map/build_municipality_borders_viewer_html.ts`
  - no inbound reference found
- `tools/map/derive_municipality_outlines.ts`
  - no inbound reference found
- `tools/map/extract_html_features.ts`
  - no inbound reference found
- `tools/map/generate_geometry_report.ts`
  - no inbound reference found
- `tools/map/mun_code_crosswalk.ts`
  - no inbound reference found
- `tools/map/mun_code_summary.ts`
  - no inbound reference found
- `tools/map/read_excel_meta.ts`
  - no inbound reference found
- `tools/map/rekey_geometry.ts`
  - no inbound reference found
- `tools/map/report_svg_geometry_failures.ts`
  - no inbound reference found
- `tools/map/serve_viewer.js`
  - no inbound reference found
- `tools/map/settlement_points.ts`
  - no inbound reference found
- `tools/map/svgpath_to_geojson.ts`
  - no inbound reference found
- `tools/map/test_svg_structure.js`
  - no inbound reference found

#### `tools/map_build` (2 files)

- `tools/map_build/adjacency.py`
  - no inbound reference found
- `tools/map_build/requirements.txt`
  - no inbound reference found

#### `tools/map_viewer` (4 files)

- `tools/map_viewer/index.html`
  - no inbound reference found
- `tools/map_viewer/README.md`
  - no inbound reference found
- `tools/map_viewer/style.css`
  - no inbound reference found
- `tools/map_viewer/viewer.js`
  - no inbound reference found

#### `tools/map_viewer/data/derived` (5 files)

- `tools/map_viewer/data/derived/map_bounds.json`
  - no inbound reference found
- `tools/map_viewer/data/derived/municipalities_meta.json`
  - no inbound reference found
- `tools/map_viewer/data/derived/municipality_outlines.geojson`
  - no inbound reference found
- `tools/map_viewer/data/derived/settlements_meta.json`
  - no inbound reference found
- `tools/map_viewer/data/derived/settlements_polygons.geojson`
  - no inbound reference found

#### `tools/map_viewer_simple` (4 files)

- `tools/map_viewer_simple/index.html`
  - no inbound reference found
- `tools/map_viewer_simple/README.md`
  - no inbound reference found
- `tools/map_viewer_simple/style.css`
  - no inbound reference found
- `tools/map_viewer_simple/viewer.js`
  - no inbound reference found

#### `tools/map_viewer_simple/data/derived` (2 files)

- `tools/map_viewer_simple/data/derived/map_bounds.json`
  - no inbound reference found
- `tools/map_viewer_simple/data/derived/settlements_polygons.geojson`
  - no inbound reference found


## Notes

- This audit is **deterministic** (stable output on repeated runs)
- Files are classified as:
  - **USED**: Found in referenced files set (imports, requires, scripts, docs)
  - **ORPHAN_CANDIDATE**: No inbound reference found
  - **EXEMPT**: Explicitly excluded from orphan detection (config files, docs, source data, canonical Phase 0 artifacts)
- This audit does **not** delete or move any files
- Review orphan candidates manually before deletion
- Some files may be referenced in ways not detected by this audit (e.g., dynamic imports, string concatenation, external tools)
