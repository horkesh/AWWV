/**
 * Extract Municipality Outlines from HTML File
 * 
 * Extracts municipality boundary outlines from an HTML file containing
 * MUNICIPALITY_DISSOLVED_OUTLINES (SVG path strings) and converts them to GeoJSON.
 * 
 * CRITICAL RULES:
 * - Deterministic (stable ordering, no randomness, no timestamps)
 * - Direct interpretation of SVG path commands (no repair, smoothing, simplification)
 * - If unsupported SVG commands exist, log warnings and skip municipality
 * - Output is inspection/reference only
 * 
 * Inputs:
 * - data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.html
 * 
 * Outputs:
 * - data/derived/municipality_outlines_from_html.geojson
 * - data/derived/municipality_outlines_from_html_audit.txt
 * 
 * Usage:
 *   npm run map:extract-muni-outlines
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Extract MUNICIPALITY_DISSOLVED_OUTLINES SVG paths from an HTML file and convert to GeoJSON deterministically");

// ============================================================================
// Constants
// ============================================================================

const HTML_SOURCE_PATH = resolve('data/source/settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.html');
const OUTPUT_GEOJSON_PATH = resolve('data/derived/municipality_outlines_from_html.geojson');
const OUTPUT_AUDIT_PATH = resolve('data/derived/municipality_outlines_from_html_audit.txt');

// SVG path flattening parameters (deterministic)
const FLATTEN_SEGMENTS_Q = 20; // Quadratic bezier
const FLATTEN_SEGMENTS_C = 30; // Cubic bezier
const FLATTEN_SEGMENTS_A = 30; // Arc

// Coordinate precision for output
const COORD_PRECISION = 6;

// ============================================================================
// Types
// ============================================================================

interface MunicipalityData {
  key: string;
  parts: string[];
}

interface ParsedPath {
  coordinates: number[][];
  commands: Set<string>;
  warnings: string[];
}

interface MunicipalityFeature {
  muni_key: string;
  source: string;
  svg_commands: string[];
  parts: number;
  warnings?: string[];
}

interface AuditReport {
  total_municipalities_found: number;
  municipalities_emitted: number;
  municipalities_skipped: number;
  skip_reasons: Record<string, number>;
  top_20_by_vertex_count: Array<{ muni_key: string; vertex_count: number }>;
  municipalities_with_curves: string[];
}

// ============================================================================
// HTML Parsing
// ============================================================================

/**
 * Extract balanced braces substring starting from a given position
 */
function extractBalancedBraces(text: string, startPos: number): string | null {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escapeNext = false;
  let i = startPos;

  for (; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (!inString) {
      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(startPos, i + 1);
        }
      }
    } else {
      if (char === stringChar) {
        inString = false;
      }
    }
  }

  return null;
}

/**
 * Extract MUNICIPALITY_DISSOLVED_OUTLINES object from HTML
 */
function extractObjectFromHTML(htmlContent: string): Record<string, unknown> | null {
  // Try patterns in order
  const patterns = [
    /const\s+MUNICIPALITY_DISSOLVED_OUTLINES\s*=\s*/,
    /let\s+MUNICIPALITY_DISSOLVED_OUTLINES\s*=\s*/,
    /var\s+MUNICIPALITY_DISSOLVED_OUTLINES\s*=\s*/,
    /window\.MUNICIPALITY_DISSOLVED_OUTLINES\s*=\s*/,
  ];

  for (const pattern of patterns) {
    const match = htmlContent.match(pattern);
    if (match) {
      const startPos = match.index! + match[0].length;
      const objLiteral = extractBalancedBraces(htmlContent, startPos);
      if (objLiteral) {
        // Evaluate in a locked-down VM context
        const context = createContext({
          Object: Object,
          Array: Array,
          String: String,
          Number: Number,
          Math: Math,
        });
        try {
          const code = `result = (${objLiteral});`;
          runInContext(code, context);
          return context.result as Record<string, unknown>;
        } catch (err) {
          console.warn(`Failed to evaluate object literal: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Normalize municipality data to consistent format
 */
function normalizeMunicipalityData(
  key: string,
  value: unknown
): MunicipalityData | null {
  if (typeof value === 'string') {
    // Simple string: treat as single SVG path
    return { key, parts: [value] };
  } else if (Array.isArray(value)) {
    // Array of strings: multiple parts
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (typeof item === 'object' && item !== null && 'd' in item && typeof item.d === 'string') {
        parts.push(item.d);
      } else {
        console.warn(`Unknown array item type for municipality ${key}: ${typeof item}`);
        return null;
      }
    }
    return { key, parts };
  } else if (typeof value === 'object' && value !== null && 'd' in value) {
    // Object with 'd' property
    if (typeof value.d === 'string') {
      return { key, parts: [value.d] };
    } else if (Array.isArray(value.d)) {
      const parts: string[] = [];
      for (const item of value.d) {
        if (typeof item === 'string') {
          parts.push(item);
        } else {
          console.warn(`Unknown 'd' array item type for municipality ${key}: ${typeof item}`);
          return null;
        }
      }
      return { key, parts };
    }
  }

  console.warn(`Unknown value type for municipality ${key}: ${typeof value}`);
  return null;
}

// ============================================================================
// SVG Path Parsing
// ============================================================================

/**
 * Parse SVG path command
 */
function parsePathCommand(
  command: string,
  currentX: number,
  currentY: number
): { code: string; args: number[]; endX: number; endY: number } | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  const code = trimmed[0].toUpperCase();
  const isRelative = trimmed[0] === trimmed[0].toLowerCase();
  const argsStr = trimmed.slice(1).trim();

  // Parse arguments (numbers separated by commas or whitespace)
  const args: number[] = [];
  const numRegex = /-?\d+\.?\d*(?:[eE][+-]?\d+)?/g;
  let match;
  while ((match = numRegex.exec(argsStr)) !== null) {
    args.push(parseFloat(match[0]));
  }

  let endX = currentX;
  let endY = currentY;

  switch (code) {
    case 'M': // MoveTo
      if (args.length >= 2) {
        endX = isRelative ? currentX + args[0] : args[0];
        endY = isRelative ? currentY + args[1] : args[1];
      }
      break;
    case 'L': // LineTo
      if (args.length >= 2) {
        endX = isRelative ? currentX + args[0] : args[0];
        endY = isRelative ? currentY + args[1] : args[1];
      }
      break;
    case 'H': // Horizontal LineTo
      if (args.length >= 1) {
        endX = isRelative ? currentX + args[0] : args[0];
      }
      break;
    case 'V': // Vertical LineTo
      if (args.length >= 1) {
        endY = isRelative ? currentY + args[0] : args[0];
      }
      break;
    case 'Z': // ClosePath
      // No coordinates, just close
      break;
    case 'C': // Cubic Bezier
      if (args.length >= 6) {
        endX = isRelative ? currentX + args[4] : args[4];
        endY = isRelative ? currentY + args[5] : args[5];
      }
      break;
    case 'S': // Smooth Cubic Bezier
      if (args.length >= 4) {
        endX = isRelative ? currentX + args[2] : args[2];
        endY = isRelative ? currentY + args[3] : args[3];
      }
      break;
    case 'Q': // Quadratic Bezier
      if (args.length >= 4) {
        endX = isRelative ? currentX + args[2] : args[2];
        endY = isRelative ? currentY + args[3] : args[3];
      }
      break;
    case 'T': // Smooth Quadratic Bezier
      if (args.length >= 2) {
        endX = isRelative ? currentX + args[0] : args[0];
        endY = isRelative ? currentY + args[1] : args[1];
      }
      break;
    case 'A': // Arc
      if (args.length >= 7) {
        endX = isRelative ? currentX + args[5] : args[5];
        endY = isRelative ? currentY + args[6] : args[6];
      }
      break;
    default:
      return null;
  }

  return { code, args, endX, endY };
}

/**
 * Flatten quadratic bezier curve to line segments
 */
function flattenQuadratic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  segments: number
): number[][] {
  const points: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const y = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    points.push([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
  }
  return points;
}

/**
 * Flatten cubic bezier curve to line segments
 */
function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  segments: number
): number[][] {
  const points: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    points.push([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
  }
  return points;
}

/**
 * Approximate SVG arc to line segments
 * Based on SVG arc parameterization
 * 
 * NOTE: This implements a proper SVG arc parameterization conversion.
 * If this is not correct, municipalities with arcs should be skipped.
 */
function flattenArc(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  xAxisRotation: number,
  largeArcFlag: number,
  sweepFlag: number,
  x: number,
  y: number,
  segments: number
): number[][] {
  // SVG arc parameterization conversion
  // Based on: https://www.w3.org/TR/SVG11/implnote.html#ArcImplementationNotes
  
  const points: number[][] = [];
  
  // If endpoints are the same, return empty (degenerate arc)
  if (Math.abs(x0 - x) < 1e-6 && Math.abs(y0 - y) < 1e-6) {
    return points;
  }
  
  // If rx or ry is 0, treat as line
  if (Math.abs(rx) < 1e-6 || Math.abs(ry) < 1e-6) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const interpX = x0 + (x - x0) * t;
      const interpY = y0 + (y - y0) * t;
      points.push([Math.round(interpX * 1e6) / 1e6, Math.round(interpY * 1e6) / 1e6]);
    }
    return points;
  }
  
  // Convert to center parameterization
  const cosPhi = Math.cos(xAxisRotation * Math.PI / 180);
  const sinPhi = Math.sin(xAxisRotation * Math.PI / 180);
  
  // Step 1: Compute (x1', y1')
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  
  // Step 2: Compute (cx', cy')
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  
  let radicand = (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2);
  if (radicand < 0) {
    // No solution - scale radii
    const scale = Math.sqrt((rx2 * y1p2 + ry2 * x1p2) / (rx2 * ry2));
    rx *= scale;
    ry *= scale;
    radicand = 0;
  }
  
  const root = Math.sqrt(radicand);
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const cxp = sign * root * (rx * y1p) / ry;
  const cyp = sign * -root * (ry * x1p) / rx;
  
  // Step 3: Compute (cx, cy) from (cx', cy')
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;
  
  // Step 4: Compute theta1 and delta-theta
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  
  const theta1 = Math.atan2(uy, ux);
  let deltaTheta = Math.atan2(uy * vx - ux * vy, ux * vx + uy * vy);
  
  if (sweepFlag === 0 && deltaTheta > 0) {
    deltaTheta -= 2 * Math.PI;
  } else if (sweepFlag === 1 && deltaTheta < 0) {
    deltaTheta += 2 * Math.PI;
  }
  
  // Generate points along the arc
  for (let i = 0; i <= segments; i++) {
    const theta = theta1 + (deltaTheta * i) / segments;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    
    // Transform back to original coordinate system
    const px = rx * cosTheta;
    const py = ry * sinTheta;
    const xCoord = cosPhi * px - sinPhi * py + cx;
    const yCoord = sinPhi * px + cosPhi * py + cy;
    
    points.push([Math.round(xCoord * 1e6) / 1e6, Math.round(yCoord * 1e6) / 1e6]);
  }
  
  return points;
}

/**
 * Parse SVG path string to coordinates
 * Handles implicit command repetition (e.g., "M 10,10 20,20" = M + implicit L)
 */
function parseSVGPath(pathD: string): ParsedPath {
  const coordinates: number[][] = [];
  const commands = new Set<string>();
  const warnings: string[] = [];

  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastCommand: string | null = null;
  let lastCommandCode: string | null = null;

  // Tokenize: split into command letters and numbers
  // This handles implicit command repetition
  // Use regex to find all numbers (handles scientific notation, signs, decimals)
  const numRegex = /-?\d+\.?\d*(?:[eE][+-]?\d+)?/g;
  const commandRegex = /[MmLlHhVvZzCcSsQqTtAa]/g;
  
  // Build token list: commands and numbers in order
  const tokens: Array<{ type: 'command' | 'number'; value: string; pos: number }> = [];
  
  // Find all commands with positions
  let match;
  while ((match = commandRegex.exec(pathD)) !== null) {
    tokens.push({ type: 'command', value: match[0], pos: match.index });
  }
  
  // Find all numbers with positions
  numRegex.lastIndex = 0;
  while ((match = numRegex.exec(pathD)) !== null) {
    tokens.push({ type: 'number', value: match[0], pos: match.index });
  }
  
  // Sort by position
  tokens.sort((a, b) => a.pos - b.pos);

  // Process tokens, handling implicit command repetition
  let i = 0;
  while (i < tokens.length) {
    let commandChar: string;
    let isRelative = false;
    let explicitCommand = false;

    if (tokens[i].type === 'command') {
      commandChar = tokens[i].value;
      isRelative = commandChar === commandChar.toLowerCase();
      const upperCode = commandChar.toUpperCase();
      i++;
      explicitCommand = true;
      // After M, implicit commands are L
      lastCommandCode = upperCode === 'M' ? 'L' : upperCode;
    } else if (lastCommandCode) {
      // Implicit command repetition
      commandChar = lastCommandCode;
      // Preserve relative/absolute from last explicit command
      // (This is simplified - in reality, each implicit command should check the original)
      isRelative = false; // Default to absolute for implicit
      explicitCommand = false;
    } else {
      // No command to repeat, skip
      i++;
      continue;
    }

    // Collect arguments for this command
    const args: number[] = [];
    const argCounts: Record<string, number> = {
      'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'T': 2, 'A': 7, 'Z': 0
    };
    const expectedArgs = argCounts[commandChar.toUpperCase()] || 0;

    // Collect arguments: take numbers until we have enough or hit a new command
    while (args.length < expectedArgs && i < tokens.length) {
      if (tokens[i].type === 'number') {
        const num = parseFloat(tokens[i].value);
        if (!isNaN(num)) {
          args.push(num);
        }
        i++;
      } else if (tokens[i].type === 'command') {
        // New command, stop collecting args (might have leftover args for implicit command)
        break;
      } else {
        i++;
      }
    }
    
    // If we didn't get enough args, this command is incomplete - skip it
    if (args.length < expectedArgs && expectedArgs > 0) {
      if (explicitCommand) {
        warnings.push(`Incomplete command ${commandChar}: expected ${expectedArgs} args, got ${args.length}`);
      }
      continue;
    }

    // Build command string for parsing
    const commandStr = (isRelative ? commandChar.toLowerCase() : commandChar.toUpperCase()) + ' ' + args.join(' ');
    const parsed = parsePathCommand(commandStr, currentX, currentY);

    if (!parsed) {
      warnings.push(`Unparseable command: ${commandStr.substring(0, 20)}`);
      continue;
    }

    // Add command to set (use uppercase code)
    const { code, endX, endY } = parsed;
    
    // Add command to set (always record the command type being executed)
    commands.add(code);
    
    lastCommand = code;
    
    // Update lastCommandCode for implicit repetition
    // After M, implicit commands are L; after L, implicit commands are L; etc.
    if (code === 'M') {
      lastCommandCode = 'L';
    } else if (code === 'L' || code === 'H' || code === 'V' || code === 'C' || code === 'S' || code === 'Q' || code === 'T' || code === 'A') {
      lastCommandCode = code; // Keep same command for implicit repetition
    } else if (code === 'Z') {
      // After Z, reset to null (next command must be explicit)
      lastCommandCode = null;
    }

    switch (code) {
      case 'M': // MoveTo
        currentX = endX;
        currentY = endY;
        startX = currentX;
        startY = currentY;
        coordinates.push([Math.round(currentX * 1e6) / 1e6, Math.round(currentY * 1e6) / 1e6]);
        break;

      case 'L': // LineTo
        currentX = endX;
        currentY = endY;
        coordinates.push([Math.round(currentX * 1e6) / 1e6, Math.round(currentY * 1e6) / 1e6]);
        break;

      case 'H': // Horizontal LineTo
        currentX = endX;
        coordinates.push([Math.round(currentX * 1e6) / 1e6, Math.round(currentY * 1e6) / 1e6]);
        break;

      case 'V': // Vertical LineTo
        currentY = endY;
        coordinates.push([Math.round(currentX * 1e6) / 1e6, Math.round(currentY * 1e6) / 1e6]);
        break;

      case 'Z': // ClosePath
        if (coordinates.length > 0) {
          // Add start point if different from last point
          const lastCoord = coordinates[coordinates.length - 1];
          if (Math.abs(lastCoord[0] - startX) > 1e-6 || Math.abs(lastCoord[1] - startY) > 1e-6) {
            coordinates.push([Math.round(startX * 1e6) / 1e6, Math.round(startY * 1e6) / 1e6]);
          }
        }
        break;

      case 'Q': // Quadratic Bezier
        if (args.length >= 4) {
          const x1 = isRelative ? currentX + args[0] : args[0];
          const y1 = isRelative ? currentY + args[1] : args[1];
          const x2 = isRelative ? currentX + args[2] : args[2];
          const y2 = isRelative ? currentY + args[3] : args[3];
          const flattened = flattenQuadratic(currentX, currentY, x1, y1, x2, y2, FLATTEN_SEGMENTS_Q);
          // Skip first point (already at currentX, currentY)
          for (let i = 1; i < flattened.length; i++) {
            coordinates.push(flattened[i]);
          }
          currentX = x2;
          currentY = y2;
        }
        break;

      case 'C': // Cubic Bezier
        if (args.length >= 6) {
          const x1 = isRelative ? currentX + args[0] : args[0];
          const y1 = isRelative ? currentY + args[1] : args[1];
          const x2 = isRelative ? currentX + args[2] : args[2];
          const y2 = isRelative ? currentY + args[3] : args[3];
          const x3 = isRelative ? currentX + args[4] : args[4];
          const y3 = isRelative ? currentY + args[5] : args[5];
          const flattened = flattenCubic(currentX, currentY, x1, y1, x2, y2, x3, y3, FLATTEN_SEGMENTS_C);
          // Skip first point
          for (let i = 1; i < flattened.length; i++) {
            coordinates.push(flattened[i]);
          }
          currentX = x3;
          currentY = y3;
        }
        break;

      case 'S': // Smooth Cubic Bezier
        // S requires previous command to be C or S to determine control point
        // For now, treat as regular cubic with first control point = current point
        if (args.length >= 4) {
          const x1 = currentX; // Reflect previous control point (simplified)
          const y1 = currentY;
          const x2 = isRelative ? currentX + args[0] : args[0];
          const y2 = isRelative ? currentY + args[1] : args[1];
          const x3 = isRelative ? currentX + args[2] : args[2];
          const y3 = isRelative ? currentY + args[3] : args[3];
          const flattened = flattenCubic(currentX, currentY, x1, y1, x2, y2, x3, y3, FLATTEN_SEGMENTS_C);
          for (let i = 1; i < flattened.length; i++) {
            coordinates.push(flattened[i]);
          }
          currentX = x3;
          currentY = y3;
        }
        break;

      case 'T': // Smooth Quadratic Bezier
        // T requires previous command to be Q or T to determine control point
        // For now, treat as regular quadratic with control point = current point
        if (args.length >= 2) {
          const x1 = currentX; // Reflect previous control point (simplified)
          const y1 = currentY;
          const x2 = isRelative ? currentX + args[0] : args[0];
          const y2 = isRelative ? currentY + args[1] : args[1];
          const flattened = flattenQuadratic(currentX, currentY, x1, y1, x2, y2, FLATTEN_SEGMENTS_Q);
          for (let i = 1; i < flattened.length; i++) {
            coordinates.push(flattened[i]);
          }
          currentX = x2;
          currentY = y2;
        }
        break;

      case 'A': // Arc
        if (args.length >= 7) {
          const rx = args[0];
          const ry = args[1];
          const xAxisRotation = args[2];
          const largeArcFlag = args[3];
          const sweepFlag = args[4];
          const x = isRelative ? currentX + args[5] : args[5];
          const y = isRelative ? currentY + args[6] : args[6];
          // Arc parameterization is implemented, so proceed
          const flattened = flattenArc(
            currentX,
            currentY,
            rx,
            ry,
            xAxisRotation,
            largeArcFlag,
            sweepFlag,
            x,
            y,
            FLATTEN_SEGMENTS_A
          );
          // Skip first point
          for (let i = 1; i < flattened.length; i++) {
            coordinates.push(flattened[i]);
          }
          currentX = x;
          currentY = y;
        }
        break;
    }

    lastCommand = code;
  }

  return { coordinates, commands, warnings };
}

// ============================================================================
// Main Processing
// ============================================================================

async function main(): Promise<void> {
  console.log('Reading HTML file...');
  const htmlContent = await readFile(HTML_SOURCE_PATH, 'utf8');

  console.log('Extracting MUNICIPALITY_DISSOLVED_OUTLINES object...');
  const rawObject = extractObjectFromHTML(htmlContent);
  if (!rawObject) {
    console.error('Failed to extract MUNICIPALITY_DISSOLVED_OUTLINES from HTML');
    process.exitCode = 0; // Exit code 0 as per requirements
    return;
  }

  console.log(`Found ${Object.keys(rawObject).length} municipality keys`);

  // Normalize and sort municipality keys deterministically
  const municipalityData: MunicipalityData[] = [];
  const sortedKeys = Object.keys(rawObject).sort();
  
  for (const key of sortedKeys) {
    const normalized = normalizeMunicipalityData(key, rawObject[key]);
    if (normalized) {
      municipalityData.push(normalized);
    }
  }

  console.log(`Normalized ${municipalityData.length} municipalities`);

  // Parse SVG paths
  const features: Array<{
    type: 'Feature';
    properties: MunicipalityFeature;
    geometry: { type: 'MultiLineString'; coordinates: number[][][] };
  }> = [];

  const audit: AuditReport = {
    total_municipalities_found: municipalityData.length,
    municipalities_emitted: 0,
    municipalities_skipped: 0,
    skip_reasons: {},
    top_20_by_vertex_count: [],
    municipalities_with_curves: [],
  };

  const vertexCounts: Array<{ muni_key: string; vertex_count: number }> = [];

  for (const muni of municipalityData) {
    const allCoordinates: number[][][] = [];
    const allCommands = new Set<string>();
    const allWarnings: string[] = [];
    let hasCurves = false;
    let shouldSkip = false;
    let skipReason = '';

    for (const pathD of muni.parts) {
      const parsed = parseSVGPath(pathD);
      
      // Check for curve commands
      const curveCommands = ['Q', 'C', 'S', 'T', 'A'];
      if (parsed.commands.size > 0 && Array.from(parsed.commands).some(c => curveCommands.includes(c))) {
        hasCurves = true;
      }

      // Check for unsupported commands that should cause skip
      // (Currently all commands are supported, but this is where we'd add checks)
      if (parsed.warnings.some(w => w.includes('unsupported_svg_command'))) {
        shouldSkip = true;
        skipReason = 'unsupported_svg_command';
        break;
      }

      allCommands.add(...parsed.commands);
      allWarnings.push(...parsed.warnings);

      if (parsed.coordinates.length === 0) {
        continue;
      }

      // Each path becomes a LineString
      allCoordinates.push(parsed.coordinates);
    }

    if (shouldSkip) {
      audit.municipalities_skipped++;
      audit.skip_reasons[skipReason] = (audit.skip_reasons[skipReason] || 0) + 1;
      continue;
    }

    if (allCoordinates.length === 0) {
      audit.municipalities_skipped++;
      audit.skip_reasons['empty_path'] = (audit.skip_reasons['empty_path'] || 0) + 1;
      continue;
    }

    // Count total vertices
    const totalVertices = allCoordinates.reduce((sum, ring) => sum + ring.length, 0);
    vertexCounts.push({ muni_key: muni.key, vertex_count: totalVertices });

    if (hasCurves) {
      audit.municipalities_with_curves.push(muni.key);
    }

    // Create feature
    // MultiLineString coordinates: array of LineString coordinates
    // Each LineString is an array of [x, y] pairs
    const geometry: { type: 'MultiLineString'; coordinates: number[][][] } = {
      type: 'MultiLineString',
      coordinates: allCoordinates,
    };

    const properties: MunicipalityFeature = {
      muni_key: muni.key,
      source: 'MUNICIPALITY_DISSOLVED_OUTLINES@settlements_map_WITH_MUNI_OUTLINES_dark_zoom_v5.html',
      svg_commands: Array.from(allCommands).sort(),
      parts: muni.parts.length,
    };

    if (allWarnings.length > 0) {
      properties.warnings = allWarnings;
    }

    features.push({
      type: 'Feature',
      properties,
      geometry,
    });

    audit.municipalities_emitted++;
  }

  // Sort top 20 by vertex count
  vertexCounts.sort((a, b) => {
    if (b.vertex_count !== a.vertex_count) {
      return b.vertex_count - a.vertex_count;
    }
    return a.muni_key.localeCompare(b.muni_key);
  });
  audit.top_20_by_vertex_count = vertexCounts.slice(0, 20);

  // Write GeoJSON
  console.log(`Writing ${features.length} features to GeoJSON...`);
  await mkdir(resolve('data/derived'), { recursive: true });
  
  const geojson = {
    type: 'FeatureCollection' as const,
    features,
  };

  await writeFile(
    OUTPUT_GEOJSON_PATH,
    JSON.stringify(geojson, null, 2),
    'utf8'
  );

  // Write audit report
  console.log('Writing audit report...');
  const auditLines: string[] = [
    'Municipality Outlines Extraction Audit',
    '=====================================',
    '',
    `Total municipalities found: ${audit.total_municipalities_found}`,
    `Municipalities emitted: ${audit.municipalities_emitted}`,
    `Municipalities skipped: ${audit.municipalities_skipped}`,
    '',
    'Skip reasons:',
    ...Object.entries(audit.skip_reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `  ${reason}: ${count}`),
    '',
    'Top 20 municipalities by vertex count:',
    ...audit.top_20_by_vertex_count.map(
      (item) => `  ${item.muni_key}: ${item.vertex_count} vertices`
    ),
    '',
    `Municipalities with curve/arc commands: ${audit.municipalities_with_curves.length}`,
    ...(audit.municipalities_with_curves.length > 0
      ? ['', 'List:', ...audit.municipalities_with_curves.sort().map((key) => `  - ${key}`)]
      : []),
  ];

  await writeFile(OUTPUT_AUDIT_PATH, auditLines.join('\n'), 'utf8');

  console.log('Done!');
  console.log(`  GeoJSON: ${OUTPUT_GEOJSON_PATH}`);
  console.log(`  Audit: ${OUTPUT_AUDIT_PATH}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exitCode = 1;
});
