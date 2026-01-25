import { GameState } from '../state/game_state.js';
import { EdgeRecord } from '../map/settlements.js';
import { ValidationIssue } from './validate.js';

export function validateFrontSegments(
  state: GameState,
  settlementEdges: EdgeRecord[],
  options?: { settlementIds?: Iterable<string> }
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const turn = state?.meta?.turn;
  const currentTurn = Number.isInteger(turn) ? (turn as number) : null;

  const segments = (state as any)?.front_segments as Record<string, any> | undefined;
  if (!segments || typeof segments !== 'object') return issues;

  // Deterministic key iteration.
  const keys = Object.keys(segments).sort();

  // Build adjacency set for (a__b) membership checks (deterministic content, order independent).
  const adjacency = new Set<string>();
  for (const e of settlementEdges ?? []) {
    if (!e || typeof e.a !== 'string' || typeof e.b !== 'string') continue;
    const a = e.a;
    const b = e.b;
    if (a === b) continue;
    adjacency.add(a < b ? `${a}__${b}` : `${b}__${a}`);
  }

  const settlementIdSet = options?.settlementIds ? new Set(Array.from(options.settlementIds)) : null;

  // Optional size sanity (warning only).
  const edgeCount = Array.isArray(settlementEdges) ? settlementEdges.length : 0;
  const segmentCount = keys.length;
  if (edgeCount > 0 && segmentCount > edgeCount * 5) {
    issues.push({
      severity: 'warn',
      code: 'front_segments.size.suspicious',
      message: `front_segments has ${segmentCount} record(s) vs ${edgeCount} settlement edge(s)`
    });
  }

  for (const key of keys) {
    const seg = segments[key];
    const basePath = `front_segments.${key}`;

    // A) edge_id format + B) consistency
    if (typeof key !== 'string' || !key.includes('__')) {
      issues.push({
        severity: 'error',
        code: 'front_segments.edge_id.format',
        path: basePath,
        message: 'edge_id key must contain "__" delimiter'
      });
      continue;
    }

    const parts = key.split('__');
    if (parts.length !== 2) {
      issues.push({
        severity: 'error',
        code: 'front_segments.edge_id.format',
        path: basePath,
        message: 'edge_id must split into exactly two settlement ids'
      });
      continue;
    }

    const [a, b] = parts;
    if (!(a < b)) {
      issues.push({
        severity: 'error',
        code: 'front_segments.edge_id.non_canonical',
        path: basePath,
        message: `edge_id must be canonical with a < b (got "${a}" and "${b}")`
      });
    }

    const expected = `${a}__${b}`;
    if (key !== expected) {
      issues.push({
        severity: 'error',
        code: 'front_segments.edge_id.mismatch',
        path: basePath,
        message: `edge_id must equal "${expected}"`
      });
    }

    // D) settlement id existence (hard error) + adjacency membership (warning)
    if (settlementIdSet) {
      if (!settlementIdSet.has(a) || !settlementIdSet.has(b)) {
        issues.push({
          severity: 'error',
          code: 'front_segments.sid.unknown',
          path: basePath,
          message: `edge_id references unknown settlement id(s): ${!settlementIdSet.has(a) ? a : ''}${!settlementIdSet.has(a) && !settlementIdSet.has(b) ? ', ' : ''}${!settlementIdSet.has(b) ? b : ''}`
        });
      }
    }

    if (!adjacency.has(expected)) {
      issues.push({
        severity: 'warn',
        code: 'front_segments.edge.not_adjacent',
        path: basePath,
        message: 'edge_id is not present in settlement_edges (segment may be stale historical record)'
      });
    }

    // C) segment field sanity (bounds-only; deterministic)
    if (!seg || typeof seg !== 'object') continue;

    const createdTurn = (seg as any).created_turn;
    if (Number.isInteger(createdTurn) && currentTurn !== null) {
      if (createdTurn > currentTurn) {
        issues.push({
          severity: 'error',
          code: 'front_segments.turn.created.invalid',
          path: `${basePath}.created_turn`,
          message: `created_turn (${createdTurn}) must be <= current turn (${currentTurn})`
        });
      }
    }

    const active = (seg as any).active === true;
    const sinceTurn = (seg as any).since_turn;
    const lastActiveTurn = (seg as any).last_active_turn;
    const activeStreak = (seg as any).active_streak;
    const maxActiveStreak = (seg as any).max_active_streak;
    const friction = (seg as any).friction;
    const maxFriction = (seg as any).max_friction;

    // E) streak sanity (deterministic)
    if (!Number.isInteger(activeStreak) || activeStreak < 0) {
      issues.push({
        severity: 'error',
        code: 'front_segments.streak.active.invalid',
        path: `${basePath}.active_streak`,
        message: 'active_streak must be an integer >= 0'
      });
    }
    if (!Number.isInteger(maxActiveStreak) || maxActiveStreak < 0) {
      issues.push({
        severity: 'error',
        code: 'front_segments.streak.max.invalid',
        path: `${basePath}.max_active_streak`,
        message: 'max_active_streak must be an integer >= 0'
      });
    }
    if (Number.isInteger(activeStreak) && Number.isInteger(maxActiveStreak)) {
      if (maxActiveStreak < activeStreak) {
        issues.push({
          severity: 'error',
          code: 'front_segments.streak.max_lt_active',
          path: `${basePath}.max_active_streak`,
          message: `max_active_streak (${maxActiveStreak}) must be >= active_streak (${activeStreak})`
        });
      }
    }
    if (!active) {
      if (Number.isInteger(activeStreak) && activeStreak !== 0) {
        issues.push({
          severity: 'warn',
          code: 'front_segments.streak.inactive_nonzero',
          path: `${basePath}.active_streak`,
          message: 'active_streak should be 0 when active=false'
        });
      }
    }

    // F) friction sanity (deterministic)
    if (!Number.isInteger(friction) || friction < 0) {
      issues.push({
        severity: 'error',
        code: 'front_segments.friction.current.invalid',
        path: `${basePath}.friction`,
        message: 'friction must be an integer >= 0'
      });
    }
    if (!Number.isInteger(maxFriction) || maxFriction < 0) {
      issues.push({
        severity: 'error',
        code: 'front_segments.friction.max.invalid',
        path: `${basePath}.max_friction`,
        message: 'max_friction must be an integer >= 0'
      });
    }
    if (Number.isInteger(friction) && Number.isInteger(maxFriction)) {
      if (maxFriction < friction) {
        issues.push({
          severity: 'error',
          code: 'front_segments.friction.max_lt_current',
          path: `${basePath}.max_friction`,
          message: `max_friction (${maxFriction}) must be >= friction (${friction})`
        });
      }
    }

    if (active) {
      if (!Number.isInteger(sinceTurn)) {
        issues.push({
          severity: 'error',
          code: 'front_segments.turn.since.missing',
          path: `${basePath}.since_turn`,
          message: 'since_turn must be an integer when active=true'
        });
      }

      if (Number.isInteger(lastActiveTurn) && currentTurn !== null) {
        if (lastActiveTurn > currentTurn) {
          issues.push({
            severity: 'error',
            code: 'front_segments.turn.last_active.invalid',
            path: `${basePath}.last_active_turn`,
            message: `last_active_turn (${lastActiveTurn}) must be <= current turn (${currentTurn})`
          });
        }
      }
    } else {
      if (lastActiveTurn !== null && lastActiveTurn !== undefined) {
        if (Number.isInteger(lastActiveTurn) && currentTurn !== null && lastActiveTurn > currentTurn) {
          issues.push({
            severity: 'error',
            code: 'front_segments.turn.last_active.invalid',
            path: `${basePath}.last_active_turn`,
            message: `last_active_turn (${lastActiveTurn}) must be <= current turn (${currentTurn})`
          });
        }
      }
    }
  }

  return issues;
}

