/**
 * Build Settlements GeoJSON from Municipality JS Files
 *
 * Parses all JS files in data/source/settlements/ to extract SVG paths and
 * settlement IDs, converts them to GeoJSON polygons, and joins with census data.
 *
 * Usage:
 *   npm run map:build:settlements
 *   or: tsx scripts/map/build_settlements_from_js.ts
 *
 * Outputs:
 *   - data/derived/settlements_from_js.geojson
 *   - data/derived/settlements_from_js.audit.json
 *   - data/derived/settlements_from_js.audit.txt
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Build settlements GeoJSON from municipality JS files with SVG paths");

type Point = [number, number];

interface Settlement {
  sid: string;
  svgPath: string;
  coords: Point[];
  municipalityFile: string;
  municipalityId: string | null;
  name: string | null;
}

interface CensusSettlement {
  n: string;  // name
  m: string;  // municipality_id
  p: number[]; // [total, bosniak, croat, serb, other]
}

interface Census {
  settlements: Record<string, CensusSettlement>;
}

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    name: string | null;
    municipality_id: string | null;
    source_file: string;
  };
  geometry: {
    type: 'Polygon';
    coordinates: Point[][];
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

/**
 * Parse SVG path commands and convert to coordinate array
 * Supports: M, m, L, l, H, h, V, v, C, c, S, s, Q, q, T, t, A, a, Z, z
 */
function parseSvgPath(pathStr: string): Point[] {
  const coords: Point[] = [];
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;

  // Normalize path string - handle negative numbers without separator
  const normalized = pathStr
    .replace(/([a-zA-Z])/g, ' $1 ')
    .replace(/,/g, ' ')
    .replace(/-/g, ' -')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(' ').filter(t => t.length > 0);

  let i = 0;
  let currentCommand = '';

  while (i < tokens.length) {
    const token = tokens[i];

    // Check if token is a command
    if (/^[a-zA-Z]$/.test(token)) {
      currentCommand = token;
      i++;
      continue;
    }

    // Parse numbers based on current command
    switch (currentCommand) {
      case 'M': // Move to (absolute)
        currentX = parseFloat(tokens[i]);
        currentY = parseFloat(tokens[i + 1]);
        startX = currentX;
        startY = currentY;
        coords.push([currentX, currentY]);
        i += 2;
        currentCommand = 'L'; // Subsequent coords are line-to
        break;

      case 'm': // Move to (relative)
        currentX += parseFloat(tokens[i]);
        currentY += parseFloat(tokens[i + 1]);
        startX = currentX;
        startY = currentY;
        coords.push([currentX, currentY]);
        i += 2;
        currentCommand = 'l';
        break;

      case 'L': // Line to (absolute)
        currentX = parseFloat(tokens[i]);
        currentY = parseFloat(tokens[i + 1]);
        coords.push([currentX, currentY]);
        i += 2;
        break;

      case 'l': // Line to (relative)
        currentX += parseFloat(tokens[i]);
        currentY += parseFloat(tokens[i + 1]);
        coords.push([currentX, currentY]);
        i += 2;
        break;

      case 'H': // Horizontal line (absolute)
        currentX = parseFloat(tokens[i]);
        coords.push([currentX, currentY]);
        i += 1;
        break;

      case 'h': // Horizontal line (relative)
        currentX += parseFloat(tokens[i]);
        coords.push([currentX, currentY]);
        i += 1;
        break;

      case 'V': // Vertical line (absolute)
        currentY = parseFloat(tokens[i]);
        coords.push([currentX, currentY]);
        i += 1;
        break;

      case 'v': // Vertical line (relative)
        currentY += parseFloat(tokens[i]);
        coords.push([currentX, currentY]);
        i += 1;
        break;

      case 'C': // Cubic Bezier (absolute) - flatten to line segments
        {
          const x1 = parseFloat(tokens[i]);
          const y1 = parseFloat(tokens[i + 1]);
          const x2 = parseFloat(tokens[i + 2]);
          const y2 = parseFloat(tokens[i + 3]);
          const x = parseFloat(tokens[i + 4]);
          const y = parseFloat(tokens[i + 5]);

          // Flatten cubic bezier to line segments
          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*u*currentX + 3*u*u*tt*x1 + 3*u*tt*tt*x2 + tt*tt*tt*x;
            const py = u*u*u*currentY + 3*u*u*tt*y1 + 3*u*tt*tt*y2 + tt*tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 6;
        }
        break;

      case 'c': // Cubic Bezier (relative)
        {
          const x1 = currentX + parseFloat(tokens[i]);
          const y1 = currentY + parseFloat(tokens[i + 1]);
          const x2 = currentX + parseFloat(tokens[i + 2]);
          const y2 = currentY + parseFloat(tokens[i + 3]);
          const x = currentX + parseFloat(tokens[i + 4]);
          const y = currentY + parseFloat(tokens[i + 5]);

          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*u*currentX + 3*u*u*tt*x1 + 3*u*tt*tt*x2 + tt*tt*tt*x;
            const py = u*u*u*currentY + 3*u*u*tt*y1 + 3*u*tt*tt*y2 + tt*tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 6;
        }
        break;

      case 'S': // Smooth cubic Bezier (absolute)
        {
          const x2 = parseFloat(tokens[i]);
          const y2 = parseFloat(tokens[i + 1]);
          const x = parseFloat(tokens[i + 2]);
          const y = parseFloat(tokens[i + 3]);

          // Reflect previous control point (simplified - just use current point)
          const x1 = currentX;
          const y1 = currentY;

          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*u*currentX + 3*u*u*tt*x1 + 3*u*tt*tt*x2 + tt*tt*tt*x;
            const py = u*u*u*currentY + 3*u*u*tt*y1 + 3*u*tt*tt*y2 + tt*tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 4;
        }
        break;

      case 's': // Smooth cubic Bezier (relative)
        {
          const x2 = currentX + parseFloat(tokens[i]);
          const y2 = currentY + parseFloat(tokens[i + 1]);
          const x = currentX + parseFloat(tokens[i + 2]);
          const y = currentY + parseFloat(tokens[i + 3]);

          const x1 = currentX;
          const y1 = currentY;

          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*u*currentX + 3*u*u*tt*x1 + 3*u*tt*tt*x2 + tt*tt*tt*x;
            const py = u*u*u*currentY + 3*u*u*tt*y1 + 3*u*tt*tt*y2 + tt*tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 4;
        }
        break;

      case 'Q': // Quadratic Bezier (absolute)
        {
          const x1 = parseFloat(tokens[i]);
          const y1 = parseFloat(tokens[i + 1]);
          const x = parseFloat(tokens[i + 2]);
          const y = parseFloat(tokens[i + 3]);

          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*currentX + 2*u*tt*x1 + tt*tt*x;
            const py = u*u*currentY + 2*u*tt*y1 + tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 4;
        }
        break;

      case 'q': // Quadratic Bezier (relative)
        {
          const x1 = currentX + parseFloat(tokens[i]);
          const y1 = currentY + parseFloat(tokens[i + 1]);
          const x = currentX + parseFloat(tokens[i + 2]);
          const y = currentY + parseFloat(tokens[i + 3]);

          const steps = 10;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            const u = 1 - tt;
            const px = u*u*currentX + 2*u*tt*x1 + tt*tt*x;
            const py = u*u*currentY + 2*u*tt*y1 + tt*tt*y;
            coords.push([px, py]);
          }

          currentX = x;
          currentY = y;
          i += 4;
        }
        break;

      case 'T': // Smooth quadratic Bezier (absolute)
        {
          const x = parseFloat(tokens[i]);
          const y = parseFloat(tokens[i + 1]);
          coords.push([x, y]);
          currentX = x;
          currentY = y;
          i += 2;
        }
        break;

      case 't': // Smooth quadratic Bezier (relative)
        {
          currentX += parseFloat(tokens[i]);
          currentY += parseFloat(tokens[i + 1]);
          coords.push([currentX, currentY]);
          i += 2;
        }
        break;

      case 'A': // Arc (absolute) - simplified to line
      case 'a': // Arc (relative)
        {
          // Arc has 7 parameters: rx ry x-axis-rotation large-arc-flag sweep-flag x y
          const isRelative = currentCommand === 'a';
          i += 5; // Skip rx, ry, rotation, flags
          const x = parseFloat(tokens[i]);
          const y = parseFloat(tokens[i + 1]);
          if (isRelative) {
            currentX += x;
            currentY += y;
          } else {
            currentX = x;
            currentY = y;
          }
          coords.push([currentX, currentY]);
          i += 2;
        }
        break;

      case 'Z': // Close path
      case 'z':
        // Close path - return to start
        if (coords.length > 0) {
          coords.push([startX, startY]);
        }
        currentX = startX;
        currentY = startY;
        break;

      default:
        // Unknown command or number without command, skip
        i++;
    }
  }

  return coords;
}

/**
 * Extract settlements from a municipality JS file
 */
function extractSettlementsFromJs(filePath: string): Settlement[] {
  const content = readFileSync(filePath, 'utf8');
  const fileName = basename(filePath);

  // Extract municipality ID from filename (e.g., "Banovici_10014.js" -> "10014")
  const fileMatch = fileName.match(/_(\d+)\.js$/);
  const fileMunicipalityId = fileMatch ? fileMatch[1] : null;

  const settlements: Settlement[] = [];

  // Pattern: mun.push(R.path("...")).data("munID",123456)
  // The path can be very long and contain many commands
  const pathRegex = /mun\.push\(R\.path\("([^"]+)"\)[^)]*\)\.data\("munID",(\d+)\)/g;

  let match;
  while ((match = pathRegex.exec(content)) !== null) {
    const svgPath = match[1];
    const sid = match[2];

    const coords = parseSvgPath(svgPath);

    if (coords.length >= 3) {
      settlements.push({
        sid,
        svgPath,
        coords,
        municipalityFile: fileName,
        municipalityId: fileMunicipalityId,
        name: null  // Will be filled from census
      });
    }
  }

  return settlements;
}

/**
 * Ensure polygon is closed (first point == last point)
 */
function closePolygon(coords: Point[]): Point[] {
  if (coords.length < 3) return coords;

  const first = coords[0];
  const last = coords[coords.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...coords, [first[0], first[1]]];
  }

  return coords;
}

/**
 * Round coordinates to fixed precision
 */
function roundCoords(coords: Point[], precision: number = 4): Point[] {
  const factor = Math.pow(10, precision);
  return coords.map(([x, y]) => [
    Math.round(x * factor) / factor,
    Math.round(y * factor) / factor
  ]);
}

async function main(): Promise<void> {
  const settlementsDir = resolve('data/source/settlements');
  const censusPath = resolve('data/source/bih_census_1991.json');
  const outputPath = resolve('data/derived/settlements_from_js.geojson');
  const auditJsonPath = resolve('data/derived/settlements_from_js.audit.json');
  const auditTxtPath = resolve('data/derived/settlements_from_js.audit.txt');

  mkdirSync(resolve('data/derived'), { recursive: true });

  // Load census data
  process.stdout.write(`Loading census from ${censusPath}...\n`);
  const census: Census = JSON.parse(readFileSync(censusPath, 'utf8'));

  // Get all JS files
  const jsFiles = readdirSync(settlementsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  process.stdout.write(`Found ${jsFiles.length} municipality JS files\n`);

  // Extract settlements from all files
  const allSettlements: Settlement[] = [];
  const fileStats: Record<string, number> = {};

  for (const jsFile of jsFiles) {
    const filePath = resolve(settlementsDir, jsFile);
    const settlements = extractSettlementsFromJs(filePath);
    fileStats[jsFile] = settlements.length;
    allSettlements.push(...settlements);

    if (settlements.length === 0) {
      process.stdout.write(`  Warning: No settlements found in ${jsFile}\n`);
    }
  }

  process.stdout.write(`Extracted ${allSettlements.length} settlements total\n`);

  // Check for duplicate SIDs
  const sidCounts = new Map<string, number>();
  for (const s of allSettlements) {
    sidCounts.set(s.sid, (sidCounts.get(s.sid) || 0) + 1);
  }
  const duplicateSids = Array.from(sidCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([sid, count]) => ({ sid, count }));

  if (duplicateSids.length > 0) {
    process.stdout.write(`Warning: Found ${duplicateSids.length} duplicate SIDs\n`);
  }

  // Join with census data
  let censusMatched = 0;
  let censusMissing = 0;

  for (const settlement of allSettlements) {
    const censusData = census.settlements[settlement.sid];
    if (censusData) {
      settlement.name = censusData.n;
      if (!settlement.municipalityId) {
        settlement.municipalityId = censusData.m;
      }
      censusMatched++;
    } else {
      censusMissing++;
    }
  }

  process.stdout.write(`Census join: ${censusMatched} matched, ${censusMissing} missing\n`);

  // Build GeoJSON features
  const features: GeoJSONFeature[] = [];

  for (const settlement of allSettlements) {
    const closedCoords = closePolygon(settlement.coords);
    const roundedCoords = roundCoords(closedCoords, 4);

    features.push({
      type: 'Feature',
      properties: {
        sid: settlement.sid,
        name: settlement.name,
        municipality_id: settlement.municipalityId,
        source_file: settlement.municipalityFile
      },
      geometry: {
        type: 'Polygon',
        coordinates: [roundedCoords]
      }
    });
  }

  // Sort by SID for determinism
  features.sort((a, b) => a.properties.sid.localeCompare(b.properties.sid));

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const feature of features) {
    for (const ring of feature.geometry.coordinates) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  // Output GeoJSON
  const geojson: GeoJSONFC = {
    type: 'FeatureCollection',
    features
  };

  writeFileSync(outputPath, JSON.stringify(geojson, null, 2), 'utf8');
  process.stdout.write(`Wrote ${features.length} features to ${outputPath}\n`);

  // Build audit report
  const audit = {
    input: {
      js_files_count: jsFiles.length,
      census_settlements_count: Object.keys(census.settlements).length
    },
    output: {
      features_count: features.length,
      census_matched: censusMatched,
      census_missing: censusMissing,
      duplicate_sids: duplicateSids
    },
    bbox: {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY
    },
    file_stats: fileStats
  };

  writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2), 'utf8');
  process.stdout.write(`Wrote audit to ${auditJsonPath}\n`);

  // Write TXT audit
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENTS FROM JS BUILD AUDIT');
  txtLines.push('===============================');
  txtLines.push('');
  txtLines.push('INPUT:');
  txtLines.push(`  JS files: ${jsFiles.length}`);
  txtLines.push(`  Census settlements: ${Object.keys(census.settlements).length}`);
  txtLines.push('');
  txtLines.push('OUTPUT:');
  txtLines.push(`  Features: ${features.length}`);
  txtLines.push(`  Census matched: ${censusMatched}`);
  txtLines.push(`  Census missing: ${censusMissing}`);
  txtLines.push(`  Duplicate SIDs: ${duplicateSids.length}`);
  txtLines.push('');
  txtLines.push('BOUNDING BOX:');
  txtLines.push(`  X: ${minX.toFixed(4)} to ${maxX.toFixed(4)} (width: ${(maxX - minX).toFixed(4)})`);
  txtLines.push(`  Y: ${minY.toFixed(4)} to ${maxY.toFixed(4)} (height: ${(maxY - minY).toFixed(4)})`);
  txtLines.push('');

  if (duplicateSids.length > 0) {
    txtLines.push('DUPLICATE SIDS:');
    for (const { sid, count } of duplicateSids.slice(0, 20)) {
      txtLines.push(`  ${sid}: ${count} occurrences`);
    }
    txtLines.push('');
  }

  txtLines.push('FILE STATISTICS (settlements per file):');
  const sortedFiles = Object.entries(fileStats).sort((a, b) => b[1] - a[1]);
  for (const [file, count] of sortedFiles.slice(0, 20)) {
    txtLines.push(`  ${file}: ${count}`);
  }

  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit to ${auditTxtPath}\n`);

  process.stdout.write('\nDone!\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
