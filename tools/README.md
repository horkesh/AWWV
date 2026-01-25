# Map Viewer

A simple HTML map viewer for visualizing GeoJSON settlement polygons.

## Usage

1. Start a local HTTP server from the repository root:
   ```bash
   npx http-server -p 8080
   ```

2. Open the viewer in your browser:
   ```
   http://localhost:8080/tools/map_viewer.html
   ```

## Configuration

To change the data file paths, edit the constants at the top of `map_viewer.html`:

```javascript
const GEOJSON_PATH = '../data/derived/settlements_polygons.normalized.v1.geojson';
const ORPHANS_PATH = '../data/derived/settlement_orphans.json';
```

## Controls

- **Mouse wheel**: Zoom in/out
- **Drag**: Pan the map
- **Shift + Drag**: Box zoom
- **Fit button**: Reset view to fit all features
- **Highlight Orphans**: Show orphan features with red outline
- **Highlight Fallback**: Show fallback geometry features with yellow outline
- **Filter input**: Filter features by source file name (case-insensitive substring match)
