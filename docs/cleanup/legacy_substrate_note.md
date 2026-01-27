# Legacy Master-Derived Substrate

## What Was Moved

The following files were moved from canonical paths to `data/derived/_legacy_master_substrate/` on 2026-01-27:

- `settlements_substrate.geojson` (master-derived Phase 0 canonical substrate)
- `settlements_substrate.audit.json`
- `settlements_substrate.audit.txt`
- `substrate_viewer/` (entire folder with Phase 0 canonical viewer)

## Why

Canon decision: SVG-derived settlements substrate is now the canonical settlement substrate.

The master-derived substrate (from `bih_master.geojson`) was the Phase 0 canonical substrate. It has been superseded by the SVG-derived substrate (from `data/source/settlements/**` JS files + `bih_census_1991.json`), which provides:

- Higher coverage (6,137 features vs 6,135)
- Better geometry quality (deterministic ring closure, duplicate SID merge)
- Census-based identity matching
- SVG coordinate regime (now accepted as canonical)

## Status

**Legacy artifacts are preserved but not used by simulation going forward.**

The canonical commands (`npm run map:derive:substrate`, `npm run map:viewer:substrate:index`) now produce SVG-derived substrate artifacts.

The master-derived script (`scripts/map/derive_settlement_substrate_from_master.ts`) remains in the codebase but is no longer referenced by canonical commands.

## Accessing Legacy

To view the legacy master-derived substrate:

1. Navigate to `data/derived/_legacy_master_substrate/`
2. Open `substrate_viewer/index.html` in a web browser (via local web server)

## Notes

- Legacy files are preserved for reference and comparison
- No simulation logic should reference legacy paths
- If needed for historical analysis, legacy artifacts can be compared with new canonical substrate
