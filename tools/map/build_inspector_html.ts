/**
 * Build Inspector HTML: Create visual inspection tool for Path A map
 * 
 * Generates a static HTML file for visually inspecting:
 *   - Polygon fabric (territorial micro-areas)
 *   - Municipality outlines
 *   - Settlement points (from Excel)
 * 
 * Outputs:
 *   - data/derived/settlements_inspector.html
 * 
 * Usage:
 *   tsx tools/map/build_inspector_html.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");
loadLedger();
assertLedgerFresh("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");

// ============================================================================
// Constants
// ============================================================================

const POLYGONS_PATH = resolve('data/derived/polygon_fabric.geojson');
const POLYGONS_WITH_MID_PATH = resolve('data/derived/polygon_fabric_with_mid.geojson');
const OUTLINES_PATH = resolve('data/derived/municipality_outline.geojson');
const MUN_CODE_OUTLINE_PATH = resolve('data/derived/mun_code_outline.geojson');
const NATIONAL_OUTLINE_PATH = resolve('data/derived/national_outline.geojson');
const POINTS_PATH = resolve('data/derived/settlement_points_from_excel.geojson');
const OUTPUT_PATH = resolve('data/derived/settlements_inspector.html');
const DERIVED_DIR = resolve('data/derived');

// ============================================================================
// HTML Generation
// ============================================================================

function generateHTML(
  polygonsData: string,
  polygonsWithMidData: string | null,
  outlinesData: string,
  munCodeOutlinesData: string | null,
  nationalOutlineData: string | null,
  pointsData: string,
  outlinesMode: 'mid' | 'mun_code' | 'none'
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settlement Borders Inspector</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    
    #canvas-container {
      flex: 1;
      position: relative;
      background: #1a1a1a;
      cursor: grab;
    }
    
    #canvas-container.dragging {
      cursor: grabbing;
    }
    
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    #sidebar {
      width: 350px;
      background: #2d2d2d;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      border-left: 1px solid #444;
      overflow-y: auto;
    }
    
    #sidebar-header {
      padding: 16px;
      background: #1e1e1e;
      border-bottom: 1px solid #444;
    }
    
    #sidebar-header h1 {
      font-size: 18px;
      margin-bottom: 12px;
    }
    
    #search-box {
      width: 100%;
      padding: 8px 12px;
      background: #3d3d3d;
      border: 1px solid #555;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
    }
    
    #search-box:focus {
      outline: none;
      border-color: #666;
      background: #404040;
    }
    
    #stats {
      padding: 12px 16px;
      font-size: 12px;
      color: #aaa;
      border-bottom: 1px solid #444;
    }
    
    #stats div {
      margin: 4px 0;
    }
    
    #layer-controls {
      padding: 12px 16px;
      border-bottom: 1px solid #444;
    }
    
    #layer-controls h3 {
      font-size: 14px;
      margin-bottom: 8px;
      color: #fff;
    }
    
    .layer-toggle {
      display: flex;
      align-items: center;
      margin: 6px 0;
      cursor: pointer;
    }
    
    .layer-toggle input[type="checkbox"] {
      margin-right: 8px;
      cursor: pointer;
    }
    
    .layer-toggle label {
      cursor: pointer;
      user-select: none;
    }
    
    #hud {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      padding: 12px;
      border-radius: 4px;
      font-size: 11px;
      max-width: 300px;
      z-index: 100;
    }
    
    #hud .warning {
      color: #ffaa00;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #444;
    }
    
    #properties {
      padding: 16px;
      flex: 1;
      overflow-y: auto;
    }
    
    #properties h2 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #fff;
    }
    
    #properties-content {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      background: #1e1e1e;
      padding: 12px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 400px;
      overflow-y: auto;
    }
    
    #tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      display: none;
      max-width: 300px;
    }
    
    #tooltip.visible {
      display: block;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
  </div>
  
    <div id="sidebar">
    <div id="sidebar-header">
      <h1>Map Inspector (Path A)</h1>
      <input type="text" id="search-box" placeholder="Search by poly_id, sid, or mid...">
    </div>
    <div id="layer-controls">
      <h3>Layers</h3>
      <div class="layer-toggle">
        <input type="checkbox" id="toggle-polygons" checked>
        <label for="toggle-polygons">Polygons</label>
      </div>
      <div class="layer-toggle">
        <input type="checkbox" id="toggle-points">
        <label for="toggle-points">Settlement Points</label>
      </div>
      <div class="layer-toggle">
        <input type="checkbox" id="toggle-outlines" checked>
        <label for="toggle-outlines" id="outlines-label">Municipality Outlines</label>
      </div>
      <button id="fit-to-view" style="margin-top: 12px; padding: 8px 16px; background: #4a9eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">Fit to View</button>
      <div class="layer-toggle">
        <input type="checkbox" id="toggle-national" checked>
        <label for="toggle-national">National Outline</label>
      </div>
    </div>
    <div id="stats"></div>
    <div id="properties">
      <h2>Selected Feature</h2>
      <div id="properties-content">Click on a polygon to see details</div>
    </div>
  </div>
  
  <div id="hud"></div>

  <script>
    // Data embedded from build
    const POLYGONS_DATA = ${polygonsData};
    const POLYGONS_WITH_MID_DATA = ${polygonsWithMidData || 'null'};
    const OUTLINES_DATA = ${outlinesData};
    const MUN_CODE_OUTLINES_DATA = ${munCodeOutlinesData || 'null'};
    const NATIONAL_OUTLINE_DATA = ${nationalOutlineData || 'null'};
    const POINTS_DATA = ${pointsData};
    const OUTLINES_MODE = '${outlinesMode}';
    
    // Canvas setup
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const tooltip = document.getElementById('tooltip');
    const searchBox = document.getElementById('search-box');
    const statsDiv = document.getElementById('stats');
    const propertiesContent = document.getElementById('properties-content');
    const hudDiv = document.getElementById('hud');
    const togglePolygons = document.getElementById('toggle-polygons');
    const togglePoints = document.getElementById('toggle-points');
    const toggleOutlines = document.getElementById('toggle-outlines');
    const toggleNational = document.getElementById('toggle-national');
    const fitToViewBtn = document.getElementById('fit-to-view');
    const outlinesLabel = document.getElementById('outlines-label');
    
    // View state
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hoveredFeature = null;
    let selectedFeature = null;
    
    // Layer visibility
    let showPolygons = true;
    let showPoints = false;
    let showOutlines = true;
    let showNational = true;
    
    // Feature data
    let polygons = [];
    let outlines = [];
    let nationalOutline = null;
    let points = [];
    let featureBounds = new Map();
    let pointBounds = new Map();
    
    // Initialize
    function init() {
      // Parse GeoJSON - always load polygon fabric first
      if (POLYGONS_DATA && POLYGONS_DATA.features) {
        polygons = POLYGONS_DATA.features;
      }
      
      // If polygon_fabric_with_mid exists, prefer it for properties (but keep all polygons)
      if (POLYGONS_WITH_MID_DATA && POLYGONS_WITH_MID_DATA.features) {
        // Merge properties from with_mid version if available
        const withMidMap = new Map();
        POLYGONS_WITH_MID_DATA.features.forEach(f => {
          const polyId = f.properties?.poly_id;
          if (polyId) {
            withMidMap.set(polyId, f.properties);
          }
        });
        
        // Update polygon properties
        polygons.forEach(poly => {
          const polyId = poly.properties?.poly_id;
          if (polyId && withMidMap.has(polyId)) {
            poly.properties = { ...poly.properties, ...withMidMap.get(polyId) };
          }
        });
      }
      
      // Load outlines based on mode
      if (OUTLINES_MODE === 'mid' && OUTLINES_DATA && OUTLINES_DATA.features && OUTLINES_DATA.features.length > 0) {
        outlines = OUTLINES_DATA.features;
        if (outlinesLabel) {
          outlinesLabel.textContent = 'Municipality Outlines (mid)';
        }
      } else if (OUTLINES_MODE === 'mun_code' && MUN_CODE_OUTLINES_DATA && MUN_CODE_OUTLINES_DATA.features && MUN_CODE_OUTLINES_DATA.features.length > 0) {
        outlines = MUN_CODE_OUTLINES_DATA.features;
        
        // Check if any outlines use hull fallback
        const hasHullFallback = outlines.some(f => 
          f.properties?.union_failed === true || 
          f.properties?.source?.includes('_hull_fallback')
        );
        
        if (outlinesLabel) {
          if (hasHullFallback) {
            outlinesLabel.textContent = 'Municipality Outlines (mun_code, hull fallback for some)';
          } else {
            outlinesLabel.textContent = 'Municipality Outlines (mun_code partitions, inspection-only)';
          }
        }
      } else {
        outlines = [];
        if (outlinesLabel) {
          outlinesLabel.textContent = 'Municipality Outlines (none)';
        }
      }
      
      if (NATIONAL_OUTLINE_DATA && NATIONAL_OUTLINE_DATA.features && NATIONAL_OUTLINE_DATA.features.length > 0) {
        nationalOutline = NATIONAL_OUTLINE_DATA.features[0];
      }
      
      if (POINTS_DATA && POINTS_DATA.features) {
        points = POINTS_DATA.features;
        
        // Auto-hide points if >90% are synthetic
        const syntheticCount = points.filter(p => p.properties?.synthetic).length;
        const syntheticRatio = points.length > 0 ? syntheticCount / points.length : 0;
        if (syntheticRatio > 0.9) {
          showPoints = false;
          togglePoints.checked = false;
        }
      }
      
      // Precompute bounds for all features - walk ALL coordinates (Polygon and MultiPolygon)
      function computeBounds(feature) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        if (!feature.geometry || !feature.geometry.coordinates) {
          return null;
        }
        
        const geomType = feature.geometry.type;
        const coords = feature.geometry.coordinates;
        
        if (geomType === 'Polygon') {
          // Polygon: [[[x,y], ...], ...] - walk all rings
          coords.forEach(ring => {
            ring.forEach(([x, y]) => {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            });
          });
        } else if (geomType === 'MultiPolygon') {
          // MultiPolygon: [[[[x,y], ...], ...], ...] - walk all polygons and all rings
          coords.forEach(polygon => {
            polygon.forEach(ring => {
              ring.forEach(([x, y]) => {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
              });
            });
          });
        } else if (geomType === 'Point') {
          const [x, y] = coords;
          minX = maxX = x;
          minY = maxY = y;
        }
        
        if (!isFinite(minX)) return null;
        return { minX, minY, maxX, maxY };
      }
      
      polygons.forEach((feature, idx) => {
        const bounds = computeBounds(feature);
        if (bounds) {
          featureBounds.set(idx, bounds);
        }
      });
      
      points.forEach((feature, idx) => {
        const bounds = computeBounds(feature);
        if (bounds) {
          pointBounds.set(idx, bounds);
        }
      });
      
      // Fit to view on load
      fitToView();
      
      // Update stats and HUD
      updateStats();
      updateHUD();
      
      // Draw
      draw();
    }
    
    function updateStats() {
      const polygonsWithMid = polygons.filter(f => f.properties?.mid).length;
      const polygonsWithoutMid = polygons.filter(f => !f.properties?.mid).length;
      const pointsSynthetic = points.filter(f => f.properties?.synthetic).length;
      const pointsTrue = points.filter(f => !f.properties?.synthetic).length;
      
      let statsHTML = \`<div>Polygon fabric: <strong>\${polygons.length}</strong></div>\`;
      statsHTML += \`<div>  With mid: <strong>\${polygonsWithMid}</strong></div>\`;
      statsHTML += \`<div>  Without mid: <strong>\${polygonsWithoutMid}</strong></div>\`;
      statsHTML += \`<div>Settlement points: <strong>\${points.length}</strong></div>\`;
      statsHTML += \`<div>  True coords: <strong>\${pointsTrue}</strong></div>\`;
      statsHTML += \`<div>  Synthetic: <strong>\${pointsSynthetic}</strong></div>\`;
      statsHTML += \`<div>Municipality outlines: <strong>\${outlines.length}</strong></div>\`;
      if (nationalOutline) {
        statsHTML += \`<div>National outline: <strong>Yes</strong></div>\`;
      }
      statsDiv.innerHTML = statsHTML;
    }
    
    function fitToView() {
      let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
      let hasBounds = false;
      
      // Default fit rules:
      // 1) If Polygons layer is ON and polygons exist: fit to polygon fabric bounds
      // 2) Else if Outlines ON and exist: fit to outlines bounds
      // 3) Else if National outline ON: fit to national outline bounds
      // 4) Else if points ON: fit to points bounds
      
      if (showPolygons && polygons.length > 0) {
        polygons.forEach((f, idx) => {
          const bounds = featureBounds.get(idx);
          if (bounds) {
            allMinX = Math.min(allMinX, bounds.minX);
            allMinY = Math.min(allMinY, bounds.minY);
            allMaxX = Math.max(allMaxX, bounds.maxX);
            allMaxY = Math.max(allMaxY, bounds.maxY);
            hasBounds = true;
          }
        });
      } else if (showOutlines && outlines.length > 0) {
        outlines.forEach(f => {
          const bounds = computeBounds(f);
          if (bounds) {
            allMinX = Math.min(allMinX, bounds.minX);
            allMinY = Math.min(allMinY, bounds.minY);
            allMaxX = Math.max(allMaxX, bounds.maxX);
            allMaxY = Math.max(allMaxY, bounds.maxY);
            hasBounds = true;
          }
        });
      } else if (showNational && nationalOutline) {
        const bounds = computeBounds(nationalOutline);
        if (bounds) {
          allMinX = bounds.minX;
          allMinY = bounds.minY;
          allMaxX = bounds.maxX;
          allMaxY = bounds.maxY;
          hasBounds = true;
        }
      } else if (showPoints && points.length > 0) {
        points.forEach((f, idx) => {
          const bounds = pointBounds.get(idx);
          if (bounds) {
            allMinX = Math.min(allMinX, bounds.minX);
            allMinY = Math.min(allMinY, bounds.minY);
            allMaxX = Math.max(allMaxX, bounds.maxX);
            allMaxY = Math.max(allMaxY, bounds.maxY);
            hasBounds = true;
          }
        });
      }
      
      if (hasBounds) {
        const width = allMaxX - allMinX;
        const height = allMaxY - allMinY;
        const centerX = (allMinX + allMaxX) / 2;
        const centerY = (allMinY + allMaxY) / 2;
        
        if (width > 0 && height > 0) {
          scale = Math.min(canvas.width / width, canvas.height / height) * 0.9;
          panX = canvas.width / 2 - centerX * scale;
          panY = canvas.height / 2 - centerY * scale;
        }
      }
      
      draw();
    }
    
    function computeBounds(feature) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      if (!feature.geometry || !feature.geometry.coordinates) {
        return null;
      }
      
      const geomType = feature.geometry.type;
      const coords = feature.geometry.coordinates;
      
      if (geomType === 'Polygon') {
        coords.forEach(ring => {
          ring.forEach(([x, y]) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          });
        });
      } else if (geomType === 'MultiPolygon') {
        coords.forEach(polygon => {
          polygon.forEach(ring => {
            ring.forEach(([x, y]) => {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            });
          });
        });
      } else if (geomType === 'Point') {
        const [x, y] = coords;
        minX = maxX = x;
        minY = maxY = y;
      }
      
      if (!isFinite(minX)) return null;
      return { minX, minY, maxX, maxY };
    }
    
    function updateHUD() {
      let hudHTML = \`<div><strong>Map Inspector</strong></div>\`;
      hudHTML += \`<div>Polygons: \${polygons.length}</div>\`;
      hudHTML += \`<div>Outlines: \${outlines.length} (\${OUTLINES_MODE === 'mid' ? 'mid' : OUTLINES_MODE === 'mun_code' ? 'mun_code' : 'none'})</div>\`;
      hudHTML += \`<div>National outline: \${nationalOutline ? 'Yes' : 'No'}</div>\`;
      const pointsSynthetic = points.filter(f => f.properties?.synthetic).length;
      hudHTML += \`<div>Points: \${points.length} (\${pointsSynthetic} synthetic)</div>\`;
      
      if (OUTLINES_MODE === 'mun_code') {
        hudHTML += \`<div class="warning">⚠ Using mun_code partitions (inspection-only, not pre-1991 mid)</div>\`;
      } else if (OUTLINES_MODE === 'none') {
        hudHTML += \`<div class="warning">⚠ No outlines available</div>\`;
      }
      
      hudDiv.innerHTML = hudHTML;
    }
    
    function worldToScreen(x, y) {
      return {
        x: x * scale + panX,
        y: y * scale + panY
      };
    }
    
    function screenToWorld(x, y) {
      return {
        x: (x - panX) / scale,
        y: (y - panY) / scale
      };
    }
    
    function isPointInPolygon(point, polygon) {
      const coords = polygon.geometry.coordinates[0];
      let inside = false;
      for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const xi = coords[i][0], yi = coords[i][1];
        const xj = coords[j][0], yj = coords[j][1];
        const intersect = ((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw polygons (always show, viewport culling optional for performance)
      if (showPolygons) {
        polygons.forEach((feature, idx) => {
          const bounds = featureBounds.get(idx);
          if (!bounds) return;
          
          const geomType = feature.geometry.type;
          const coords = feature.geometry.coordinates;
          const hasMid = feature.properties?.mid;
          const isSelected = selectedFeature === feature;
          
          // Style based on mid status
          if (isSelected) {
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
          } else if (!hasMid) {
            ctx.strokeStyle = '#ff6666';
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 1;
          } else {
            ctx.strokeStyle = '#6666ff';
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
          }
          
          if (geomType === 'Polygon') {
            coords.forEach(ring => {
              ctx.beginPath();
              const first = worldToScreen(ring[0][0], ring[0][1]);
              ctx.moveTo(first.x, first.y);
              
              for (let i = 1; i < ring.length; i++) {
                const screen = worldToScreen(ring[i][0], ring[i][1]);
                ctx.lineTo(screen.x, screen.y);
              }
              ctx.closePath();
              ctx.stroke();
            });
          } else if (geomType === 'MultiPolygon') {
            coords.forEach(polygon => {
              polygon.forEach(ring => {
                ctx.beginPath();
                const first = worldToScreen(ring[0][0], ring[0][1]);
                ctx.moveTo(first.x, first.y);
                
                for (let i = 1; i < ring.length; i++) {
                  const screen = worldToScreen(ring[i][0], ring[i][1]);
                  ctx.lineTo(screen.x, screen.y);
                }
                ctx.closePath();
                ctx.stroke();
              });
            });
          }
        });
      }
      
      // Draw national outline (thickest)
      if (showNational && nationalOutline) {
        const geomType = nationalOutline.geometry.type;
        const coords = nationalOutline.geometry.coordinates;
        
        if (geomType === 'Polygon') {
          coords.forEach(ring => {
            ctx.beginPath();
            const first = worldToScreen(ring[0][0], ring[0][1]);
            ctx.moveTo(first.x, first.y);
            
            for (let i = 1; i < ring.length; i++) {
              const screen = worldToScreen(ring[i][0], ring[i][1]);
              ctx.lineTo(screen.x, screen.y);
            }
            ctx.closePath();
            
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 4;
            ctx.setLineDash([]);
            ctx.stroke();
          });
        } else if (geomType === 'MultiPolygon') {
          coords.forEach(polygon => {
            polygon.forEach(ring => {
              ctx.beginPath();
              const first = worldToScreen(ring[0][0], ring[0][1]);
              ctx.moveTo(first.x, first.y);
              
              for (let i = 1; i < ring.length; i++) {
                const screen = worldToScreen(ring[i][0], ring[i][1]);
                ctx.lineTo(screen.x, screen.y);
              }
              ctx.closePath();
              
              ctx.strokeStyle = '#00ffff';
              ctx.lineWidth = 4;
              ctx.setLineDash([]);
              ctx.stroke();
            });
          });
        }
      }
      
      // Draw municipality outlines (thicker than polygons)
      if (showOutlines) {
        outlines.forEach(feature => {
          const geomType = feature.geometry.type;
          const coords = feature.geometry.coordinates;
          
          if (geomType === 'Polygon') {
            coords.forEach(ring => {
              ctx.beginPath();
              const first = worldToScreen(ring[0][0], ring[0][1]);
              ctx.moveTo(first.x, first.y);
              
              for (let i = 1; i < ring.length; i++) {
                const screen = worldToScreen(ring[i][0], ring[i][1]);
                ctx.lineTo(screen.x, screen.y);
              }
              ctx.closePath();
              
              ctx.strokeStyle = '#ffaa00';
              ctx.lineWidth = 3;
              ctx.setLineDash([]);
              ctx.stroke();
            });
          } else if (geomType === 'MultiPolygon') {
            coords.forEach(polygon => {
              polygon.forEach(ring => {
                ctx.beginPath();
                const first = worldToScreen(ring[0][0], ring[0][1]);
                ctx.moveTo(first.x, first.y);
                
                for (let i = 1; i < ring.length; i++) {
                  const screen = worldToScreen(ring[i][0], ring[i][1]);
                  ctx.lineTo(screen.x, screen.y);
                }
                ctx.closePath();
                
                ctx.strokeStyle = '#ffaa00';
                ctx.lineWidth = 3;
                ctx.setLineDash([]);
                ctx.stroke();
              });
            });
          }
        });
      }
      
      // Draw settlement points
      if (showPoints) {
        points.forEach((feature, idx) => {
          const bounds = pointBounds.get(idx);
          if (!bounds) return;
          
          const [x, y] = feature.geometry.coordinates;
          const screen = worldToScreen(x, y);
          const isSynthetic = feature.properties?.synthetic;
          const isSelected = selectedFeature === feature;
          
          ctx.beginPath();
          const radius = isSelected ? 5 : (isSynthetic ? 2 : 3);
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          
          if (isSynthetic) {
            ctx.fillStyle = 'rgba(255, 0, 255, 0.5)'; // Semi-transparent magenta
          } else {
            ctx.fillStyle = '#00ff00';
          }
          ctx.fill();
          
          if (isSelected) {
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        });
      }
    }
    
    function findFeatureAt(x, y) {
      const world = screenToWorld(x, y);
      
      // Check points first (smaller, easier to click)
      for (let i = points.length - 1; i >= 0; i--) {
        const feature = points[i];
        const [px, py] = feature.geometry.coordinates;
        const dist = Math.sqrt((world.x - px) ** 2 + (world.y - py) ** 2);
        if (dist < 5 / scale) { // 5 pixel tolerance
          return feature;
        }
      }
      
      // Check outlines (before polygons, so they're clickable)
      for (let i = outlines.length - 1; i >= 0; i--) {
        const feature = outlines[i];
        if (isPointInPolygon(world, feature)) {
          return feature;
        }
      }
      
      // Check national outline
      if (nationalOutline && isPointInPolygon(world, nationalOutline)) {
        return nationalOutline;
      }
      
      // Check polygons (reverse order for top-most)
      for (let i = polygons.length - 1; i >= 0; i--) {
        const feature = polygons[i];
        if (isPointInPolygon(world, feature)) {
          return feature;
        }
      }
      return null;
    }
    
    function updateTooltip(feature, x, y) {
      if (!feature) {
        tooltip.classList.remove('visible');
        return;
      }
      
      const props = feature.properties || {};
      let text = '';
      
      if (feature.geometry.type === 'Point') {
        // Settlement point
        const sid = props.sid || 'N/A';
        const mid = props.mid || 'N/A';
        const synthetic = props.synthetic ? ' (synthetic)' : '';
        text = \`sid: \${sid}\\nmid: \${mid}\${synthetic}\`;
      } else {
        // Polygon or outline
        const polyId = props.poly_id || null;
        const munCode = props.mun_code || null;
        const mid = props.mid || null;
        const source = props.source || null;
        const unionFailed = props.union_failed || false;
        
        if (polyId) {
          // Regular polygon
          text = \`poly_id: \${polyId}\\nmun_code: \${munCode || 'N/A'}\`;
          if (mid) {
            text += \`\\nmid: \${mid}\`;
          } else {
            text += '\\nmid: (none)';
          }
        } else if (munCode) {
          // mun_code outline
          text = \`mun_code: \${munCode}\\nsource: \${source || 'N/A'}\`;
          if (unionFailed) {
            text += '\\nunion_failed: true';
          }
        } else if (mid) {
          // mid outline
          text = \`mid: \${mid}\\nsource: \${source || 'N/A'}\`;
        } else {
          // Other polygon
          text = \`type: polygon\\nsource: \${source || 'N/A'}\`;
        }
      }
      
      tooltip.textContent = text;
      tooltip.style.left = (x + 10) + 'px';
      tooltip.style.top = (y + 10) + 'px';
      tooltip.classList.add('visible');
    }
    
    function showFeatureProperties(feature) {
      if (!feature) {
        propertiesContent.textContent = 'Click on a polygon to see details';
        return;
      }
      
      propertiesContent.textContent = JSON.stringify(feature.properties, null, 2);
    }
    
    // Event handlers
    function resizeCanvas() {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      draw();
    }
    
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
      container.classList.add('dragging');
    });
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (isDragging) {
        panX = e.clientX - dragStartX;
        panY = e.clientY - dragStartY;
        draw();
      } else {
        const feature = findFeatureAt(x, y);
        hoveredFeature = feature;
        updateTooltip(feature, e.clientX, e.clientY);
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      container.classList.remove('dragging');
    });
    
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const feature = findFeatureAt(x, y);
      selectedFeature = feature;
      showFeatureProperties(feature);
      draw();
    });
    
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const worldBefore = screenToWorld(mouseX, mouseY);
      scale *= e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.max(0.1, Math.min(100, scale));
      const worldAfter = screenToWorld(mouseX, mouseY);
      
      panX += (worldBefore.x - worldAfter.x) * scale;
      panY += (worldBefore.y - worldAfter.y) * scale;
      
      draw();
    });
    
    searchBox.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        selectedFeature = null;
        showFeatureProperties(null);
        draw();
        return;
      }
      
      // Search by poly_id, sid, or mid
      let found = polygons.find(f => {
        const props = f.properties || {};
        const polyId = String(props.poly_id || '').toLowerCase();
        const mid = String(props.mid || '').toLowerCase();
        return polyId.includes(query) || mid.includes(query);
      });
      
      if (!found) {
        found = points.find(f => {
          const props = f.properties || {};
          const sid = String(props.sid || '').toLowerCase();
          const mid = String(props.mid || '').toLowerCase();
          return sid.includes(query) || mid.includes(query);
        });
      }
      
      if (found) {
        selectedFeature = found;
        showFeatureProperties(found);
        
        // Center on feature
        if (found.geometry.type === 'Point') {
          const [x, y] = found.geometry.coordinates;
          panX = canvas.width / 2 - x * scale;
          panY = canvas.height / 2 - y * scale;
        } else {
          const bounds = featureBounds.get(polygons.indexOf(found));
          if (bounds) {
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const centerY = (bounds.minY + bounds.maxY) / 2;
            panX = canvas.width / 2 - centerX * scale;
            panY = canvas.height / 2 - centerY * scale;
          }
        }
        
        draw();
      }
    });
    
    // Layer toggle handlers
    togglePolygons.addEventListener('change', (e) => {
      showPolygons = e.target.checked;
      draw();
    });
    
    togglePoints.addEventListener('change', (e) => {
      showPoints = e.target.checked;
      draw();
    });
    
    toggleOutlines.addEventListener('change', (e) => {
      showOutlines = e.target.checked;
      draw();
    });
    
    toggleNational.addEventListener('change', (e) => {
      showNational = e.target.checked;
      draw();
    });
    
    fitToViewBtn.addEventListener('click', () => {
      fitToView();
    });
    
    window.addEventListener('resize', resizeCanvas);
    
    // Initialize
    resizeCanvas();
    init();
  </script>
</body>
</html>`;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Building inspector HTML...\n');
  
  try {
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Always load polygon fabric first (required)
    const polygonsContent = await readFile(POLYGONS_PATH, 'utf8');
    const polygonsData = JSON.parse(polygonsContent);
    
    // Sort features for determinism
    polygonsData.features.sort((a: any, b: any) => {
      const polyIdA = a.properties?.poly_id || '';
      const polyIdB = b.properties?.poly_id || '';
      return polyIdA.localeCompare(polyIdB);
    });
    
    // Optionally load polygon_fabric_with_mid (for enriched properties)
    let polygonsWithMidData: any = null;
    try {
      const polygonsWithMidContent = await readFile(POLYGONS_WITH_MID_PATH, 'utf8');
      polygonsWithMidData = JSON.parse(polygonsWithMidContent);
      polygonsWithMidData.features.sort((a: any, b: any) => {
        const polyIdA = a.properties?.poly_id || '';
        const polyIdB = b.properties?.poly_id || '';
        return polyIdA.localeCompare(polyIdB);
      });
    } catch {
      // Optional file, continue without it
    }
    
    // Check if crosswalk exists (by checking if any polygons have mid)
    const hasCrosswalk = polygonsWithMidData && polygonsWithMidData.features.some((f: any) => f.properties?.mid);
    
    // Load municipality outlines (mid-based) - optional
    let outlinesData: any = { type: 'FeatureCollection', features: [] };
    let hasMidOutlines = false;
    try {
      const outlinesContent = await readFile(OUTLINES_PATH, 'utf8');
      outlinesData = JSON.parse(outlinesContent);
      hasMidOutlines = outlinesData.features.length > 0 && outlinesData.features.some((f: any) => f.properties?.mid);
      if (hasMidOutlines) {
        outlinesData.features.sort((a: any, b: any) => {
          const midA = a.properties?.mid || '';
          const midB = b.properties?.mid || '';
          return midA.localeCompare(midB);
        });
      }
    } catch {
      // Optional file, continue without it
    }
    
    // Load mun_code outlines (fallback) - optional
    let munCodeOutlinesData: any = null;
    let hasMunCodeOutlines = false;
    try {
      const munCodeOutlinesContent = await readFile(MUN_CODE_OUTLINE_PATH, 'utf8');
      munCodeOutlinesData = JSON.parse(munCodeOutlinesContent);
      hasMunCodeOutlines = munCodeOutlinesData.features.length > 0;
      if (hasMunCodeOutlines) {
        munCodeOutlinesData.features.sort((a: any, b: any) => {
          const codeA = a.properties?.mun_code || '';
          const codeB = b.properties?.mun_code || '';
          return codeA.localeCompare(codeB);
        });
      }
    } catch {
      // Optional file, continue without it
    }
    
    // Determine outlines mode
    let outlinesMode: 'mid' | 'mun_code' | 'none' = 'none';
    if (hasMidOutlines) {
      outlinesMode = 'mid';
    } else if (hasMunCodeOutlines) {
      outlinesMode = 'mun_code';
    }
    
    // Load national outline (should always exist after derive_municipality_outlines)
    let nationalOutlineData: any = null;
    try {
      const nationalOutlineContent = await readFile(NATIONAL_OUTLINE_PATH, 'utf8');
      nationalOutlineData = JSON.parse(nationalOutlineContent);
    } catch {
      // Optional file, continue without it
    }
    
    // Load settlement points (optional)
    let pointsData: any = { type: 'FeatureCollection', features: [] };
    try {
      const pointsContent = await readFile(POINTS_PATH, 'utf8');
      pointsData = JSON.parse(pointsContent);
      pointsData.features.sort((a: any, b: any) => {
        const sidA = a.properties?.sid || '';
        const sidB = b.properties?.sid || '';
        return sidA.localeCompare(sidB);
      });
    } catch {
      // Optional file, continue without it
    }
    
    // Generate HTML
    const html = generateHTML(
      JSON.stringify(polygonsData),
      polygonsWithMidData ? JSON.stringify(polygonsWithMidData) : null,
      JSON.stringify(outlinesData),
      munCodeOutlinesData ? JSON.stringify(munCodeOutlinesData) : null,
      nationalOutlineData ? JSON.stringify(nationalOutlineData) : null,
      JSON.stringify(pointsData),
      outlinesMode
    );
    
    await writeFile(OUTPUT_PATH, html, 'utf8');
    
    console.log(`Output: ${OUTPUT_PATH}`);
    console.log(`  Polygons: ${polygonsData.features.length}`);
    console.log(`  Polygons with mid: ${polygonsWithMidData ? polygonsWithMidData.features.length : 0}`);
    console.log(`  Outlines mode: ${outlinesMode}`);
    console.log(`  Outlines (mid): ${hasMidOutlines ? outlinesData.features.length : 0}`);
    console.log(`  Outlines (mun_code): ${hasMunCodeOutlines ? (munCodeOutlinesData?.features.length || 0) : 0}`);
    console.log(`  National outline: ${nationalOutlineData ? 'Yes' : 'No'}`);
    console.log(`  Points: ${pointsData.features.length}`);
    console.log(`  Crosswalk: ${hasCrosswalk ? 'Yes' : 'No'}`);
    console.log('✓ Inspector HTML build complete');
  } catch (err) {
    console.error('Error building inspector HTML:', err);
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) {
        console.error(err.stack);
      }
    }
    process.exit(1);
  }
}

main();
