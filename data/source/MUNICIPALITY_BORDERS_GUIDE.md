# Municipality Border Generation Guide

This guide will help you create municipality borders that match your settlement data for the AWWV project.

## Quick Start

You have two approaches:

### Approach 1: Generate from Your Settlement Data ✨ (Recommended)

Generate municipality borders directly from your 6,141 settlement points.

**Advantages:**
- Guaranteed to match your settlement data
- No need to find external data sources
- Borders automatically align with settlement clusters

**Steps:**

1. **Install dependencies:**
```bash
pip install shapely
```

2. **Run the simple generator:**
```bash
python simple_municipality_borders.py settlements.geojson municipality_borders.geojson
```

3. **Visualize the results:**
   - Open `visualize_municipality_borders.html` in a browser
   - Load your settlement file
   - Load the generated municipality borders file
   - Check if borders look correct

### Approach 2: Use Official 1991 Administrative Boundaries

Search for and download official Bosnia & Herzegovina 1991 municipality boundaries.

**Sources to try:**

1. **Andreas Beger's 1991 Boundaries** (original source, may be offline)
   - Originally at: https://www.andybeger.com/2011/01/18/bosnia-1991-municipalities/
   - Contains shapefiles for the exact 109 municipalities from 1991 census

2. **HDX (Humanitarian Data Exchange)**
   - URL: https://data.humdata.org/dataset/geoboundaries-admin-boundaries-for-bosnia-and-herzegovina
   - Provides ADM2 and ADM3 level boundaries (may need verification for 1991)

3. **Contact researchers who have worked with this data:**
   - Look for academic papers on the Bosnian War that use spatial data
   - Many researchers have recreated these boundaries

## Detailed Instructions

### Option 1: Simple Municipality Borders (Convex Hull)

This creates straightforward boundaries using convex hulls with buffering.

**What it does:**
- Groups settlements by municipality
- Creates a convex hull around each settlement cluster
- Adds a small buffer to make borders more natural

**Command:**
```bash
python simple_municipality_borders.py settlements.geojson output.geojson [buffer]
```

**Buffer parameter:**
- `0.00` = No buffer (tight boundaries)
- `0.01` = ~1.1 km buffer
- `0.015` = ~1.6 km buffer (default, recommended)
- `0.02` = ~2.2 km buffer

**Example:**
```bash
python simple_municipality_borders.py data/settlements_1991.geojson data/municipalities_1991.geojson 0.015
```

### Option 2: Advanced Municipality Borders (Concave Hull)

This creates more natural, concave boundaries using alpha shapes.

**What it does:**
- Creates boundaries that follow the actual shape of settlement clusters
- Better for municipalities with irregular shapes
- More realistic than convex hulls

**Requirements:**
```bash
pip install shapely alphashape numpy scipy
```

**Command:**
```bash
python generate_municipality_borders.py settlements.geojson output.geojson [alpha]
```

**Alpha parameter:**
- `0.0` = Convex hull (simplest)
- `0.05` = Moderately concave (recommended start)
- `0.1` = More concave
- `0.2` = Very concave (may create holes/gaps)

**Example:**
```bash
python generate_municipality_borders.py data/settlements_1991.geojson data/municipalities_1991.geojson 0.05
```

## Visualizing Results

1. **Open the visualization tool:**
   ```bash
   # Start a local server (to avoid CORS issues)
   python -m http.server 8000
   
   # Then open in browser:
   # http://localhost:8000/visualize_municipality_borders.html
   ```

2. **Load your files:**
   - Click "Settlement Points" and select your `settlements.geojson`
   - Click "Municipality Borders" and select your generated `municipality_borders.geojson`

3. **Check the visualization:**
   - Toggle layers on/off with checkboxes
   - Verify that borders encompass all settlements
   - Check for gaps or overlaps

## Expected Your Settlement Data Structure

Your settlements GeoJSON should have this structure:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [18.4131, 43.8564]
      },
      "properties": {
        "name": "Sarajevo",
        "municipality": "Sarajevo",
        "population": 429672,
        "bosniaks": 259532,
        "serbs": 94023,
        "croats": 37618,
        "others": 38499
      }
    }
  ]
}
```

**Important:** The scripts look for these municipality field names:
- `municipality`
- `municipalityName`
- `muni_name`
- `MUNICIPALITY`

If your field name is different, edit the script's `load_settlements()` function.

## Output Municipality Borders Structure

The generated municipality borders will have this structure:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [18.2, 43.7],
          [18.3, 43.7],
          [18.3, 43.8],
          [18.2, 43.8],
          [18.2, 43.7]
        ]]
      },
      "properties": {
        "name": "Sarajevo",
        "municipality": "Sarajevo",
        "area_sq_km": 1234.56,
        "perimeter_km": 150.2
      }
    }
  ]
}
```

## Matching Settlements to Municipality Borders

Once you have municipality borders, you can verify that settlements are correctly assigned:

```python
import json
from shapely.geometry import Point, shape

# Load both files
with open('settlements.geojson') as f:
    settlements = json.load(f)

with open('municipality_borders.geojson') as f:
    borders = json.load(f)

# Create a lookup of municipality polygons
muni_polygons = {}
for feature in borders['features']:
    muni_name = feature['properties']['municipality']
    muni_polygons[muni_name] = shape(feature['geometry'])

# Check each settlement
mismatches = []
for settlement in settlements['features']:
    settlement_name = settlement['properties']['name']
    claimed_muni = settlement['properties']['municipality']
    point = Point(settlement['geometry']['coordinates'])
    
    # Check if point is actually inside claimed municipality
    if claimed_muni in muni_polygons:
        if not muni_polygons[claimed_muni].contains(point):
            mismatches.append(settlement_name)
            print(f"⚠ {settlement_name} is NOT inside {claimed_muni}")

print(f"\nTotal mismatches: {len(mismatches)}")
```

## Common Issues and Solutions

### Issue 1: Municipality has too few settlements

**Symptom:** Script skips municipalities with < 3 settlements

**Solution:** 
- Check if your data is missing settlements for that municipality
- Manually create a boundary for that municipality
- Use a smaller buffer/alpha value

### Issue 2: Borders overlap

**Symptom:** Municipality borders overlap each other

**Solution:**
- Use smaller buffer value
- Consider using Voronoi diagrams for non-overlapping borders
- Manually adjust borders in QGIS

### Issue 3: Settlement is outside its municipality border

**Symptom:** Settlement point is not contained in its municipality polygon

**Reasons:**
- Buffer was too small
- Settlement is on the edge of the municipality
- Data error (settlement assigned to wrong municipality)

**Solution:**
- Increase buffer value
- Verify settlement-municipality assignment in your source data

### Issue 4: Generated borders don't match historical maps

**Symptom:** Borders don't align with actual 1991 administrative boundaries

**Solution:**
- Generated borders are approximations based on settlement locations
- For historical accuracy, try to find official 1991 boundary shapefiles
- Use the Andreas Beger dataset if available

## Recommended Workflow

1. **Generate borders from settlements:**
   ```bash
   python simple_municipality_borders.py settlements.geojson municipalities.geojson 0.015
   ```

2. **Visualize and verify:**
   - Open visualization tool
   - Check that all settlements are inside their municipality borders
   - Look for obvious errors

3. **Adjust if needed:**
   - If borders are too tight: increase buffer
   - If borders overlap: decrease buffer
   - If borders are too square: use alpha shapes instead

4. **Validate:**
   - Run spatial intersection check
   - Verify total area is reasonable
   - Check that you have 109 municipalities

5. **Use in your project:**
   - Import into AWWV project
   - Use for visualization
   - Use for spatial queries (which settlements are in which municipality)

## Performance Considerations

**For 6,141 settlements:**
- Simple convex hull: ~5-10 seconds
- Alpha shapes: ~30-60 seconds
- Visualization: May be slow in browser, consider sampling

**Optimization tips:**
- For visualization only: Simplify polygons using `simplify(tolerance=0.01)`
- For large datasets: Process municipalities in parallel
- For web display: Use TopoJSON instead of GeoJSON (smaller files)

## Integration with AWWV

Once you have municipality borders, integrate them into your project:

1. **Add to data directory:**
   ```
   AWWV/
   └── data/
       ├── settlements_1991.geojson
       └── municipalities_1991.geojson  ← Add this
   ```

2. **Load in your code:**
   ```typescript
   // In your TypeScript code
   import municipalityBorders from '../data/municipalities_1991.geojson';
   
   // Use for visualization or spatial queries
   ```

3. **Use for spatial queries:**
   - Check which municipality a point is in
   - Calculate distances to municipality borders
   - Determine adjacent municipalities
   - Visualize control zones

## Additional Resources

**GIS Tools:**
- QGIS: Free, open-source GIS software for manual border editing
- geojson.io: Online tool for viewing/editing GeoJSON
- Mapshaper: Online tool for simplifying/converting geo formats

**Python Libraries:**
- shapely: Geometric operations
- geopandas: Spatial dataframes (like pandas for geo data)
- fiona: Reading/writing geo formats
- alphashape: Concave hull generation

**Tutorials:**
- Creating polygons from points: https://automating-gis-processes.github.io/
- Working with GeoJSON: https://geojson.org/
- Shapely documentation: https://shapely.readthedocs.io/

## Need Help?

If you run into issues:

1. Check that your input GeoJSON is valid at https://geojson.io
2. Verify municipality field names match what the script expects
3. Try different buffer/alpha values
4. Check the validation report output by the script

Good luck! The generated borders should work well for your AWWV project.
