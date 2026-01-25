import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SettlementRecord {
  sid: string;
  source_id: string;
  mun_code: string;
  mun: string;
  name?: string;
  properties?: {
    is_orphan?: boolean;
    usesFallbackGeometry?: boolean;
    [key: string]: unknown;
  };
}

export interface EdgeRecord {
  a: string;
  b: string;
  one_way?: boolean;
  allow_self_loop?: boolean;
}

export interface LoadedSettlementGraph {
  settlements: Map<string, SettlementRecord>;
  edges: EdgeRecord[];
}

export interface GraphValidationIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  path?: string;
}

export async function loadSettlementGraph(options?: {
  settlementsPath?: string;
  edgesPath?: string;
  enrichWithOrphanFlags?: boolean;
}): Promise<LoadedSettlementGraph> {
  const settlementsPath = resolve(options?.settlementsPath ?? 'data/derived/settlements_index.json');
  const edgesPath = resolve(options?.edgesPath ?? 'data/derived/settlement_edges.json');

  const settlementsJson = JSON.parse(await readFile(settlementsPath, 'utf8')) as unknown;
  const edgesJson = JSON.parse(await readFile(edgesPath, 'utf8')) as unknown;

  const settlements = parseSettlements(settlementsJson);
  const edges = parseEdges(edgesJson);

  // Optionally enrich with orphan flags (in memory only)
  if (options?.enrichWithOrphanFlags) {
    await enrichSettlementsWithOrphanFlags(settlements, edges, settlementsJson);
  }

  return { settlements, edges };
}

/**
 * Enrich settlements with orphan and fallback flags in memory (not written to disk).
 * Computes degree for each settlement and marks orphans.
 * Also checks for fallback geometries from fallback_geometries.json and settlements_index.json.
 */
export async function enrichSettlementsWithOrphanFlags(
  settlements: Map<string, SettlementRecord>,
  edges: EdgeRecord[],
  settlementsJson?: unknown
): Promise<void> {
  // Compute degree
  const degreeMap = new Map<string, number>();
  for (const sid of settlements.keys()) {
    degreeMap.set(sid, 0);
  }
  for (const edge of edges) {
    degreeMap.set(edge.a, (degreeMap.get(edge.a) || 0) + 1);
    degreeMap.set(edge.b, (degreeMap.get(edge.b) || 0) + 1);
  }

  // Load fallback geometries from fallback_geometries.json
  const fallbackSids = new Set<string>();
  try {
    const fallbackPath = resolve('data/derived/fallback_geometries.json');
    const fallbackData = JSON.parse(await readFile(fallbackPath, 'utf8')) as {
      fallbacks?: Array<{ sid: string }>;
    };
    if (fallbackData.fallbacks) {
      for (const fb of fallbackData.fallbacks) {
        fallbackSids.add(fb.sid);
      }
    }
  } catch {
    // File might not exist
  }

  // Also check settlements_index.json for geometry_quality field
  if (settlementsJson && isRecord(settlementsJson)) {
    const settlementsArray = Array.isArray(settlementsJson.settlements)
      ? settlementsJson.settlements
      : null;
    if (settlementsArray) {
      for (const item of settlementsArray) {
        if (isRecord(item) && typeof item.sid === 'string') {
          const geometryQuality = item.geometry_quality;
          if (typeof geometryQuality === 'string' && (
            geometryQuality === 'fallback_replacement' ||
            geometryQuality === 'fallback_convex_hull'
          )) {
            fallbackSids.add(item.sid);
          }
        }
      }
    }
  }

  // Mark orphans and fallback geometries
  for (const [sid, degree] of degreeMap.entries()) {
    const settlement = settlements.get(sid);
    if (settlement) {
      if (!settlement.properties) {
        settlement.properties = {};
      }
      settlement.properties.is_orphan = degree === 0;
      settlement.properties.usesFallbackGeometry = fallbackSids.has(sid);
    }
  }
}

/**
 * Extract base SID (first two segments) from a SID string.
 */
function getBaseSid(sid: string): string | null {
  const parts = sid.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Check if a SID is a base SID (exactly 2 segments).
 */
function isBaseSid(sid: string): boolean {
  const parts = sid.split(':');
  return parts.length === 2;
}

/**
 * Resolve a SID using base-SID resolution if needed.
 * Returns { resolved: true, sid: string } if resolved, or { resolved: false } if not.
 */
function resolveSid(
  sid: string,
  sidSet: Set<string>,
  baseToCandidates: Map<string, string[]>,
  fallbackSids: Set<string>
): { resolved: true; sid: string; unique: boolean } | { resolved: false } {
  // First try exact match
  if (sidSet.has(sid)) {
    return { resolved: true, sid, unique: true };
  }
  
  // If missing and SID is 2 segments, attempt base-SID resolution
  if (isBaseSid(sid)) {
    const candidates = baseToCandidates.get(sid);
    if (candidates && candidates.length > 0) {
      if (candidates.length === 1) {
        // Unique resolution
        return { resolved: true, sid: candidates[0], unique: true };
      } else {
        // Multiple candidates: apply deterministic rule (same as fixer)
        const nonFallbacks = candidates.filter(s => !fallbackSids.has(s));
        let chosen: string;
        if (nonFallbacks.length > 0) {
          chosen = nonFallbacks.sort((x, y) => x.localeCompare(y))[0];
        } else {
          chosen = candidates.sort((x, y) => x.localeCompare(y))[0];
        }
        // Resolved but not unique (multiple candidates, chose deterministically)
        return { resolved: true, sid: chosen, unique: false };
      }
    }
  }
  
  return { resolved: false };
}

export function validateSettlementGraph(
  graph: LoadedSettlementGraph,
  options?: { allowSelfLoopsDefault?: boolean; fallbackSids?: Set<string> }
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const allowSelfLoopsDefault = options?.allowSelfLoopsDefault ?? false;
  const fallbackSids = options?.fallbackSids ?? new Set<string>();

  // Build base SID to candidates mapping
  const baseToCandidates = new Map<string, string[]>();
  const sidSet = new Set<string>(graph.settlements.keys());
  for (const sid of graph.settlements.keys()) {
    const baseSid = getBaseSid(sid);
    if (baseSid && sid !== baseSid) {
      if (!baseToCandidates.has(baseSid)) {
        baseToCandidates.set(baseSid, []);
      }
      baseToCandidates.get(baseSid)!.push(sid);
    }
  }

  const degree = new Map<string, number>();
  for (const id of graph.settlements.keys()) degree.set(id, 0);

  // Track edges as undirected pairs (normalized with a < b)
  const edgeSet = new Set<string>();
  const normalizedEdgeKey = (a: string, b: string) => {
    return a < b ? `${a}--${b}` : `${b}--${a}`;
  };

  // Track resolved SIDs for warnings
  const resolvedSids = new Map<string, { count: number; examples: string[] }>();

  graph.edges.forEach((edge, index) => {
    const basePath = `edges[${index}]`;
    let a = edge.a;
    let b = edge.b;
    let aValid = false;
    let bValid = false;

    // Resolve endpoint a
    const aResolve = resolveSid(a, sidSet, baseToCandidates, fallbackSids);
    if (aResolve.resolved) {
      a = aResolve.sid;
      aValid = true;
      if (aResolve.sid !== edge.a) {
        // Was resolved via base SID
        if (!aResolve.unique) {
          // Multiple candidates, chose deterministically - still warn
          if (!resolvedSids.has(edge.a)) {
            resolvedSids.set(edge.a, { count: 0, examples: [] });
          }
          const info = resolvedSids.get(edge.a)!;
          info.count++;
          if (info.examples.length < 3) {
            info.examples.push(`${basePath}.a`);
          }
        } else {
          // Unique resolution - warn but less severe
          if (!resolvedSids.has(edge.a)) {
            resolvedSids.set(edge.a, { count: 0, examples: [] });
          }
          const info = resolvedSids.get(edge.a)!;
          info.count++;
          if (info.examples.length < 3) {
            info.examples.push(`${basePath}.a`);
          }
        }
      }
    } else {
      issues.push({
        severity: 'error',
        code: 'edge.missing_settlement',
        message: `Edge endpoint a=${edge.a} does not exist in settlements`,
        path: `${basePath}.a`
      });
    }

    // Resolve endpoint b
    const bResolve = resolveSid(b, sidSet, baseToCandidates, fallbackSids);
    if (bResolve.resolved) {
      b = bResolve.sid;
      bValid = true;
      if (bResolve.sid !== edge.b) {
        // Was resolved via base SID
        if (!bResolve.unique) {
          // Multiple candidates, chose deterministically - still warn
          if (!resolvedSids.has(edge.b)) {
            resolvedSids.set(edge.b, { count: 0, examples: [] });
          }
          const info = resolvedSids.get(edge.b)!;
          info.count++;
          if (info.examples.length < 3) {
            info.examples.push(`${basePath}.b`);
          }
        } else {
          // Unique resolution - warn but less severe
          if (!resolvedSids.has(edge.b)) {
            resolvedSids.set(edge.b, { count: 0, examples: [] });
          }
          const info = resolvedSids.get(edge.b)!;
          info.count++;
          if (info.examples.length < 3) {
            info.examples.push(`${basePath}.b`);
          }
        }
      }
    } else {
      issues.push({
        severity: 'error',
        code: 'edge.missing_settlement',
        message: `Edge endpoint b=${edge.b} does not exist in settlements`,
        path: `${basePath}.b`
      });
    }

    const allowSelfLoop = edge.allow_self_loop ?? allowSelfLoopsDefault;
    if (a === b && !allowSelfLoop) {
      issues.push({
        severity: 'error',
        code: 'edge.self_loop_disallowed',
        message: `Self-loop edge ${a} -> ${b} is not allowed`,
        path: basePath
      });
    }

    // Degree counts treat any edge as adjacency (even one-way).
    // Use resolved SIDs for degree counting
    if (aValid) degree.set(a, (degree.get(a) ?? 0) + 1);
    if (bValid) degree.set(b, (degree.get(b) ?? 0) + 1);

    // Check for duplicate edges (same undirected edge represented multiple times)
    // Only check if both endpoints are valid
    if (aValid && bValid) {
      const edgeKey = normalizedEdgeKey(a, b);
      if (edgeSet.has(edgeKey)) {
        issues.push({
          severity: 'error',
          code: 'edge.duplicate',
          message: `Duplicate edge detected: ${a} <-> ${b} (edges are undirected, only one representation should exist)`,
          path: basePath
        });
      }
      edgeSet.add(edgeKey);
    }
  });

  // Note: Adjacency edges are inherently undirected.
  // We represent each edge ONCE as {a, b} where a < b (normalized).
  // No reverse edge check is needed since edges are undirected by default.

  // Report resolved SIDs (warnings)
  if (resolvedSids.size > 0) {
    const resolvedEntries = Array.from(resolvedSids.entries())
      .sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        return a[0].localeCompare(b[0]);
      });
    
    const totalResolved = resolvedEntries.reduce((sum, [_, info]) => sum + info.count, 0);
    const sample = resolvedEntries.slice(0, 5)
      .map(([sid, info]) => `${sid} (${info.count}x, e.g. ${info.examples[0]})`)
      .join(', ');
    const more = resolvedEntries.length > 5 ? ` (and ${resolvedEntries.length - 5} more)` : '';
    
    issues.push({
      severity: 'warn',
      code: 'edge.sid_resolved_via_base',
      message: `${totalResolved} edge endpoint(s) resolved via base SID canonicalization: ${sample}${more}`
    });
  }

  // Orphans (degree 0)
  const orphans: string[] = [];
  for (const [id, d] of degree.entries()) {
    if (d === 0) orphans.push(id);
  }
  if (orphans.length > 0) {
    const sample = orphans.slice(0, 20).join(', ');
    issues.push({
      severity: 'warn',
      code: 'settlement.orphan',
      message:
        orphans.length <= 20
          ? `Orphan settlements (degree 0): ${sample}`
          : `Orphan settlements (degree 0): ${sample} … (+${orphans.length - 20} more)`
    });
  }

  return issues;
}

function parseSettlements(json: unknown): Map<string, SettlementRecord> {
  const map = new Map<string, SettlementRecord>();

  // Expected format: { settlements: [{ sid, source_id, mun_code, mun, name? }, ...] }
  const settlementsArray =
    isRecord(json) && Array.isArray(json.settlements)
      ? json.settlements
      : null;

  if (!settlementsArray) {
    throw new Error('Unsupported settlements_index.json format (expected { settlements: [...] })');
  }

  for (const item of settlementsArray) {
    if (!isRecord(item) || typeof item.sid !== 'string') {
      throw new Error(`Invalid settlement record: missing sid (got ${JSON.stringify(item).substring(0, 100)})`);
    }

    if (typeof item.source_id !== 'string' || typeof item.mun_code !== 'string' || typeof item.mun !== 'string') {
      throw new Error(`Invalid settlement record: missing required fields (sid: ${item.sid})`);
    }

    const record: SettlementRecord = {
      sid: item.sid,
      source_id: item.source_id,
      mun_code: item.mun_code,
      mun: item.mun
    };
    if (typeof item.name === 'string') record.name = item.name;

    // Index by sid (primary key)
    map.set(record.sid, record);
  }

  return map;
}

function parseEdges(json: unknown): EdgeRecord[] {
  // Supported formats:
  // - { edges: [{a,b, one_way?, allow_self_loop?}, ...], allow_self_loops_default? }
  // - [{a,b, one_way?, allow_self_loop?}, ...]
  const edgesArray =
    isRecord(json) && Array.isArray(json.edges)
      ? json.edges
      : Array.isArray(json)
        ? json
        : null;

  if (!edgesArray) throw new Error('Unsupported edges.json format');

  return edgesArray.map((item) => {
    if (!isRecord(item) || typeof item.a !== 'string' || typeof item.b !== 'string') {
      throw new Error('Invalid edge record (expected {a: string, b: string, ...})');
    }
    const edge: EdgeRecord = { a: item.a, b: item.b };
    if (typeof item.one_way === 'boolean') edge.one_way = item.one_way;
    if (typeof item.allow_self_loop === 'boolean') edge.allow_self_loop = item.allow_self_loop;
    return edge;
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

