# Settlement Outlines Viewer

A minimal, zero-dependency HTML viewer for visually inspecting settlement polygon outlines.

## Features

- Renders settlement polygons as **outlines only** (no fills)
- Pan and zoom support
- Wheel zoom towards cursor
- Left mouse drag to pan
- Double-click or "Fit" button to reset view
- Auto-fit on load
- Handles window resize
- Performance metrics display

## Prerequisites

1. Build the map data:
   ```bash
   npm run map:build:new
   ```

2. Prepare the viewer data:
   ```bash
   npm run map:view:simple:prep
   ```

   This copies the required data files from `data/derived/` to `tools/map_viewer_simple/data/derived/`.

## Usage

Start the viewer server:
```bash
npm run map:view:simple
```

The server will start on port 5177. Open your browser to:
```
http://localhost:5177
```

## Controls

- **Left mouse drag**: Pan the map
- **Mouse wheel**: Zoom in/out towards cursor
- **Double-click**: Fit map to view
- **Fit button**: Reset zoom and pan to fit

## Troubleshooting

### "Failed to load map data"

- Ensure you've run `npm run map:view:simple:prep` to copy data files
- Check that `tools/map_viewer_simple/data/derived/map_bounds.json` exists
- Check that `tools/map_viewer_simple/data/derived/settlements_polygons.geojson` exists

### "Cannot GET /"

- Make sure you're accessing via `http://localhost:5177` (not `file://`)
- The viewer must be served from a web server due to CORS restrictions when loading JSON/GeoJSON files

### Polygons appear connected with "fan lines"

- This should not happen with the current implementation
- Each polygon uses its own `beginPath()`, `moveTo()` for the first vertex, and `closePath()` before `stroke()`
- If you see this issue, check the browser console for errors

## Implementation Notes

- Zero dependencies: pure HTML, CSS, and JavaScript
- Canvas-based rendering for performance
- Proper polygon isolation to prevent rendering artifacts
- Line width scales with zoom to maintain visibility
