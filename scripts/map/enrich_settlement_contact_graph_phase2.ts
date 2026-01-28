/**
 * Phase 2: Enrich Settlement Contact Graph
 *
 * Reads Phase 1 contact graph and settlement substrate; produces enriched graph
 * plus audit JSON/TXT. Follows docs/specs/map/phase2_contact_graph_enrichment.md.
 *
 * - Same nodes, same edges as Phase 1; additive fields only.
 * - No geometry invention, no pruning, no timestamps, no randomness.
 * - Deterministic: stable node order (sid), edge order (min,max endpoint, type).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

loadMistakes();
assertNoRepeat('phase2 contact graph enrichment artifact generation');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SUBSTRATE_PATH = resolve(ROOT, 'data/derived/settlements_substrate.geojson');
const GRAPH_PATH = resolve(ROOT, 'data/derived/settlement_contact_graph.json');
const ENRICHED_PATH = resolve(ROOT, 'data/derived/settlement_contact_graph_enriched.json');
const AUDIT_JSON_PATH = resolve(ROOT, 'data/derived/settlement_contact_graph_enriched.audit.json');
const AUDIT_TXT_PATH = resolve(ROOT, 'data/derived/settlement_contact_graph_enriched.audit.txt');

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface Phase1Node {
  sid: string;
}

interface Phase1Edge {
  a: string;
  b: string;
  type: 'shared_border' | 'point_touch' | 'distance_contact';
  overlap_len?: number;
  min_dist?: number;
}

interface Phase1Graph {
  schema_version?: number;
  parameters?: Record<string, unknown>;
  nodes: Phase1Node[];
  edges: Phase1Edge[];
}

function sha256Hex(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function extractSid(f: GeoJSONFeature): string | null {
  const p = f.properties;
  if (p?.sid != null) return String(p.sid);
  if (p?.settlement_id != null) return String(p.settlement_id);
  return null;
}

function isPoly(geom: GeoJSONFeature['geometry']): boolean {
  return geom.type === 'Polygon' || geom.type === 'MultiPolygon';
}

function rings(geom: GeoJSONFeature['geometry']): Ring[] {
  const out: Ring[] = [];
  if (geom.type === 'Polygon') {
    const poly = geom.coordinates as Polygon;
    for (const r of poly) out.push(r);
  } else if (geom.type === 'MultiPolygon') {
    const mp = geom.coordinates as MultiPolygon;
    for (const poly of mp) {
      for (const r of poly) out.push(r);
    }
  }
  return out;
}

function ringArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(sum) * 0.5;
}

function ringPerimeter(ring: Ring): number {
  let p = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[j][0] - ring[i][0];
    const dy = ring[j][1] - ring[i][1];
    p += Math.sqrt(dx * dx + dy * dy);
  }
  return p;
}

function ringCentroid(ring: Ring): Point {
  const n = ring.length;
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const t = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    a += t;
    cx += (ring[i][0] + ring[j][0]) * t;
    cy += (ring[i][1] + ring[j][1]) * t;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-20) {
    cx = ring.reduce((s, p) => s + p[0], 0) / n;
    cy = ring.reduce((s, p) => s + p[1], 0) / n;
    return [cx, cy];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

function bboxFromRings(rrs: Ring[]): [number, number, number, number] | null {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const r of rrs) {
    for (const [x, y] of r) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  }
  if (minx === Infinity) return null;
  return [minx, miny, maxx, maxy];
}

interface NodeMetrics {
  area_svg2: number | null;
  perimeter_svg: number | null;
  centroid_svg: Point | null;
  bbox_svg: [number, number, number, number] | null;
}

function computeNodeMetrics(geom: GeoJSONFeature['geometry']): NodeMetrics {
  const result: NodeMetrics = {
    area_svg2: null,
    perimeter_svg: null,
    centroid_svg: null,
    bbox_svg: null,
  };
  if (!isPoly(geom)) return result;
  const rrs = rings(geom);
  if (rrs.length === 0) return result;

  let area = 0;
  let perim = 0;
  let cx = 0;
  let cy = 0;
  const weights: number[] = [];
  for (const r of rrs) {
    const a = ringArea(r);
    const p = ringPerimeter(r);
    area += a;
    perim += p;
    const [cxr, cyr] = ringCentroid(r);
    weights.push(a);
    cx += cxr * a;
    cy += cyr * a;
  }
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW > 0) {
    cx /= totalW;
    cy /= totalW;
  }
  result.area_svg2 = area;
  result.perimeter_svg = perim;
  result.centroid_svg = [cx, cy];
  result.bbox_svg = bboxFromRings(rrs);
  return result;
}

function bboxArea(b: [number, number, number, number]): number {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  return w * h;
}

function bboxIntersectionUnion(
  a: [number, number, number, number],
  b: [number, number, number, number]
): { intersection: number; union: number } {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  const u = bboxArea(a) + bboxArea(b) - inter;
  return { intersection: inter, union: u };
}

function dist(a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  ensure(s: string): void {
    if (!this.parent.has(s)) {
      this.parent.set(s, s);
      this.rank.set(s, 0);
    }
  }

  find(s: string): string {
    this.ensure(s);
    let p = this.parent.get(s)!;
    if (p !== s) {
      p = this.find(p);
      this.parent.set(s, p);
    }
    return p;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  components(): Map<string, string[]> {
    const byRoot = new Map<string, string[]>();
    for (const s of this.parent.keys()) {
      const r = this.find(s);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r)!.push(s);
    }
    return byRoot;
  }
}

function main(): void {
  const substrateRaw = readFileSync(SUBSTRATE_PATH, 'utf8');
  const graphRaw = readFileSync(GRAPH_PATH, 'utf8');
  const substrate: GeoJSONFC = JSON.parse(substrateRaw);
  const graph: Phase1Graph = JSON.parse(graphRaw);

  const sidToMetrics = new Map<string, NodeMetrics>();
  for (const f of substrate.features) {
    const sid = extractSid(f);
    if (!sid) continue;
    if (!isPoly(f.geometry)) continue;
    sidToMetrics.set(sid, computeNodeMetrics(f.geometry));
  }

  const nodes = graph.nodes;
  const edges = graph.edges;
  const degree = new Map<string, number>();
  for (const n of nodes) {
    degree.set(n.sid, 0);
  }
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  const uf = new UnionFind();
  for (const n of nodes) uf.ensure(n.sid);
  for (const e of edges) uf.union(e.a, e.b);
  const compMap = uf.components();
  const compList = [...compMap.values()].map((sids) => [...sids].sort());
  compList.sort((a, b) => {
    const ma = a[0];
    const mb = b[0];
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });
  const sidToComp = new Map<string, number>();
  for (let i = 0; i < compList.length; i++) {
    for (const s of compList[i]) {
      sidToComp.set(s, i + 1);
    }
  }

  const missingNodeMetrics: string[] = [];
  const missingEdgeMetrics: string[] = [];

  const enrichedNodes = nodes.map((n) => {
    const m = sidToMetrics.get(n.sid) ?? null;
    const deg = degree.get(n.sid) ?? 0;
    const comp = sidToComp.get(n.sid) ?? null;
    if (!m) missingNodeMetrics.push(n.sid);
    const obj: Record<string, unknown> = {
      sid: n.sid,
      degree: deg,
      area_svg2: m?.area_svg2 ?? null,
      perimeter_svg: m?.perimeter_svg ?? null,
      centroid_svg: m?.centroid_svg ?? null,
      bbox_svg: m?.bbox_svg ?? null,
      comp_count: comp,
    };
    return obj;
  });

  const enrichedEdges = edges.map((e) => {
    const ma = sidToMetrics.get(e.a) ?? null;
    const mb = sidToMetrics.get(e.b) ?? null;
    let centroid_distance_svg: number | null = null;
    let area_ratio: number | null = null;
    let perimeter_ratio: number | null = null;
    let bbox_overlap_ratio: number | null = null;
    let contact_span_svg: number | null = null;

    if (ma?.centroid_svg && mb?.centroid_svg) {
      centroid_distance_svg = dist(ma.centroid_svg, mb.centroid_svg);
    }
    if (ma?.area_svg2 != null && mb?.area_svg2 != null && Math.max(ma.area_svg2, mb.area_svg2) > 0) {
      area_ratio = Math.min(ma.area_svg2, mb.area_svg2) / Math.max(ma.area_svg2, mb.area_svg2);
    }
    if (ma?.perimeter_svg != null && mb?.perimeter_svg != null && Math.max(ma.perimeter_svg, mb.perimeter_svg) > 0) {
      perimeter_ratio = Math.min(ma.perimeter_svg, mb.perimeter_svg) / Math.max(ma.perimeter_svg, mb.perimeter_svg);
    }
    if (ma?.bbox_svg && mb?.bbox_svg) {
      const { intersection, union } = bboxIntersectionUnion(ma.bbox_svg, mb.bbox_svg);
      bbox_overlap_ratio = union > 0 ? intersection / union : 0;
    }
    if (e.type === 'shared_border') {
      contact_span_svg = e.overlap_len ?? null;
      if (e.overlap_len == null) missingEdgeMetrics.push(`${e.a}–${e.b} (shared_border overlap_len)`);
    } else if (e.type === 'point_touch') {
      contact_span_svg = 0;
    } else if (e.type === 'distance_contact') {
      contact_span_svg = e.min_dist ?? null;
      if (e.min_dist == null) missingEdgeMetrics.push(`${e.a}–${e.b} (distance_contact min_dist)`);
    }

    const obj: Record<string, unknown> = {
      a: e.a,
      b: e.b,
      type: e.type,
      ...(e.overlap_len != null && e.type === 'shared_border' ? { overlap_len: e.overlap_len } : {}),
      ...(e.min_dist != null && e.type === 'distance_contact' ? { min_dist: e.min_dist } : {}),
      centroid_distance_svg,
      area_ratio,
      perimeter_ratio,
      bbox_overlap_ratio,
      contact_span_svg,
    };
    return obj;
  });

  const nodeOrder = (a: { sid: string }, b: { sid: string }) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0);
  enrichedNodes.sort(nodeOrder);

  const edgeOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ma = String(a.a);
    const mb = String(a.b);
    const pa = String(b.a);
    const pb = String(b.b);
    const min1 = ma < mb ? ma : mb;
    const max1 = ma < mb ? mb : ma;
    const min2 = pa < pb ? pa : pb;
    const max2 = pa < pb ? pb : pa;
    if (min1 !== min2) return min1 < min2 ? -1 : 1;
    if (max1 !== max2) return max1 < max2 ? -1 : 1;
    const ta = String(a.type);
    const tb = String(b.type);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  };
  enrichedEdges.sort(edgeOrder);

  const schema_version = graph.schema_version ?? 1;
  const parameters = graph.parameters ?? {};
  const enriched = {
    schema_version,
    parameters: { ...parameters, phase: 2 },
    nodes: enrichedNodes,
    edges: enrichedEdges,
  };

  const outDir = resolve(ROOT, 'data/derived');
  mkdirSync(outDir, { recursive: true });
  const enrichedJson = JSON.stringify(enriched, null, 2);
  writeFileSync(ENRICHED_PATH, enrichedJson, 'utf8');

  const edgesByType = {
    shared_border: edges.filter((e) => e.type === 'shared_border').length,
    point_touch: edges.filter((e) => e.type === 'point_touch').length,
    distance_contact: edges.filter((e) => e.type === 'distance_contact').length,
  };
  const degrees = enrichedNodes.map((n) => (n.degree as number)).filter(Number.isFinite);
  const sortedDegrees = [...degrees].sort((a, b) => a - b);
  const minD = sortedDegrees[0] ?? 0;
  const maxD = sortedDegrees[sortedDegrees.length - 1] ?? 0;
  const medianD = sortedDegrees[Math.floor(sortedDegrees.length / 2)] ?? 0;
  const p90i = Math.floor(sortedDegrees.length * 0.9);
  const p90D = sortedDegrees[p90i] ?? 0;
  const topByDegree = [...enrichedNodes]
    .sort((a, b) => (b.degree as number) - (a.degree as number))
    .slice(0, 10)
    .map((n) => ({ sid: n.sid, degree: n.degree }));

  const shaSubstrate = sha256Hex(SUBSTRATE_PATH);
  const shaGraph = sha256Hex(GRAPH_PATH);
  const shaEnriched = sha256Hex(ENRICHED_PATH);

  const audit = {
    schema_version: 1,
    source_paths: {
      substrate: SUBSTRATE_PATH,
      phase1_graph: GRAPH_PATH,
    },
    parameters: { phase2_parameters: 'none' },
    counts: {
      nodes: enrichedNodes.length,
      edges_total: enrichedEdges.length,
      edges_shared_border: edgesByType.shared_border,
      edges_point_touch: edgesByType.point_touch,
      edges_distance_contact: edgesByType.distance_contact,
    },
    invariants: {
      node_count_matches_phase1: nodes.length === enrichedNodes.length,
      edge_count_matches_phase1: edges.length === enrichedEdges.length,
    },
    determinism: {
      node_ordering: 'stable_sid_lexicographic',
      edge_ordering: 'stable_lexicographic_pair_then_type',
      no_timestamps: true,
      no_randomness: true,
    },
    degree_stats: { min: minD, max: maxD, median: medianD, p90: p90D },
    top_settlements_by_degree: topByDegree,
    component_analysis: {
      component_count: compList.length,
      largest_component_size:
        compList.length === 0 ? 0 : Math.max(...compList.map((c) => c.length)),
      largest_component_percentage:
        compList.length === 0 || nodes.length === 0
          ? 0
          : (Math.max(...compList.map((c) => c.length)) / nodes.length) * 100,
    },
    sha256: {
      input_substrate: shaSubstrate,
      input_phase1_graph: shaGraph,
      output_enriched_json: shaEnriched,
    },
    missing_metrics: {
      node_sids: missingNodeMetrics,
      edge_pairs: missingEdgeMetrics,
    },
  };

  const auditJsonWithoutSelfHash = JSON.stringify(audit, null, 2);
  const shaAudit = createHash('sha256').update(auditJsonWithoutSelfHash, 'utf8').digest('hex');
  (audit.sha256 as Record<string, string>).output_audit_json = shaAudit;
  const auditJson = JSON.stringify(audit, null, 2);
  writeFileSync(AUDIT_JSON_PATH, auditJson, 'utf8');

  const txtLines: string[] = [
    'SETTLEMENT CONTACT GRAPH ENRICHED — AUDIT REPORT',
    'Phase 2 Contact Graph Enrichment',
    '',
    'SOURCES',
    `  Substrate: ${SUBSTRATE_PATH}`,
    `  Phase 1 graph: ${GRAPH_PATH}`,
    '',
    'COUNTS',
    `  Nodes: ${audit.counts.nodes}`,
    `  Edges total: ${audit.counts.edges_total}`,
    `    - Shared border: ${audit.counts.edges_shared_border}`,
    `    - Point touch: ${audit.counts.edges_point_touch}`,
    `    - Distance contact: ${audit.counts.edges_distance_contact}`,
    '',
    'INVARIANTS',
    `  Node count matches Phase 1: ${audit.invariants.node_count_matches_phase1}`,
    `  Edge count matches Phase 1: ${audit.invariants.edge_count_matches_phase1}`,
    '',
    'DETERMINISM',
    `  Node ordering: ${audit.determinism.node_ordering}`,
    `  Edge ordering: ${audit.determinism.edge_ordering}`,
    `  No timestamps: ${audit.determinism.no_timestamps}`,
    `  No randomness: ${audit.determinism.no_randomness}`,
    '',
    'DEGREE STATISTICS',
    `  Min: ${audit.degree_stats.min}`,
    `  Max: ${audit.degree_stats.max}`,
    `  Median: ${audit.degree_stats.median}`,
    `  P90: ${audit.degree_stats.p90}`,
    '',
    'COMPONENT ANALYSIS',
    `  Component count: ${audit.component_analysis.component_count}`,
    `  Largest component size: ${audit.component_analysis.largest_component_size}`,
    `  Largest component %: ${audit.component_analysis.largest_component_percentage.toFixed(2)}%`,
    '',
    'SHA256',
    `  Input substrate: ${audit.sha256.input_substrate}`,
    `  Input Phase 1 graph: ${audit.sha256.input_phase1_graph}`,
    `  Output enriched JSON: ${audit.sha256.output_enriched_json}`,
    `  Output audit JSON: ${(audit.sha256 as Record<string, string>).output_audit_json}`,
    '',
    'MISSING METRICS',
    `  Node SIDs: ${audit.missing_metrics.node_sids.length}`,
    ...audit.missing_metrics.node_sids.slice(0, 20).map((s) => `    - ${s}`),
    ...(audit.missing_metrics.node_sids.length > 20 ? [`    ... and ${audit.missing_metrics.node_sids.length - 20} more`] : []),
    `  Edge pairs: ${audit.missing_metrics.edge_pairs.length}`,
    ...audit.missing_metrics.edge_pairs.slice(0, 20).map((s) => `    - ${s}`),
    ...(audit.missing_metrics.edge_pairs.length > 20 ? [`    ... and ${audit.missing_metrics.edge_pairs.length - 20} more`] : []),
  ];
  writeFileSync(AUDIT_TXT_PATH, txtLines.join('\n'), 'utf8');
}

main();
