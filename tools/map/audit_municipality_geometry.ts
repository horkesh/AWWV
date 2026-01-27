#!/usr/bin/env node
/**
 * Audit municipality geometries for boundary anomalies
 * 
 * Detects geometry path anomalies without modifying geometry:
 * - Non-adjacent repeated vertices
 * - Immediate backtrack segments (A->B->A)
 * - Degenerate segments (A==B)
 * - Candidate self-crossings
 * 
 * Usage:
 *   tsx tools/map/audit_municipality_geometry.ts
 *   npm run map:audit-munis
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Audit municipality geometries in geography.geojson for boundary anomalies without modifying geometry");

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const GEOJSON_PATH = resolve('data/source/geography.geojson');
const OUTPUT_JSON = resolve('data/derived/municipality_geometry_audit.json');
const OUTPUT_TXT = resolve('data/derived/municipality_geometry_audit.txt');

const ROUND_PRECISION = 1e-6;
const MAX_INTERSECTION_CHECKS = 50; // Early exit after first N intersections per ring
const MAX_RING_SIZE_FOR_INTERSECTION = 6000; // Skip intersection test for very large rings

interface Issue {
  type: 'non_adjacent_repeat' | 'backtrack' | 'degenerate_segment' | 'self_crossing_candidate';
  part_index: number;
  ring_index: number;
  indices: number[];
  coord?: [number, number];
  snippet?: string;
  intersection_location?: [number, number];
}

interface MunicipalityAudit {
  name: string;
  mid?: string;
  geometry_type: string;
  total_vertices_estimate: number;
  issues: Issue[];
  issue_severity_score: number;
}

interface AuditReport {
  summary: {
    municipalities_total: number;
    municipalities_with_any_issue: number;
    total_issues_by_type: {
      non_adjacent_repeat: number;
      backtrack: number;
      degenerate_segment: number;
      self_crossing_candidate: number;
    };
  };
  municipalities: MunicipalityAudit[];
}

// Round coordinate to fixed precision
function roundCoord(coord: number): number {
  return Math.round(coord / ROUND_PRECISION) * ROUND_PRECISION;
}

// Round coordinate pair
function roundCoordPair(coord: [number, number]): [number, number] {
  return [roundCoord(coord[0]), roundCoord(coord[1])];
}

// Check if two coordinates are equal (after rounding)
function coordsEqual(a: [number, number], b: [number, number]): boolean {
  const ra = roundCoordPair(a);
  const rb = roundCoordPair(b);
  return ra[0] === rb[0] && ra[1] === rb[1];
}

// Get coordinate snippet (window around index)
function getSnippet(ring: [number, number][], index: number, windowSize: number = 3): string {
  const start = Math.max(0, index - windowSize);
  const end = Math.min(ring.length, index + windowSize + 1);
  const snippet = ring.slice(start, end).map((c, i) => {
    const idx = start + i;
    return `${idx}: [${c[0].toFixed(3)}, ${c[1].toFixed(3)}]`;
  }).join(', ');
  return `[${snippet}]`;
}

// Check for non-adjacent repeated vertices
function checkNonAdjacentRepeats(ring: [number, number][], partIndex: number, ringIndex: number): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, number>(); // rounded coord -> first index
  
  for (let i = 0; i < ring.length; i++) {
    const coord = roundCoordPair(ring[i]);
    const key = `${coord[0]},${coord[1]}`;
    
    if (seen.has(key)) {
      const firstIndex = seen.get(key)!;
      // Check if not adjacent (skip immediate neighbors)
      if (Math.abs(i - firstIndex) > 1 && Math.abs(i - firstIndex) !== ring.length - 1) {
        issues.push({
          type: 'non_adjacent_repeat',
          part_index: partIndex,
          ring_index: ringIndex,
          indices: [firstIndex, i],
          coord: ring[i],
          snippet: `First: ${getSnippet(ring, firstIndex)}, Repeat: ${getSnippet(ring, i)}`
        });
      }
    } else {
      seen.set(key, i);
    }
  }
  
  return issues;
}

// Check for immediate backtrack segments (A->B->A)
function checkBacktracks(ring: [number, number][], partIndex: number, ringIndex: number): Issue[] {
  const issues: Issue[] = [];
  
  for (let i = 0; i < ring.length - 2; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const c = ring[i + 2];
    
    if (coordsEqual(a, c) && !coordsEqual(a, b)) {
      issues.push({
        type: 'backtrack',
        part_index: partIndex,
        ring_index: ringIndex,
        indices: [i, i + 1, i + 2],
        snippet: `A: [${a[0].toFixed(3)}, ${a[1].toFixed(3)}], B: [${b[0].toFixed(3)}, ${b[1].toFixed(3)}], A: [${c[0].toFixed(3)}, ${c[1].toFixed(3)}]`
      });
    }
  }
  
  // Check wrap-around (last->first->second)
  if (ring.length >= 3) {
    const a = ring[ring.length - 1];
    const b = ring[0];
    const c = ring[1];
    if (coordsEqual(a, c) && !coordsEqual(a, b)) {
      issues.push({
        type: 'backtrack',
        part_index: partIndex,
        ring_index: ringIndex,
        indices: [ring.length - 1, 0, 1],
        snippet: `A: [${a[0].toFixed(3)}, ${a[1].toFixed(3)}], B: [${b[0].toFixed(3)}, ${b[1].toFixed(3)}], A: [${c[0].toFixed(3)}, ${c[1].toFixed(3)}]`
      });
    }
  }
  
  return issues;
}

// Check for degenerate segments (A==B consecutive duplicates)
function checkDegenerateSegments(ring: [number, number][], partIndex: number, ringIndex: number): Issue[] {
  const issues: Issue[] = [];
  
  for (let i = 0; i < ring.length - 1; i++) {
    if (coordsEqual(ring[i], ring[i + 1])) {
      issues.push({
        type: 'degenerate_segment',
        part_index: partIndex,
        ring_index: ringIndex,
        indices: [i, i + 1],
        coord: ring[i],
        snippet: `[${i}]: [${ring[i][0].toFixed(3)}, ${ring[i][1].toFixed(3)}] == [${i + 1}]: [${ring[i + 1][0].toFixed(3)}, ${ring[i + 1][1].toFixed(3)}]`
      });
    }
  }
  
  return issues;
}

// Simple segment intersection test (bounded, deterministic)
// Returns true if segments (p1-p2) and (p3-p4) intersect (excluding endpoints)
function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
  epsilon: number = ROUND_PRECISION
): { intersects: boolean; location?: [number, number] } {
  // Skip if segments share an endpoint
  if (coordsEqual(p1, p3) || coordsEqual(p1, p4) || coordsEqual(p2, p3) || coordsEqual(p2, p4)) {
    return { intersects: false };
  }
  
  // Orientation test (CCW)
  function orientation(o: [number, number], a: [number, number], b: [number, number]): number {
    const val = (a[1] - o[1]) * (b[0] - a[0]) - (a[0] - o[0]) * (b[1] - a[1]);
    if (Math.abs(val) < epsilon) return 0; // Collinear
    return val > 0 ? 1 : -1; // CCW or CW
  }
  
  // Check if point is on segment (bounded)
  function onSegment(p: [number, number], q: [number, number], r: [number, number]): boolean {
    if (orientation(p, q, r) !== 0) return false;
    return (
      Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
      Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1])
    );
  }
  
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  
  // General case: segments intersect if orientations differ
  if (o1 !== o2 && o3 !== o4) {
    // Compute approximate intersection point (line-line intersection)
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1];
    const x4 = p4[0], y4 = p4[1];
    
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) > epsilon) {
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
      
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const ix = x1 + t * (x2 - x1);
        const iy = y1 + t * (y2 - y1);
        return { intersects: true, location: [roundCoord(ix), roundCoord(iy)] };
      }
    }
  }
  
  // Special case: collinear and overlapping
  if (o1 === 0 && onSegment(p1, p3, p2)) return { intersects: true, location: p3 };
  if (o2 === 0 && onSegment(p1, p4, p2)) return { intersects: true, location: p4 };
  if (o3 === 0 && onSegment(p3, p1, p4)) return { intersects: true, location: p1 };
  if (o4 === 0 && onSegment(p3, p2, p4)) return { intersects: true, location: p2 };
  
  return { intersects: false };
}

// Check for candidate self-crossings
function checkSelfCrossings(ring: [number, number][], partIndex: number, ringIndex: number): Issue[] {
  const issues: Issue[] = [];
  
  // Skip if ring is too large
  if (ring.length > MAX_RING_SIZE_FOR_INTERSECTION) {
    return [{
      type: 'self_crossing_candidate',
      part_index: partIndex,
      ring_index: ringIndex,
      indices: [],
      snippet: `skipped_due_to_size (${ring.length} vertices)`
    }];
  }
  
  // Build segments
  const segments: Array<{ start: number; end: number; p1: [number, number]; p2: [number, number] }> = [];
  for (let i = 0; i < ring.length - 1; i++) {
    segments.push({
      start: i,
      end: i + 1,
      p1: ring[i],
      p2: ring[i + 1]
    });
  }
  
  // Check intersections between non-adjacent segments
  let intersectionCount = 0;
  for (let i = 0; i < segments.length && intersectionCount < MAX_INTERSECTION_CHECKS; i++) {
    const seg1 = segments[i];
    
    for (let j = i + 2; j < segments.length && intersectionCount < MAX_INTERSECTION_CHECKS; j++) {
      // Skip if segments are neighbors (share endpoint)
      if (seg1.end === segments[j].start || seg1.start === segments[j].end) {
        continue;
      }
      
      const seg2 = segments[j];
      const result = segmentsIntersect(seg1.p1, seg1.p2, seg2.p1, seg2.p2);
      
      if (result.intersects) {
        intersectionCount++;
        issues.push({
          type: 'self_crossing_candidate',
          part_index: partIndex,
          ring_index: ringIndex,
          indices: [seg1.start, seg1.end, seg2.start, seg2.end],
          intersection_location: result.location,
          snippet: `Segment [${seg1.start}-${seg1.end}] intersects [${seg2.start}-${seg2.end}]${result.location ? ` at [${result.location[0].toFixed(3)}, ${result.location[1].toFixed(3)}]` : ''}`
        });
      }
    }
  }
  
  return issues;
}

// Calculate severity score
function calculateSeverityScore(issues: Issue[]): number {
  let score = 0;
  for (const issue of issues) {
    switch (issue.type) {
      case 'self_crossing_candidate':
        score += 10;
        break;
      case 'non_adjacent_repeat':
        score += 6;
        break;
      case 'backtrack':
        score += 3;
        break;
      case 'degenerate_segment':
        score += 1;
        break;
    }
  }
  return score;
}

// Audit a single ring
function auditRing(ring: [number, number][], partIndex: number, ringIndex: number): Issue[] {
  const issues: Issue[] = [];
  
  issues.push(...checkNonAdjacentRepeats(ring, partIndex, ringIndex));
  issues.push(...checkBacktracks(ring, partIndex, ringIndex));
  issues.push(...checkDegenerateSegments(ring, partIndex, ringIndex));
  issues.push(...checkSelfCrossings(ring, partIndex, ringIndex));
  
  return issues;
}

// Audit a municipality feature
function auditMunicipality(feature: any): MunicipalityAudit | null {
  const props = feature.properties || {};
  
  // Only process municipalities
  if (props.feature_type !== 'municipality') {
    return null;
  }
  
  const name = props.municipality_name || 'UNKNOWN';
  const mid = props.mid || props.municipality_id;
  const geometry = feature.geometry;
  
  if (!geometry || !geometry.coordinates) {
    return null;
  }
  
  const geometryType = geometry.type;
  const allIssues: Issue[] = [];
  let totalVertices = 0;
  
  // Process Polygon or MultiPolygon
  if (geometryType === 'Polygon') {
    const rings = geometry.coordinates;
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
      const ring = rings[ringIndex] as [number, number][];
      totalVertices += ring.length;
      const issues = auditRing(ring, 0, ringIndex);
      allIssues.push(...issues);
    }
  } else if (geometryType === 'MultiPolygon') {
    const parts = geometry.coordinates;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const rings = parts[partIndex];
      for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        const ring = rings[ringIndex] as [number, number][];
        totalVertices += ring.length;
        const issues = auditRing(ring, partIndex, ringIndex);
        allIssues.push(...issues);
      }
    }
  } else {
    // Skip non-polygon geometries
    return null;
  }
  
  const severityScore = calculateSeverityScore(allIssues);
  
  return {
    name,
    mid,
    geometry_type: geometryType,
    total_vertices_estimate: totalVertices,
    issues: allIssues,
    issue_severity_score: severityScore
  };
}

// Main function
function main(): void {
  console.log('Loading GeoJSON...');
  const geojson = JSON.parse(readFileSync(GEOJSON_PATH, 'utf8'));
  
  console.log('Auditing municipality geometries...');
  const municipalities: MunicipalityAudit[] = [];
  
  for (const feature of geojson.features || []) {
    const audit = auditMunicipality(feature);
    if (audit) {
      municipalities.push(audit);
    }
  }
  
  // Sort by name for deterministic output
  municipalities.sort((a, b) => a.name.localeCompare(b.name));
  
  // Calculate summary
  const municipalitiesWithIssues = municipalities.filter(m => m.issues.length > 0);
  const totalIssuesByType = {
    non_adjacent_repeat: 0,
    backtrack: 0,
    degenerate_segment: 0,
    self_crossing_candidate: 0
  };
  
  for (const muni of municipalities) {
    for (const issue of muni.issues) {
      totalIssuesByType[issue.type]++;
    }
  }
  
  const report: AuditReport = {
    summary: {
      municipalities_total: municipalities.length,
      municipalities_with_any_issue: municipalitiesWithIssues.length,
      total_issues_by_type: totalIssuesByType
    },
    municipalities
  };
  
  // Write JSON report
  console.log('Writing JSON report...');
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  
  // Write TXT report
  console.log('Writing TXT report...');
  let txt = 'MUNICIPALITY GEOMETRY AUDIT REPORT\n';
  txt += '=====================================\n\n';
  txt += `Summary:\n`;
  txt += `  Total municipalities: ${report.summary.municipalities_total}\n`;
  txt += `  Municipalities with issues: ${report.summary.municipalities_with_any_issue}\n`;
  txt += `  Total issues by type:\n`;
  txt += `    Non-adjacent repeats: ${totalIssuesByType.non_adjacent_repeat}\n`;
  txt += `    Backtracks: ${totalIssuesByType.backtrack}\n`;
  txt += `    Degenerate segments: ${totalIssuesByType.degenerate_segment}\n`;
  txt += `    Self-crossing candidates: ${totalIssuesByType.self_crossing_candidate}\n\n`;
  
  // Top offenders (sorted by severity score desc, then name asc)
  const offenders = municipalities
    .filter(m => m.issues.length > 0)
    .sort((a, b) => {
      if (b.issue_severity_score !== a.issue_severity_score) {
        return b.issue_severity_score - a.issue_severity_score;
      }
      return a.name.localeCompare(b.name);
    });
  
  txt += 'TOP OFFENDERS (by severity score):\n';
  txt += '==================================\n\n';
  
  for (const muni of offenders) {
    txt += `${muni.name}${muni.mid ? ` (mid: ${muni.mid})` : ''}\n`;
    txt += `  Geometry type: ${muni.geometry_type}\n`;
    txt += `  Total vertices: ${muni.total_vertices_estimate}\n`;
    txt += `  Severity score: ${muni.issue_severity_score}\n`;
    txt += `  Issues: ${muni.issues.length}\n`;
    
    // Group issues by type
    const issuesByType = new Map<string, Issue[]>();
    for (const issue of muni.issues) {
      if (!issuesByType.has(issue.type)) {
        issuesByType.set(issue.type, []);
      }
      issuesByType.get(issue.type)!.push(issue);
    }
    
    for (const [type, issues] of Array.from(issuesByType.entries()).sort()) {
      txt += `    ${type}: ${issues.length}\n`;
      // Show first 3 issues of each type
      for (let i = 0; i < Math.min(3, issues.length); i++) {
        const issue = issues[i];
        txt += `      - Part ${issue.part_index}, Ring ${issue.ring_index}, Indices: [${issue.indices.join(', ')}]\n`;
        if (issue.snippet) {
          txt += `        ${issue.snippet}\n`;
        }
      }
      if (issues.length > 3) {
        txt += `      ... and ${issues.length - 3} more\n`;
      }
    }
    txt += '\n';
  }
  
  // Special section for Velika Kladusa
  const velikaKladusa = municipalities.find(m => 
    m.name.toLowerCase().includes('velika') && m.name.toLowerCase().includes('kladusa')
  );
  
  if (velikaKladusa) {
    txt += '\n\nVELIKA KLADUSA (Dedicated Section):\n';
    txt += '===================================\n\n';
    txt += `Name: ${velikaKladusa.name}\n`;
    txt += `${velikaKladusa.mid ? `MID: ${velikaKladusa.mid}\n` : ''}`;
    txt += `Geometry type: ${velikaKladusa.geometry_type}\n`;
    txt += `Total vertices: ${velikaKladusa.total_vertices_estimate}\n`;
    txt += `Severity score: ${velikaKladusa.issue_severity_score}\n`;
    txt += `Total issues: ${velikaKladusa.issues.length}\n\n`;
    
    // Find first non-adjacent repeat
    const firstRepeat = velikaKladusa.issues.find(i => i.type === 'non_adjacent_repeat');
    if (firstRepeat) {
      txt += 'First detected non-adjacent repeat:\n';
      txt += `  Part ${firstRepeat.part_index}, Ring ${firstRepeat.ring_index}\n`;
      txt += `  Indices: [${firstRepeat.indices.join(', ')}]\n`;
      if (firstRepeat.coord) {
        txt += `  Coordinate: [${firstRepeat.coord[0].toFixed(6)}, ${firstRepeat.coord[1].toFixed(6)}]\n`;
      }
      if (firstRepeat.snippet) {
        txt += `  Snippet:\n    ${firstRepeat.snippet}\n`;
      }
    } else {
      // Show first issue of any type
      const firstIssue = velikaKladusa.issues[0];
      if (firstIssue) {
        txt += `First detected issue (${firstIssue.type}):\n`;
        txt += `  Part ${firstIssue.part_index}, Ring ${firstIssue.ring_index}\n`;
        txt += `  Indices: [${firstIssue.indices.join(', ')}]\n`;
        if (firstIssue.snippet) {
          txt += `  Snippet:\n    ${firstIssue.snippet}\n`;
        }
      }
    }
  }
  
  mkdirSync(dirname(OUTPUT_TXT), { recursive: true });
  writeFileSync(OUTPUT_TXT, txt, 'utf8');
  
  console.log(`\nAudit complete!`);
  console.log(`  JSON report: ${OUTPUT_JSON}`);
  console.log(`  TXT report: ${OUTPUT_TXT}`);
  console.log(`  Municipalities audited: ${municipalities.length}`);
  console.log(`  Municipalities with issues: ${municipalitiesWithIssues.length}`);
  
  if (velikaKladusa) {
    console.log(`\n  Velika Kladusa found with ${velikaKladusa.issues.length} issues (severity: ${velikaKladusa.issue_severity_score})`);
  }
}

main();
