# Map Build System

This document describes the new deterministic map build system for A War Without Victory.

## Overview

The map system rebuilds the game map from a single authoritative source file: `data/source/master_municipalities.json`. This file contains 142 municipalities with their settlements, census data, and SVG geometry.

## Build Process

### Offline Build Script

Run the build script to generate all derived map data:

```bash
npm run map:build:new
```

This script:
1. Reads `data/source/master_municipalities.json`
2. Converts SVG paths to polygons with deterministic curve subdivision
3. Cleans and validates geometry
4. Generates 5 output files in `data/derived/`:
   - `municipalities_meta.json` - Municipality metadata
   - `settlements_meta.json` - Settlement metadata
   - `settlements_polygons.geojson` - Settlement polygon geometries
   - `municipality_outlines.geojson` - Municipality boundary outlines
   - `map_bounds.json` - Map coordinate bounds

### SVG to Polygon Conversion

The build script handles SVG path commands:
- **M, L, H, V, Z** - Direct line commands
- **C, S, Q, T, A** - Curve commands (converted using fixed 10-segment subdivision)

All curves are converted deterministically using a fixed number of segments, ensuring consistent output across builds.

### Geometry Cleaning

All polygons are cleaned:
- Duplicate consecutive points removed
- Collinear points removed
- Coordinates snapped to 2 decimal places
- Invalid geometries fixed with buffer(0) or simplification
- Zero-area or invalid polygons are dropped (settlement metadata retained with `has_geometry: false`)

### Validation

The build script fails fast on structural errors:
- Duplicate `municipality_id` → exits with error
- Duplicate `settlement_id` → exits with error
- Missing municipality reference → exits with error

Warnings are issued for:
- `svg_path` is null
- Geometry dropped during processing

## Output Files

### municipalities_meta.json

Array of municipality metadata, sorted by `mid`:

```json
{
  "mid": "10014",
  "name": "Banovići",
  "name_ascii": "Banovici",
  "total_population": 53180,
  "total_settlements": 21,
  "urban_center_sid": "10014",
  "totals_by_group": {
    "bosniaks": 38324,
    "croats": 1100,
    "serbs": 9028,
    "others": 4728
  }
}
```

### settlements_meta.json

Flat array of settlement metadata, sorted by `sid`:

```json
{
  "sid": "100013",
  "mid": "10014",
  "name": "Banovići",
  "settlement_type": "geographic",
  "is_urban_center": false,
  "total_population": 8637,
  "bosniaks": 3843,
  "croats": 495,
  "serbs": 2534,
  "others": 1765,
  "has_geometry": true
}
```

### settlements_polygons.geojson

GeoJSON FeatureCollection of settlement polygons:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "sid": "100013",
        "mid": "10014",
        "name": "Banovići"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[x, y], [x, y], ...]]
      }
    }
  ]
}
```

### municipality_outlines.geojson

GeoJSON FeatureCollection of municipality boundary outlines (geometric union of all settlement polygons in each municipality):

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "mid": "10014",
        "name": "Banovići"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[x, y], [x, y], ...]]
      }
    }
  ]
}
```

### map_bounds.json

Map coordinate bounds:

```json
{
  "min_x": 0.0,
  "min_y": 0.0,
  "max_x": 1000.0,
  "max_y": 1000.0,
  "width": 1000.0,
  "height": 1000.0
}
```

## Godot Integration

### Scripts

Three Godot scripts provide map loading and rendering:

1. **MapData.gd** (`res://scripts/map/MapData.gd`)
   - Loads `municipalities_meta.json`, `settlements_meta.json`, `map_bounds.json`
   - Provides lookup methods by ID

2. **SettlementPolygons.gd** (`res://scripts/map/SettlementPolygons.gd`)
   - Loads `settlements_polygons.geojson`
   - Builds `sid -> PackedVector2Array` mapping
   - Builds `mid -> Array[sid]]` mapping

3. **MapLayer.gd** (`res://scripts/map/MapLayer.gd`)
   - Renders settlement polygons
   - Handles hover highlight and click selection
   - Uses `Geometry2D.triangulate_polygon` for rendering
   - Calculates coordinate transform from `map_bounds.json`

### Test Scene

A minimal test scene is provided at `res://scenes/MapTestScene.gd`:

1. Create a new scene in Godot
2. Add a `Node2D` as root
3. Attach `MapTestScene.gd` script
4. Add a child `Node2D` named `MapLayer`
5. Attach `MapLayer.gd` script to the `MapLayer` node
6. Run the scene

The test scene will:
- Load all map data
- Render settlement polygons
- Log selections to console
- Support hover and click interactions

### Coordinate Transform

The map uses a deterministic coordinate transform:

```gdscript
# Scale to fit viewport with 5% margin
scale = min(viewport_w / width, viewport_h / height) * 0.95

# Origin centered
origin = (viewport_size - scaled_map_size) / 2.0 - min_coords * scale
```

This ensures the map is always centered and scaled to fit the viewport.

## Design Principles

1. **Deterministic** - Same input always produces same output
2. **Fail Fast** - Structural errors cause immediate exit
3. **No Auto-Fix** - Invalid data is dropped, not guessed
4. **Offline Build** - All processing happens at build time
5. **Runtime Load** - Godot only loads pre-processed JSON/GeoJSON

## File Structure

```
data/
  source/
    master_municipalities.json  # Authoritative source
  derived/
    municipalities_meta.json
    settlements_meta.json
    settlements_polygons.geojson
    municipality_outlines.geojson
    map_bounds.json

res/
  scripts/
    map/
      MapData.gd
      SettlementPolygons.gd
      MapLayer.gd
  scenes/
    MapTestScene.gd
```

## Notes

- The source file contains 142 municipalities (do not question this count)
- Some settlements may have `svg_path: null` (urban centers, unmapped settlements)
- Invalid geometries are dropped, but settlement metadata is retained
- Triangulation failures are logged but do not crash the renderer
