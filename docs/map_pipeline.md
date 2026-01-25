# Map Pipeline

This document describes the raw vs derived data flow for map data in AWWV.

## Raw data (`data/raw/map_kit_v1/`)

**Do not modify files in `data/raw/`.** These are provenance-preserving source files.

### Contents

- `map_data.zip` — Archive containing raw map data (unzipped into `map_data/`)
- `map_data/` — Extracted map data files:
  - `bih_settlements_map_data.js`
  - `bih_settlements_map_data.json`
  - `bih_settlements_municipality_index.json`
- `awwv_map_kit_v1.zip` — Complete map kit archive
- `settlement_polygon_fixes_pack_v1.json` — Polygon fix pack
- `invalid_settlement_polygons_report.csv` — Validation reports
- `invalid_settlement_polygons_summary_by_municipality.csv`
- `invalid_settlement_polygons_summary_by_status.csv`
- HTML visualization files

## Derived data (`data/`)

Processed outputs derived from raw data (can be regenerated from raw sources):

- `settlements.json` — Processed settlement records
- `settlement_attributes.json` — Derived settlement attributes
- `municipalities.json` — Municipality data
- `edges.json` — Settlement adjacency graph

## Pipeline principles

- **Raw data is immutable** — never edit files in `data/raw/`
- **Derived data is reproducible** — should be regeneratable from raw sources
- **Versioning** — use versioned directories for major raw data updates (e.g., `map_kit_v1`, future `map_kit_v2`)
