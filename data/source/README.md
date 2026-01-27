# A War Without Victory - Geographic & Census Data Package

## Overview

This package contains the extracted geographic boundaries and 1991 census data for Bosnia and Herzegovina, prepared for use in the AWWV game engine.

## Files Included

### GeoJSON Files

| File | Size | Description |
|------|------|-------------|
| `bih_master.geojson` | ~48 MB | Complete dataset with all layers (country, municipalities, settlements) |
| `bih_municipalities.geojson` | ~250 KB | Municipality boundaries only |
| `bih_settlements.geojson` | ~15 MB | Settlement boundaries only |

### Data Files

| File | Size | Description |
|------|------|-------------|
| `bih_census_1991.json` | ~420 KB | Compact census data for game logic (no geometry) |

### TypeScript Types

| File | Description |
|------|-------------|
| `settlement.ts` | Core type definitions for settlements, populations, and game state |
| `census-loader.ts` | Utilities for loading and querying census data |

### Visualization

| File | Description |
|------|-------------|
| `map_preview.html` | Interactive HTML preview of the map (requires serving via HTTP) |

## Data Statistics

- **Total Population (1991):** 4,377,033
- **Municipalities:** 142
- **Settlements with Geometry:** 6,135
- **Settlements with Census Data:** 6,140

## Census Data Structure

### Compact JSON Format (`bih_census_1991.json`)

```json
{
  "settlements": {
    "100013": {
      "n": "Banovići",           // name
      "m": "10014",              // municipality ID
      "p": [8637, 3843, 495, 2534, 1765]  // [total, bosniaks, croats, serbs, others]
    }
  },
  "municipalities": {
    "10014": {
      "n": "Banovići",           // name
      "s": ["100013", "100021", ...],  // settlement IDs
      "p": [26590, 19162, 550, 4514, 2364]  // aggregated population
    }
  }
}
```

### GeoJSON Properties

Each settlement feature includes:

```json
{
  "type": "Feature",
  "id": "sett_100013",
  "properties": {
    "id": "100013",
    "name": "Banovići",
    "layer": "settlement",
    "municipality_id": "10014",
    "municipality_name": "Banovići",
    "population_1991": {
      "total": 8637,
      "bosniaks": 3843,
      "croats": 495,
      "serbs": 2534,
      "others": 1765
    }
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[x1, y1], [x2, y2], ...]]
  }
}
```

## Coordinate System

**Important:** The coordinates are in SVG canvas space, NOT geographic lat/lon.

- Origin: Top-left corner
- Y-axis: Inverted (positive values go down)
- Approximate bounds: x ∈ [0, 800], y ∈ [100, 850]

To convert to geographic coordinates, you would need to apply an affine transformation based on known reference points.

## Usage in Game Engine

### Loading Census Data (TypeScript)

```typescript
import { loadCensusData, initializeRegistry, getCensusStatistics } from './census-loader';

// Async loading
const census = await loadCensusData('/data/bih_census_1991.json');
const registry = initializeRegistry(census);

// Get statistics
const stats = getCensusStatistics(registry);
console.log(`Total population: ${stats.totalPopulation.toLocaleString()}`);
```

### Tracking Population Changes

```typescript
import { SettlementState, calculateCurrentPopulation } from './settlement';

// When casualties occur
state.populationDelta.casualties.bosniaks += 50;
state.populationDelta.casualties.serbs += 30;

// Recalculate current population
state.currentPopulation = calculateCurrentPopulation(
  registry.census.get(settlementId)!.population,
  state.populationDelta
);
```

### Querying by Municipality

```typescript
import { getMunicipalityPopulation } from './census-loader';

const munPop = getMunicipalityPopulation(registry, '10014');
console.log(`Banovići municipality: ${munPop.total.toLocaleString()} people`);
```

## Data Integrity Notes

1. **Census Total Verified:** The sum of all settlement populations exactly matches the known 1991 census total of 4,377,033.

2. **Summary Rows Excluded:** All rows marked with `∑` in the source data were properly excluded to prevent double-counting.

3. **Post-1995 Borders:** The census data has been applied to post-1995 (Dayton Agreement) administrative boundaries, which differ slightly from the original 1991 borders.

4. **Missing Geometry:** 5 settlements have census data but no corresponding SVG geometry in the source files.

## Visualization

To preview the map:

1. Start a local HTTP server:
   ```bash
   python3 -m http.server 8000
   ```

2. Open `http://localhost:8000/map_preview.html` in a browser

The preview supports:
- Color by ethnic majority/plurality or population
- Toggle between settlement and municipality views
- Pan and zoom (mouse wheel or buttons)
- Hover tooltips with full demographic breakdown

## Future Enhancements

1. **Geographic Projection:** Add affine transformation to convert SVG coords to EPSG:4326 (lat/lon)

2. **Adjacency Graph:** Compute settlement adjacency for pathfinding and corridor calculations

3. **Connectivity Data:** Add road network and supply route information

4. **Historical Boundaries:** Include pre-1991 and wartime boundary changes

## Source Data Attribution

- Settlement boundaries: Extracted from municipality SVG files
- Municipality boundaries: Extracted from `drzava.js`
- Census data: 1991 Yugoslav census, applied to post-1995 borders
