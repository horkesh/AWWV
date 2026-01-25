/**
 * Shared Geometry Pipeline
 * 
 * Unified SVG parsing and polygon validation logic used by both
 * build_map.ts and report_svg_geometry_failures.ts.
 * 
 * All functions are deterministic and produce stable output.
 */

import { isRenderValid } from './render_valid';

// Constants (must match build_map.ts)
export const COORDINATE_PRECISION = 2;
export const CURVE_SEGMENTS = 10;
export const EPSILON = 1e-6;
export const EPS_COLLINEAR = 1e-3;
export const MAX_HULL_RATIO = 6.0; // Maximum acceptable hull inflation ratio
export const SIMPLIFY_EPSILON = 5.0; // Higher epsilon for simplified ring salvage

// Types
export interface SVGCommand {
  code: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export type DropReason = 
  | "unsupported_arc"
  | "parse_error"
  | "too_few_points"
  | "non_finite"
  | "zero_area"
  | "self_evident_degenerate"
  | "no_closed_subpaths"
  | "render_invalid";

export interface RingStats {
  was_open_originally: boolean;
  closed_by: "Z" | "eps_raw" | "eps_snapped" | null;
  bbox: [number, number, number, number]; // [minx, miny, maxx, maxy]
  raw_point_count: number;
  clean_point_count: number;
}

export interface FinalizeRingResult {
  ring: Float32Array | null;
  stats: RingStats;
  drop_reason: DropReason | null;
}

export interface ChooseRingResult {
  ring: Float32Array | null;
  chosen_subpath_index: number | null;
  subpaths_parsed_count: number;
  subpaths_valid_count: number;
  closure: { was_open_originally: boolean; closed_by: "Z" | "eps_raw" | "eps_snapped" | null } | null;
  drop_reason: DropReason | null;
  salvage_used: "ring" | "ring_simplified_salvage" | "convex_hull_salvage" | "convex_hull_salvage_high_inflation" | null;
  original_ring: Float32Array | null; // Original ring before salvage (for inflation calculation)
  hull_inflation_ratio: number | null; // Area ratio if hull salvage was used
  debug: { invalid_reasons_counts: Record<string, number> };
}

/**
 * Parse SVG path string into commands
 */
function parseSVGPath(pathString: string): SVGCommand[] {
  if (!pathString || !pathString.trim()) return [];
  
  const commands: SVGCommand[] = [];
  const tokens = pathString.trim().replace(/,/g, ' ').split(/\s+/).filter(t => t.length > 0);
  
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const code = token[0].toUpperCase();
    const isRelative = token[0] === token[0].toLowerCase();
    
    let cmd: SVGCommand = { code };
    i++;
    
    switch (code) {
      case 'M':
      case 'L':
      case 'T':
        if (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
          cmd.x = parseFloat(tokens[i++]);
          if (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
            cmd.y = parseFloat(tokens[i++]);
          }
        }
        break;
      case 'H':
        if (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
          cmd.x = parseFloat(tokens[i++]);
        }
        break;
      case 'V':
        if (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
          cmd.y = parseFloat(tokens[i++]);
        }
        break;
      case 'C':
        if (i + 5 < tokens.length) {
          cmd.x1 = parseFloat(tokens[i++]);
          cmd.y1 = parseFloat(tokens[i++]);
          cmd.x2 = parseFloat(tokens[i++]);
          cmd.y2 = parseFloat(tokens[i++]);
          cmd.x = parseFloat(tokens[i++]);
          cmd.y = parseFloat(tokens[i++]);
        }
        break;
      case 'S':
        if (i + 3 < tokens.length) {
          cmd.x2 = parseFloat(tokens[i++]);
          cmd.y2 = parseFloat(tokens[i++]);
          cmd.x = parseFloat(tokens[i++]);
          cmd.y = parseFloat(tokens[i++]);
        }
        break;
      case 'Q':
        if (i + 3 < tokens.length) {
          cmd.x1 = parseFloat(tokens[i++]);
          cmd.y1 = parseFloat(tokens[i++]);
          cmd.x = parseFloat(tokens[i++]);
          cmd.y = parseFloat(tokens[i++]);
        }
        break;
      case 'Z':
        break;
      case 'A':
        // Skip arc parameters (7 numbers)
        while (i < tokens.length && !isNaN(parseFloat(tokens[i])) && i < tokens.length) {
          i++;
        }
        break;
    }
    
    if (code !== 'A' || cmd.code === 'A') {
      commands.push(cmd);
    }
  }
  
  return commands;
}

/**
 * Flatten curve to line segments
 */
function flattenCurve(
  type: 'C' | 'S' | 'Q' | 'T',
  cmd: SVGCommand,
  startX: number,
  startY: number
): number[][] {
  const points: number[][] = [];
  
  if (type === 'C' && cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * mt * startX + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x;
      const y = mt * mt * mt * startY + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y;
      points.push([x, y]);
    }
  } else if (type === 'S' && cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
    const x1 = cmd.x1 !== undefined ? cmd.x1 : startX;
    const y1 = cmd.y1 !== undefined ? cmd.y1 : startY;
    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * mt * startX + 3 * mt * mt * t * x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x;
      const y = mt * mt * mt * startY + 3 * mt * mt * t * y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y;
      points.push([x, y]);
    }
  } else if (type === 'Q' && cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * startX + 2 * mt * t * cmd.x1 + t * t * cmd.x;
      const y = mt * mt * startY + 2 * mt * t * cmd.y1 + t * t * cmd.y;
      points.push([x, y]);
    }
  } else if (type === 'T' && cmd.x !== undefined && cmd.y !== undefined) {
    const x1 = cmd.x1 !== undefined ? cmd.x1 : startX;
    const y1 = cmd.y1 !== undefined ? cmd.y1 : startY;
    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * startX + 2 * mt * t * x1 + t * t * cmd.x;
      const y = mt * mt * startY + 2 * mt * t * y1 + t * t * cmd.y;
      points.push([x, y]);
    }
  }
  
  return points;
}

/**
 * Parse SVG path "d" string to points array
 * Returns Float32Array of [x0, y0, x1, y1, ...]
 * Throws on unsupported arc A/a
 */
export function svgPathToPoints(d: string, segmentsPerCurve: number = CURVE_SEGMENTS): Float32Array {
  if (!d || !d.trim()) {
    throw new Error("Empty path string");
  }
  
  const commands = parseSVGPath(d);
  
  // Check for arc commands
  const hasArc = commands.some(cmd => cmd.code === 'A' || cmd.code === 'a');
  if (hasArc) {
    throw new Error("Unsupported arc command");
  }
  
  const points: number[] = [];
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let hasMove = false;
  
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const isRelative = cmd.code === cmd.code.toLowerCase();
    const code = cmd.code.toUpperCase();
    
    switch (code) {
      case 'M':
        if (cmd.x !== undefined && cmd.y !== undefined) {
          if (isRelative) {
            startX = currentX + cmd.x;
            startY = currentY + cmd.y;
          } else {
            startX = cmd.x;
            startY = cmd.y;
          }
          currentX = startX;
          currentY = startY;
          hasMove = true;
          points.push(startX, startY);
        }
        break;
      case 'L':
        if (cmd.x !== undefined && cmd.y !== undefined) {
          if (isRelative) {
            currentX = currentX + cmd.x;
            currentY = currentY + cmd.y;
          } else {
            currentX = cmd.x;
            currentY = cmd.y;
          }
          points.push(currentX, currentY);
        }
        break;
      case 'H':
        if (cmd.x !== undefined) {
          if (isRelative) {
            currentX = currentX + cmd.x;
          } else {
            currentX = cmd.x;
          }
          points.push(currentX, currentY);
        }
        break;
      case 'V':
        if (cmd.y !== undefined) {
          if (isRelative) {
            currentY = currentY + cmd.y;
          } else {
            currentY = cmd.y;
          }
          points.push(currentX, currentY);
        }
        break;
      case 'C':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x1 = isRelative ? currentX + cmd.x1 : cmd.x1;
          const y1 = isRelative ? currentY + cmd.y1 : cmd.y1;
          const x2 = isRelative ? currentX + cmd.x2 : cmd.x2;
          const y2 = isRelative ? currentY + cmd.y2 : cmd.y2;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'C', x1, y1, x2, y2, x: endX, y: endY };
          const curvePoints = flattenCurve('C', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            points.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'S':
        if (cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x2 = isRelative ? currentX + cmd.x2 : cmd.x2;
          const y2 = isRelative ? currentY + cmd.y2 : cmd.y2;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'S', x1: currentX, y1: currentY, x2, y2, x: endX, y: endY };
          const curvePoints = flattenCurve('S', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            points.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'Q':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x1 = isRelative ? currentX + cmd.x1 : cmd.x1;
          const y1 = isRelative ? currentY + cmd.y1 : cmd.y1;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'Q', x1, y1, x: endX, y: endY };
          const curvePoints = flattenCurve('Q', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            points.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'T':
        if (cmd.x !== undefined && cmd.y !== undefined) {
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'T', x1: currentX, y1: currentY, x: endX, y: endY };
          const curvePoints = flattenCurve('T', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            points.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'Z':
        if (points.length > 0 && hasMove) {
          // Close path - add start point if different
          const lastX = points[points.length - 2];
          const lastY = points[points.length - 1];
          if (lastX !== startX || lastY !== startY) {
            points.push(startX, startY);
          }
        }
        currentX = startX;
        currentY = startY;
        break;
    }
  }
  
  return new Float32Array(points);
}

/**
 * Parse SVG path to multiple subpaths (split on M commands)
 * Returns array of path "d" strings
 * Note: This is a simplified version - the actual parsing happens in svgPathToPoints
 * which handles multiple M commands internally. This function is mainly for
 * diagnostic purposes to identify subpath boundaries.
 */
export function parseSvgToSubpaths(svgPathString: string): string[] {
  if (!svgPathString || !svgPathString.trim()) return [];
  
  // For now, return the full path as a single subpath
  // The actual subpath splitting is handled in chooseSettlementRing
  // which calls svgPathToPoints for each potential subpath
  return [svgPathString];
}

/**
 * Convert commands back to path string (simplified)
 */
function commandsToPathString(commands: SVGCommand[]): string {
  const parts: string[] = [];
  for (const cmd of commands) {
    parts.push(cmd.code);
    if (cmd.x !== undefined && cmd.y !== undefined) {
      parts.push(cmd.x.toString(), cmd.y.toString());
    } else if (cmd.x !== undefined) {
      parts.push(cmd.x.toString());
    } else if (cmd.y !== undefined) {
      parts.push(cmd.y.toString());
    }
    if (cmd.x1 !== undefined && cmd.y1 !== undefined) {
      parts.push(cmd.x1.toString(), cmd.y1.toString());
    }
    if (cmd.x2 !== undefined && cmd.y2 !== undefined) {
      parts.push(cmd.x2.toString(), cmd.y2.toString());
    }
  }
  return parts.join(' ');
}

/**
 * Calculate polygon area using shoelace formula
 */
function polygonArea(coords: Float32Array): number {
  if (coords.length < 6) return 0; // Need at least 3 points (6 values)
  let area = 0;
  for (let i = 0; i < coords.length - 2; i += 2) {
    const x1 = coords[i];
    const y1 = coords[i + 1];
    const x2 = coords[i + 2];
    const y2 = coords[i + 3];
    area += x1 * y2;
    area -= x2 * y1;
  }
  // Close the polygon
  const x1 = coords[coords.length - 2];
  const y1 = coords[coords.length - 1];
  const x2 = coords[0];
  const y2 = coords[1];
  area += x1 * y2;
  area -= x2 * y1;
  return Math.abs(area) / 2;
}

/**
 * Remove duplicate consecutive points
 */
function removeDuplicatePoints(coords: Float32Array): Float32Array {
  if (coords.length === 0) return coords;
  const result: number[] = [coords[0], coords[1]];
  for (let i = 2; i < coords.length; i += 2) {
    const prevX = result[result.length - 2];
    const prevY = result[result.length - 1];
    const currX = coords[i];
    const currY = coords[i + 1];
    if (prevX !== currX || prevY !== currY) {
      result.push(currX, currY);
    }
  }
  return new Float32Array(result);
}

/**
 * Remove collinear points
 */
function removeCollinearPoints(coords: Float32Array, epsilon: number = EPS_COLLINEAR): Float32Array {
  if (coords.length < 6) return coords; // Need at least 3 points
  const result: number[] = [coords[0], coords[1]];
  
  for (let i = 2; i < coords.length - 2; i += 2) {
    const p0x = coords[i - 2];
    const p0y = coords[i - 1];
    const p1x = coords[i];
    const p1y = coords[i + 1];
    const p2x = coords[i + 2];
    const p2y = coords[i + 3];
    
    const area = (p1x - p0x) * (p2y - p0y) - (p2x - p0x) * (p1y - p0y);
    
    const dx1 = p1x - p0x;
    const dy1 = p1y - p0y;
    const dx2 = p2x - p1x;
    const dy2 = p2y - p1y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    
    const minLen = Math.min(len1, len2);
    const areaThreshold = minLen < 1.0 ? epsilon * 0.1 : epsilon;
    
    if (Math.abs(area) > areaThreshold) {
      result.push(p1x, p1y);
    }
  }
  
  if (coords.length >= 4) {
    result.push(coords[coords.length - 2], coords[coords.length - 1]);
  }
  
  return new Float32Array(result);
}

/**
 * Simplify ring with higher epsilon (for salvage)
 */
function simplifyRing(ring: Float32Array): Float32Array | null {
  if (ring.length < 6) return null;
  
  // Remove duplicates
  let cleaned = removeDuplicatePoints(ring);
  if (cleaned.length < 6) return null;
  
  // Remove collinear points with higher epsilon
  cleaned = removeCollinearPoints(cleaned, SIMPLIFY_EPSILON);
  if (cleaned.length < 6) return null;
  
  // Ensure closed
  const firstX = cleaned[0];
  const firstY = cleaned[1];
  const lastX = cleaned[cleaned.length - 2];
  const lastY = cleaned[cleaned.length - 1];
  if (firstX !== lastX || firstY !== lastY) {
    const closed = new Float32Array(cleaned.length + 2);
    closed.set(cleaned);
    closed[cleaned.length] = firstX;
    closed[cleaned.length + 1] = firstY;
    cleaned = closed;
  }
  
  return cleaned;
}

/**
 * Snap coordinates to precision
 */
function snapCoordinates(coords: Float32Array): Float32Array {
  const result = new Float32Array(coords.length);
  const factor = Math.pow(10, COORDINATE_PRECISION);
  for (let i = 0; i < coords.length; i++) {
    result[i] = Math.round(coords[i] * factor) / factor;
  }
  return result;
}

/**
 * Finalize ring: clean, validate, and close
 */
export function finalizeRing(rawPts: Float32Array, hadZCommand: boolean = false): FinalizeRingResult {
  const rawPointCount = rawPts.length / 2;
  
  if (rawPts.length < 6) {
    return {
      ring: null,
      stats: {
        was_open_originally: true,
        closed_by: null,
        bbox: [0, 0, 0, 0],
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "too_few_points"
    };
  }
  
  // Step 1: Remove duplicates
  let cleaned = removeDuplicatePoints(rawPts);
  if (cleaned.length < 6) {
    return {
      ring: null,
      stats: {
        was_open_originally: true,
        closed_by: null,
        bbox: [0, 0, 0, 0],
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "too_few_points"
    };
  }
  
  // Step 2: Compute bbox and scale-aware eps_close
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < cleaned.length; i += 2) {
    minX = Math.min(minX, cleaned[i]);
    minY = Math.min(minY, cleaned[i + 1]);
    maxX = Math.max(maxX, cleaned[i]);
    maxY = Math.max(maxY, cleaned[i + 1]);
  }
  const bbox: [number, number, number, number] = [minX, minY, maxX, maxY];
  const bboxDiag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const epsClose = Math.max(0.5, Math.min(8.0, bboxDiag * 0.01));
  
  // Step 3: Check closure
  const firstX = cleaned[0];
  const firstY = cleaned[1];
  const lastX = cleaned[cleaned.length - 2];
  const lastY = cleaned[cleaned.length - 1];
  const dx = lastX - firstX;
  const dy = lastY - firstY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  const wasOpenOriginally = dist > EPSILON;
  let closedBy: "Z" | "eps_raw" | "eps_snapped" | null = null;
  
  if (hadZCommand && dist <= EPSILON) {
    closedBy = "Z";
  } else if (dist < epsClose && dist > EPSILON) {
    // Auto-close if within threshold (raw)
    cleaned[cleaned.length - 2] = firstX;
    cleaned[cleaned.length - 1] = firstY;
    closedBy = "eps_raw";
  } else if (dist > EPSILON) {
    // Not closed, add closing point
    const closed = new Float32Array(cleaned.length + 2);
    closed.set(cleaned);
    closed[cleaned.length] = firstX;
    closed[cleaned.length + 1] = firstY;
    cleaned = closed;
  } else {
    closedBy = "Z"; // Already closed
  }
  
  // Step 4: Remove collinear points
  cleaned = removeCollinearPoints(cleaned, EPS_COLLINEAR);
  if (cleaned.length < 6) {
    return {
      ring: null,
      stats: {
        was_open_originally: wasOpenOriginally,
        closed_by: closedBy,
        bbox,
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "too_few_points"
    };
  }
  
  // Step 5: Validate area before snapping
  const areaBeforeSnap = polygonArea(cleaned);
  if (areaBeforeSnap <= 0 || !isFinite(areaBeforeSnap)) {
    return {
      ring: null,
      stats: {
        was_open_originally: wasOpenOriginally,
        closed_by: closedBy,
        bbox,
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "zero_area"
    };
  }
  
  // Step 6: Snap to precision
  cleaned = snapCoordinates(cleaned);
  
  // Step 7: Re-check closure after snapping (implicit closure)
  if (closedBy !== "Z" && closedBy !== "eps_raw") {
    const firstSnappedX = cleaned[0];
    const firstSnappedY = cleaned[1];
    const lastSnappedX = cleaned[cleaned.length - 2];
    const lastSnappedY = cleaned[cleaned.length - 1];
    const dxSnapped = lastSnappedX - firstSnappedX;
    const dySnapped = lastSnappedY - firstSnappedY;
    const distSnapped = Math.sqrt(dxSnapped * dxSnapped + dySnapped * dySnapped);
    
    if (distSnapped < epsClose && distSnapped > EPSILON) {
      // Now closable after snapping
      cleaned[cleaned.length - 2] = firstSnappedX;
      cleaned[cleaned.length - 1] = firstSnappedY;
      closedBy = "eps_snapped";
    }
  }
  
  // Ensure still closed after snapping
  if (cleaned.length > 0) {
    const first = cleaned[0];
    const firstY = cleaned[1];
    const last = cleaned[cleaned.length - 2];
    const lastY = cleaned[cleaned.length - 1];
    if (first !== last || firstY !== lastY) {
      cleaned[cleaned.length - 2] = first;
      cleaned[cleaned.length - 1] = firstY;
    }
  }
  
  // Validate: at least 3 unique vertices
  const unique = new Set<string>();
  for (let i = 0; i < cleaned.length; i += 2) {
    unique.add(`${cleaned[i]},${cleaned[i + 1]}`);
  }
  if (unique.size < 3) {
    return {
      ring: null,
      stats: {
        was_open_originally: wasOpenOriginally,
        closed_by: closedBy,
        bbox,
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "self_evident_degenerate"
    };
  }
  
  // Validate: all finite
  for (let i = 0; i < cleaned.length; i++) {
    if (!isFinite(cleaned[i]) || isNaN(cleaned[i])) {
      return {
        ring: null,
        stats: {
          was_open_originally: wasOpenOriginally,
          closed_by: closedBy,
          bbox,
          raw_point_count: rawPointCount,
          clean_point_count: 0
        },
        drop_reason: "non_finite"
      };
    }
  }
  
  // Validate: non-zero area after snapping
  const area = polygonArea(cleaned);
  if (area <= 0 || !isFinite(area)) {
    return {
      ring: null,
      stats: {
        was_open_originally: wasOpenOriginally,
        closed_by: closedBy,
        bbox,
        raw_point_count: rawPointCount,
        clean_point_count: 0
      },
      drop_reason: "zero_area"
    };
  }
  
  return {
    ring: cleaned,
    stats: {
      was_open_originally: wasOpenOriginally,
      closed_by: closedBy,
      bbox,
      raw_point_count: rawPointCount,
      clean_point_count: cleaned.length / 2
    },
    drop_reason: null
  };
}

/**
 * Parse SVG path to multiple raw point arrays (handles multi-path)
 * Returns array of Float32Array, one per subpath (split on M or Z)
 */
function parseSVGPathToRawPolygons(svgPath: string): Array<{ points: Float32Array; hadZ: boolean }> {
  if (!svgPath || !svgPath.trim()) return [];
  
  const commands = parseSVGPath(svgPath);
  if (commands.length === 0) return [];
  
  // Check for arc commands
  const hasArc = commands.some(cmd => cmd.code === 'A' || cmd.code === 'a');
  if (hasArc) {
    return []; // Return empty, will be handled as unsupported_arc
  }
  
  const polygons: Array<{ points: Float32Array; hadZ: boolean }> = [];
  let currentPoints: number[] = [];
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let hasMove = false;
  let hadZ = false;
  
  // Process commands and convert to points
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const isRelative = cmd.code === cmd.code.toLowerCase();
    const code = cmd.code.toUpperCase();
    
    switch (code) {
      case 'M':
        if (hasMove && currentPoints.length > 0) {
          // Close previous polygon
          if (currentPoints.length > 0) {
            const lastX = currentPoints[currentPoints.length - 2];
            const lastY = currentPoints[currentPoints.length - 1];
            if (lastX !== startX || lastY !== startY) {
              currentPoints.push(startX, startY);
            }
          }
          if (currentPoints.length >= 6) { // At least 3 points (6 values)
            polygons.push({ points: new Float32Array(currentPoints), hadZ });
          }
          currentPoints = [];
          hadZ = false;
        }
        if (cmd.x !== undefined && cmd.y !== undefined) {
          if (isRelative) {
            startX = currentX + cmd.x;
            startY = currentY + cmd.y;
          } else {
            startX = cmd.x;
            startY = cmd.y;
          }
          currentX = startX;
          currentY = startY;
          hasMove = true;
          currentPoints.push(startX, startY);
        }
        break;
      case 'L':
        if (cmd.x !== undefined && cmd.y !== undefined) {
          if (isRelative) {
            currentX = currentX + cmd.x;
            currentY = currentY + cmd.y;
          } else {
            currentX = cmd.x;
            currentY = cmd.y;
          }
          currentPoints.push(currentX, currentY);
        }
        break;
      case 'H':
        if (cmd.x !== undefined) {
          if (isRelative) {
            currentX = currentX + cmd.x;
          } else {
            currentX = cmd.x;
          }
          currentPoints.push(currentX, currentY);
        }
        break;
      case 'V':
        if (cmd.y !== undefined) {
          if (isRelative) {
            currentY = currentY + cmd.y;
          } else {
            currentY = cmd.y;
          }
          currentPoints.push(currentX, currentY);
        }
        break;
      case 'C':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x1 = isRelative ? currentX + cmd.x1 : cmd.x1;
          const y1 = isRelative ? currentY + cmd.y1 : cmd.y1;
          const x2 = isRelative ? currentX + cmd.x2 : cmd.x2;
          const y2 = isRelative ? currentY + cmd.y2 : cmd.y2;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'C', x1, y1, x2, y2, x: endX, y: endY };
          const curvePoints = flattenCurve('C', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            currentPoints.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'S':
        if (cmd.x2 !== undefined && cmd.y2 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x2 = isRelative ? currentX + cmd.x2 : cmd.x2;
          const y2 = isRelative ? currentY + cmd.y2 : cmd.y2;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'S', x1: currentX, y1: currentY, x2, y2, x: endX, y: endY };
          const curvePoints = flattenCurve('S', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            currentPoints.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'Q':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x !== undefined && cmd.y !== undefined) {
          const x1 = isRelative ? currentX + cmd.x1 : cmd.x1;
          const y1 = isRelative ? currentY + cmd.y1 : cmd.y1;
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'Q', x1, y1, x: endX, y: endY };
          const curvePoints = flattenCurve('Q', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            currentPoints.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'T':
        if (cmd.x !== undefined && cmd.y !== undefined) {
          const endX = isRelative ? currentX + cmd.x : cmd.x;
          const endY = isRelative ? currentY + cmd.y : cmd.y;
          
          const curveCmd: SVGCommand = { code: 'T', x1: currentX, y1: currentY, x: endX, y: endY };
          const curvePoints = flattenCurve('T', curveCmd, currentX, currentY);
          for (let j = 1; j < curvePoints.length; j++) {
            currentPoints.push(curvePoints[j][0], curvePoints[j][1]);
          }
          if (curvePoints.length > 0) {
            const last = curvePoints[curvePoints.length - 1];
            currentX = last[0];
            currentY = last[1];
          }
        }
        break;
      case 'Z':
        hadZ = true;
        if (currentPoints.length > 0) {
          const lastX = currentPoints[currentPoints.length - 2];
          const lastY = currentPoints[currentPoints.length - 1];
          if (lastX !== startX || lastY !== startY) {
            currentPoints.push(startX, startY);
          }
        }
        if (currentPoints.length >= 6) {
          polygons.push({ points: new Float32Array(currentPoints), hadZ: true });
        }
        currentPoints = [];
        hadZ = false;
        currentX = startX;
        currentY = startY;
        break;
    }
  }
  
  // Close last polygon if not closed
  if (currentPoints.length > 0) {
    const lastX = currentPoints[currentPoints.length - 2];
    const lastY = currentPoints[currentPoints.length - 1];
    if (lastX !== startX || lastY !== startY) {
      currentPoints.push(startX, startY);
    }
    if (currentPoints.length >= 6) {
      polygons.push({ points: new Float32Array(currentPoints), hadZ });
    }
  }
  
  return polygons;
}

/**
 * Compute convex hull of points (monotonic chain algorithm)
 * Returns closed ring as Float32Array, or null if insufficient points
 */
function computeConvexHull(ring: Float32Array): Float32Array | null {
  if (ring.length < 6) return null; // Need at least 3 points
  
  // Extract unique points
  const points: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i];
    const y = ring[i + 1];
    const key = `${x},${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      points.push([x, y]);
    }
  }
  
  if (points.length < 3) return null;
  
  // Sort points by x, then y
  points.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });
  
  // Cross product for orientation
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  };
  
  // Build lower hull
  const lower: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) {
      lower.pop();
    }
    lower.push(points[i]);
  }
  
  // Build upper hull
  const upper: Array<[number, number]> = [];
  for (let i = points.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) {
      upper.pop();
    }
    upper.push(points[i]);
  }
  
  // Remove duplicates at ends
  lower.pop();
  upper.pop();
  
  // Combine hulls
  const hull = lower.concat(upper);
  
  if (hull.length < 3) return null;
  
  // Close the ring
  const result = new Float32Array((hull.length + 1) * 2);
  for (let i = 0; i < hull.length; i++) {
    result[i * 2] = hull[i][0];
    result[i * 2 + 1] = hull[i][1];
  }
  // Close by repeating first point
  result[hull.length * 2] = hull[0][0];
  result[hull.length * 2 + 1] = hull[0][1];
  
  return result;
}

/**
 * Choose settlement ring from SVG path
 * Parses all subpaths, finalizes each, chooses largest area
 * Uses render-valid as primary gate, with convex hull salvage if needed
 */
export function chooseSettlementRing(svg_path_string: string): ChooseRingResult {
  if (!svg_path_string || !svg_path_string.trim()) {
    return {
      ring: null,
      chosen_subpath_index: null,
      subpaths_parsed_count: 0,
      subpaths_valid_count: 0,
      closure: null,
      drop_reason: "no_closed_subpaths",
      salvage_used: null,
      debug: { invalid_reasons_counts: {} }
    };
  }
  
  // Check for arc commands first
  try {
    const commands = parseSVGPath(svg_path_string);
    const hasArc = commands.some(cmd => cmd.code === 'A' || cmd.code === 'a');
    if (hasArc) {
      return {
        ring: null,
        chosen_subpath_index: null,
        subpaths_parsed_count: 0,
        subpaths_valid_count: 0,
        closure: null,
        drop_reason: "unsupported_arc",
        salvage_used: null,
        original_ring: null,
        hull_inflation_ratio: null,
        debug: { invalid_reasons_counts: {} }
      };
    }
  } catch (err) {
    return {
      ring: null,
      chosen_subpath_index: null,
      subpaths_parsed_count: 0,
      subpaths_valid_count: 0,
      closure: null,
      drop_reason: "parse_error",
      salvage_used: null,
      original_ring: null,
      hull_inflation_ratio: null,
      debug: { invalid_reasons_counts: {} }
    };
  }
  
  // Parse to raw polygons (subpaths)
  const rawPolygons = parseSVGPathToRawPolygons(svg_path_string);
  const subpathsParsedCount = rawPolygons.length;
  
  if (rawPolygons.length === 0) {
    return {
      ring: null,
      chosen_subpath_index: null,
      subpaths_parsed_count: 0,
      subpaths_valid_count: 0,
      closure: null,
      drop_reason: "no_closed_subpaths",
      salvage_used: null,
      debug: { invalid_reasons_counts: {} }
    };
  }
  
  // Process each subpath
  const validRings: Array<{ ring: Float32Array; area: number; index: number; closure: { was_open_originally: boolean; closed_by: "Z" | "eps_raw" | "eps_snapped" | null }; stats: RingStats }> = [];
  const invalidReasonsCounts: Record<string, number> = {};
  
  for (let i = 0; i < rawPolygons.length; i++) {
    const { points, hadZ } = rawPolygons[i];
    const result = finalizeRing(points, hadZ);
    
    if (result.ring) {
      const area = polygonArea(result.ring);
      validRings.push({
        ring: result.ring,
        area: Math.abs(area),
        index: i,
        closure: {
          was_open_originally: result.stats.was_open_originally,
          closed_by: result.stats.closed_by
        },
        stats: result.stats
      });
    } else {
      const reason = result.drop_reason || "self_evident_degenerate";
      invalidReasonsCounts[reason] = (invalidReasonsCounts[reason] || 0) + 1;
    }
  }
  
  const subpathsValidCount = validRings.length;
  
  if (validRings.length === 0) {
    // Find most common reason
    let mostCommonReason: DropReason = "no_closed_subpaths";
    let maxCount = 0;
    for (const [reason, count] of Object.entries(invalidReasonsCounts)) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonReason = reason as DropReason;
      }
    }
    
    return {
      ring: null,
      chosen_subpath_index: null,
      subpaths_parsed_count: subpathsParsedCount,
      subpaths_valid_count: 0,
      closure: null,
      drop_reason: mostCommonReason,
      salvage_used: null,
      original_ring: null,
      hull_inflation_ratio: null,
      debug: { invalid_reasons_counts: invalidReasonsCounts }
    };
  }
  
  // Choose largest area ring
  let largestArea = 0;
  let chosenRing: Float32Array | null = null;
  let chosenIndex = -1;
  let chosenClosure: { was_open_originally: boolean; closed_by: "Z" | "eps_raw" | "eps_snapped" | null } | null = null;
  
  for (const { ring, area, index, closure } of validRings) {
    if (area > largestArea) {
      largestArea = area;
      chosenRing = ring;
      chosenIndex = index;
      chosenClosure = closure;
    }
  }
  
  // Store original ring for inflation calculation
  const originalRing = chosenRing ? new Float32Array(chosenRing) : null;
  
  // Check render-valid on chosen ring
  if (chosenRing) {
    const renderValid = isRenderValid(chosenRing);
    if (renderValid.ok) {
      // Ring is render-valid, accept it
      return {
        ring: chosenRing,
        chosen_subpath_index: chosenIndex,
        subpaths_parsed_count: subpathsParsedCount,
        subpaths_valid_count: subpathsValidCount,
        closure: chosenClosure,
        drop_reason: null,
        salvage_used: "ring",
        original_ring: null,
        hull_inflation_ratio: null,
        debug: { invalid_reasons_counts: invalidReasonsCounts }
      };
    }
    
    // Ring is not render-valid, attempt salvage
    // First try simplified ring salvage
    const simplifiedRing = simplifyRing(chosenRing);
    if (simplifiedRing) {
      const simplifiedValid = isRenderValid(simplifiedRing);
      if (simplifiedValid.ok) {
        // Simplified ring is render-valid, accept it
        return {
          ring: simplifiedRing,
          chosen_subpath_index: chosenIndex,
          subpaths_parsed_count: subpathsParsedCount,
          subpaths_valid_count: subpathsValidCount,
          closure: chosenClosure,
          drop_reason: null,
          salvage_used: "ring_simplified_salvage",
          original_ring: originalRing,
          hull_inflation_ratio: null,
          debug: { invalid_reasons_counts: invalidReasonsCounts }
        };
      }
    }
    
    // Simplified ring failed or not possible, try convex hull salvage
    const hull = computeConvexHull(chosenRing);
    if (hull) {
      const hullValid = isRenderValid(hull);
      if (hullValid.ok) {
        // Compute area ratio for inflation check
        const origArea = polygonArea(chosenRing);
        const hullArea = polygonArea(hull);
        const areaRatio = hullArea / Math.max(origArea, 1e-6);
        
        // Determine salvage type based on inflation
        let salvageType: "convex_hull_salvage" | "convex_hull_salvage_high_inflation";
        if (areaRatio <= MAX_HULL_RATIO) {
          salvageType = "convex_hull_salvage";
        } else {
          salvageType = "convex_hull_salvage_high_inflation";
        }
        
        // Hull is render-valid, accept it (even if high inflation)
        return {
          ring: hull,
          chosen_subpath_index: chosenIndex,
          subpaths_parsed_count: subpathsParsedCount,
          subpaths_valid_count: subpathsValidCount,
          closure: chosenClosure,
          drop_reason: null,
          salvage_used: salvageType,
          original_ring: originalRing,
          hull_inflation_ratio: areaRatio,
          debug: { invalid_reasons_counts: invalidReasonsCounts }
        };
      }
    }
    
    // Both simplified and hull failed render-valid, drop
    return {
      ring: null,
      chosen_subpath_index: null,
      subpaths_parsed_count: subpathsParsedCount,
      subpaths_valid_count: subpathsValidCount,
      closure: null,
      drop_reason: "render_invalid",
      salvage_used: null,
      original_ring: originalRing,
      hull_inflation_ratio: null,
      debug: { invalid_reasons_counts: invalidReasonsCounts }
    };
  }
  
  // No ring chosen (shouldn't happen, but handle gracefully)
  return {
    ring: null,
    chosen_subpath_index: null,
    subpaths_parsed_count: subpathsParsedCount,
    subpaths_valid_count: subpathsValidCount,
    closure: null,
    drop_reason: "no_closed_subpaths",
    salvage_used: null,
    original_ring: null,
    hull_inflation_ratio: null,
    debug: { invalid_reasons_counts: invalidReasonsCounts }
  };
}

/**
 * Convert Float32Array ring to number[][] for GeoJSON
 */
export function ringToCoords(ring: Float32Array): number[][] {
  const coords: number[][] = [];
  for (let i = 0; i < ring.length; i += 2) {
    coords.push([ring[i], ring[i + 1]]);
  }
  return coords;
}
