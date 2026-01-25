# AWWV Map Viewer

Zero-dependency HTML canvas viewer for inspecting derived map outputs.

## Prerequisites

1. Build the map data:
   ```bash
   npm run map:build:new
   ```

2. Prepare viewer data:
   ```bash
   npm run map:view:prep
   ```

3. Start the viewer server:
   ```bash
   npm run map:view
   ```

4. Open browser to: `http://localhost:5177`

## Features

- **Rendering**: Settlement polygons with municipality-based coloring
- **Pan & Zoom**: Mouse drag to pan, mouse wheel to zoom (zooms towards cursor)
- **Hover**: Highlights settlement under cursor
- **Selection**: Click to select settlement, shows detailed info
- **Municipality Outlines**: Toggle display of municipality boundaries
- **Filters**: Filter view by selected municipality
- **Info Panel**: Shows settlement, municipality, and census data
- **Diagnostics**: Real-time performance and statistics

## Controls

- **Left Mouse Drag**: Pan the map
- **Mouse Wheel**: Zoom in/out (zooms towards cursor)
- **Double Click**: Fit map to screen
- **Click**: Select settlement
- **Checkboxes**:
  - Municipality Outlines: Show/hide municipality boundaries
  - Settlement Strokes: Show/hide polygon outlines
  - Filter to Selected Municipality: Show only settlements in selected municipality
- **Municipality Filter**: Dropdown to filter by municipality name

## Performance

- Spatial indexing for fast hit testing (uniform grid)
- Efficient canvas rendering with minimal allocations
- Only redraws when state changes

## Troubleshooting

### CORS Errors

If you see CORS errors, ensure you're running via the dev server (`npm run map:view`), not opening the HTML file directly (`file://`).

### Data Not Loading

1. Verify `npm run map:build:new` completed successfully
2. Verify `npm run map:view:prep` copied files to `tools/map_viewer/data/derived/`
3. Check browser console for fetch errors

### Port Already in Use

If port 5177 is in use, edit `tools/map_viewer/server.js` to change the port.

## File Structure

```
tools/map_viewer/
  index.html          # Main HTML file
  viewer.js           # Viewer logic
  style.css           # Styling
  README.md           # This file
  server.js           # Dev server script
  data/
    derived/          # Copied from data/derived/
      settlements_polygons.geojson
      municipality_outlines.geojson
      settlements_meta.json
      municipalities_meta.json
      map_bounds.json
```
