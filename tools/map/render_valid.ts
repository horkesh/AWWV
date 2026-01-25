/**
 * Render-valid polygon validation
 * 
 * Validates polygons for rendering/triangulation purposes, not GIS validity.
 * This is the primary gate for settlement polygon acceptance.
 */

const EPS_AREA = 1e-2;

export type RenderValidReason = 
  | "too_few_points"
  | "zero_area"
  | "self_intersect"
  | "triangulation_failed"
  | "non_finite";

export interface RenderValidResult {
  ok: boolean;
  reason?: RenderValidReason;
}

/**
 * Check if all coordinates are finite
 */
function areAllFinite(ring: Float32Array): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (!isFinite(ring[i]) || isNaN(ring[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Count unique points in ring
 */
function countUniquePoints(ring: Float32Array): number {
  const unique = new Set<string>();
  for (let i = 0; i < ring.length; i += 2) {
    unique.add(`${ring[i]},${ring[i + 1]}`);
  }
  return unique.size;
}

/**
 * Calculate polygon area using shoelace formula
 */
function polygonArea(ring: Float32Array): number {
  if (ring.length < 6) return 0; // Need at least 3 points (6 values)
  let area = 0;
  for (let i = 0; i < ring.length - 2; i += 2) {
    const x1 = ring[i];
    const y1 = ring[i + 1];
    const x2 = ring[i + 2];
    const y2 = ring[i + 3];
    area += x1 * y2;
    area -= x2 * y1;
  }
  // Close the polygon
  const x1 = ring[ring.length - 2];
  const y1 = ring[ring.length - 1];
  const x2 = ring[0];
  const y2 = ring[1];
  area += x1 * y2;
  area -= x2 * y1;
  return Math.abs(area) / 2;
}

/**
 * Check if two line segments intersect (excluding endpoints)
 * Segments: (p1, p2) and (p3, p4)
 */
function segmentsIntersect(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  p4x: number, p4y: number
): boolean {
  // Check if segments share an endpoint (touching at vertices is ok)
  if ((p1x === p3x && p1y === p3y) || (p1x === p4x && p1y === p4y) ||
      (p2x === p3x && p2y === p3y) || (p2x === p4x && p2y === p4y)) {
    return false;
  }
  
  // Compute orientation for intersection test
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  };
  
  const o1 = orient(p1x, p1y, p2x, p2y, p3x, p3y);
  const o2 = orient(p1x, p1y, p2x, p2y, p4x, p4y);
  const o3 = orient(p3x, p3y, p4x, p4y, p1x, p1y);
  const o4 = orient(p3x, p3y, p4x, p4y, p2x, p2y);
  
  // General case: segments intersect if orientations differ
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    return true;
  }
  
  // Special case: collinear segments (all orientations are 0)
  // Check if they overlap
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    // Check if segments overlap on x-axis
    const min1x = Math.min(p1x, p2x);
    const max1x = Math.max(p1x, p2x);
    const min2x = Math.min(p3x, p4x);
    const max2x = Math.max(p3x, p4x);
    
    if (max1x < min2x || max2x < min1x) {
      return false;
    }
    
    // Check if segments overlap on y-axis
    const min1y = Math.min(p1y, p2y);
    const max1y = Math.max(p1y, p2y);
    const min2y = Math.min(p3y, p4y);
    const max2y = Math.max(p3y, p4y);
    
    if (max1y < min2y || max2y < min1y) {
      return false;
    }
    
    // Segments are collinear and overlap - this is a self-intersection
    return true;
  }
  
  return false;
}

/**
 * Check for self-intersections using O(n^2) segment intersection test
 * Only checks non-adjacent edges (adjacent edges can share vertices, which is ok)
 */
function hasSelfIntersection(ring: Float32Array): boolean {
  const n = ring.length / 2;
  if (n < 4) return false; // Need at least 4 points (closed ring with 3 unique + duplicate first)
  
  // Check all pairs of non-adjacent edges
  for (let i = 0; i < n - 1; i++) {
    const p1x = ring[i * 2];
    const p1y = ring[i * 2 + 1];
    const p2x = ring[(i + 1) * 2];
    const p2y = ring[(i + 1) * 2 + 1];
    
    // Check against all non-adjacent edges
    for (let j = i + 2; j < n - 1; j++) {
      // Skip if j wraps around to i (last edge with first edge)
      if (i === 0 && j === n - 2) {
        continue; // Skip last edge with first edge (they share a vertex)
      }
      
      const p3x = ring[j * 2];
      const p3y = ring[j * 2 + 1];
      const p4x = ring[(j + 1) * 2];
      const p4y = ring[(j + 1) * 2 + 1];
      
      if (segmentsIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Validate polygon for rendering/triangulation
 * 
 * Checks:
 * 1. All coordinates are finite
 * 2. At least 3 unique points
 * 3. Non-zero area (>= EPS_AREA)
 * 4. No self-intersections (excluding touching at shared vertices)
 * 
 * Note: Triangulation test is skipped for now (would require earcut dependency).
 * Self-intersection check + area check should be sufficient for most cases.
 */
export function isRenderValid(ring: Float32Array): RenderValidResult {
  // Check 1: Finite coordinates
  if (!areAllFinite(ring)) {
    return { ok: false, reason: "non_finite" };
  }
  
  // Check 2: At least 3 unique points
  const uniqueCount = countUniquePoints(ring);
  if (uniqueCount < 3) {
    return { ok: false, reason: "too_few_points" };
  }
  
  // Check 3: Non-zero area
  const area = polygonArea(ring);
  if (area < EPS_AREA) {
    return { ok: false, reason: "zero_area" };
  }
  
  // Check 4: Self-intersection
  if (hasSelfIntersection(ring)) {
    return { ok: false, reason: "self_intersect" };
  }
  
  // All checks passed
  return { ok: true };
}
