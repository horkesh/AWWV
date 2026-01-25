/**
 * Geometry Hull Utilities: Deterministic convex hull and point sampling
 * 
 * Provides deterministic convex hull computation using Andrew's monotone chain
 * and point sampling from geometries for fallback when union fails.
 * 
 * Usage:
 *   import { convexHull, samplePointsFromGeometry, hullPolygonGeometry } from './geometry_hull';
 */

import * as GeoJSON from 'geojson';

// ============================================================================
// Types
// ============================================================================

export type Point = [number, number];

// ============================================================================
// Constants
// ============================================================================

const COORDINATE_PRECISION = 3;

// ============================================================================
// Convex Hull (Andrew's Monotone Chain)
// ============================================================================

/**
 * Compute convex hull using Andrew's monotone chain algorithm
 * 
 * Determinism rules:
 * - Sort points lexicographically (x then y)
 * - Remove duplicates during sort pass
 * - If < 3 unique points, return the unique points
 * - Return hull as a closed ring: repeat first point at end
 * - Round to 3 decimals at the very end
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length === 0) {
    return [];
  }
  
  if (points.length === 1) {
    return [points[0]];
  }
  
  // Remove duplicates and sort lexicographically (x then y)
  const uniquePoints = new Map<string, Point>();
  for (const point of points) {
    const key = `${point[0]},${point[1]}`;
    if (!uniquePoints.has(key)) {
      uniquePoints.set(key, point);
    }
  }
  
  const sorted = Array.from(uniquePoints.values()).sort((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] - b[0];
    }
    return a[1] - b[1];
  });
  
  if (sorted.length < 3) {
    return sorted;
  }
  
  // Andrew's monotone chain algorithm
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  
  // Remove last point of lower and upper (they're duplicates)
  lower.pop();
  upper.pop();
  
  // Combine lower and upper hulls
  const hull = [...lower, ...upper];
  
  // Round to 3 decimals
  const rounded = hull.map(([x, y]) => [
    Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
    Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
  ] as Point);
  
  // Close the ring: add first point at end if not already closed
  if (rounded.length > 0) {
    const first = rounded[0];
    const last = rounded[rounded.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      rounded.push([first[0], first[1]]);
    }
  }
  
  return rounded;
}

/**
 * Cross product for three points (for convex hull computation)
 */
function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// ============================================================================
// Point Sampling from Geometry
// ============================================================================

/**
 * Sample points from a geometry deterministically
 * 
 * Collects vertices from all rings in Polygon or MultiPolygon.
 * Deterministic sampling to control size:
 * - Include every `step`th vertex (step >= 1)
 * - Always include the first vertex of each ring
 * - Default step: 8 (reduce load but stable)
 * - Do NOT randomize
 */
export function samplePointsFromGeometry(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  step: number = 8
): Point[] {
  const points: Point[] = [];
  
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) {
      if (ring.length === 0) continue;
      
      // Always include first vertex
      points.push([ring[0][0], ring[0][1]]);
      
      // Include every step-th vertex
      for (let i = step; i < ring.length; i += step) {
        points.push([ring[i][0], ring[i][1]]);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.coordinates) {
      for (const ring of polygon) {
        if (ring.length === 0) continue;
        
        // Always include first vertex
        points.push([ring[0][0], ring[0][1]]);
        
        // Include every step-th vertex
        for (let i = step; i < ring.length; i += step) {
          points.push([ring[i][0], ring[i][1]]);
        }
      }
    }
  }
  
  return points;
}

// ============================================================================
// Hull to Polygon Geometry
// ============================================================================

/**
 * Convert convex hull points to GeoJSON Polygon geometry
 * 
 * If hull has < 4 points (closed ring needs 4 incl last==first), return null.
 * Returns { type:"Polygon", coordinates:[hullRing] }
 */
export function hullPolygonGeometry(points: Point[]): GeoJSON.Polygon | null {
  if (points.length < 4) {
    // Need at least 4 points for a closed ring (first point repeated at end)
    return null;
  }
  
  // Ensure closed ring
  const ring = [...points];
  if (ring.length > 0) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
  }
  
  return {
    type: 'Polygon',
    coordinates: [ring]
  };
}
