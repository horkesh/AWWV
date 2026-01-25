import type { GameState, FormationState } from '../state/game_state.js';
import type { FrontRegionsFile } from '../map/front_regions.js';
import type { FrontEdge } from '../map/front_edges.js';
import type { ValidationIssue } from './validate.js';
import { POLITICAL_SIDES, ARMY_LABELS, defaultArmyLabelForSide } from '../state/identity.js';

const MAX_NAME_LENGTH = 80;

export function validateFormations(
  state: GameState,
  frontRegions?: FrontRegionsFile,
  frontEdges?: FrontEdge[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const formations = (state as any)?.formations as Record<string, any> | undefined;
  if (!formations || typeof formations !== 'object') return issues;

  const factionIds = new Set<string>((state.factions ?? []).map((f) => (f as any)?.id).filter((x) => typeof x === 'string'));

  const knownRegionIds = new Set<string>();
  if (frontRegions) {
    for (const r of frontRegions.regions ?? []) {
      if (r && typeof r === 'object' && typeof (r as any).region_id === 'string') knownRegionIds.add((r as any).region_id);
    }
  }

  const knownEdgeIds = new Set<string>();
  if (frontEdges) {
    for (const e of frontEdges) {
      if (e && typeof e === 'object' && typeof e.edge_id === 'string') knownEdgeIds.add(e.edge_id);
    }
  }

  const ids = Object.keys(formations).sort();
  for (const id of ids) {
    const f = formations[id];
    const basePath = `formations.${id}`;
    if (!f || typeof f !== 'object') continue;

    // formation_id key must equal FormationState.id
    const formationId = (f as any).id;
    if (typeof formationId !== 'string' || formationId !== id) {
      issues.push({
        severity: 'error',
        code: 'formations.id.mismatch',
        path: basePath,
        message: `formation_id key (${id}) must equal FormationState.id (${String(formationId)})`
      });
    }

    // id must be non-empty string
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ severity: 'error', code: 'formations.id.invalid', path: basePath, message: 'formation id must be a non-empty string' });
      continue;
    }

    // faction must exist in state.factions and be a political side
    const faction = (f as any).faction;
    if (typeof faction !== 'string' || faction.length === 0) {
      issues.push({
        severity: 'error',
        code: 'formations.faction.invalid',
        path: `${basePath}.faction`,
        message: 'faction must be a non-empty string'
      });
    } else if (!POLITICAL_SIDES.includes(faction as any)) {
      issues.push({
        severity: 'error',
        code: 'formations.faction.not_political_side',
        path: `${basePath}.faction`,
        message: `faction must be one of: ${POLITICAL_SIDES.join(', ')}`
      });
    } else if (!factionIds.has(faction)) {
      issues.push({
        severity: 'error',
        code: 'formations.faction.not_found',
        path: `${basePath}.faction`,
        message: 'faction must reference an existing faction id'
      });
    }
    
    // force_label validation (if present)
    const forceLabel = (f as any).force_label;
    if (forceLabel !== undefined && forceLabel !== null) {
      if (typeof forceLabel !== 'string' || !ARMY_LABELS.includes(forceLabel as any)) {
        issues.push({
          severity: 'error',
          code: 'formations.force_label.invalid',
          path: `${basePath}.force_label`,
          message: `force_label must be one of: ${ARMY_LABELS.join(', ')}`
        });
      } else if (typeof faction === 'string' && POLITICAL_SIDES.includes(faction as any)) {
        // Optional consistency warning: if force_label doesn't match default for faction
        const defaultLabel = defaultArmyLabelForSide(faction as any);
        if (forceLabel !== defaultLabel) {
        issues.push({
          severity: 'warn',
          code: 'formations.force_label.non_default',
          path: `${basePath}.force_label`,
          message: `force_label "${forceLabel}" does not match default "${defaultLabel}" for faction "${faction}" (this is allowed but may indicate cross-labeling)`
        });
        }
      }
    }

    // name must be non-empty, trimmed, max length
    const name = (f as any).name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      issues.push({
        severity: 'error',
        code: 'formations.name.invalid',
        path: `${basePath}.name`,
        message: 'name must be a non-empty string'
      });
    } else if (name.length > MAX_NAME_LENGTH) {
      issues.push({
        severity: 'error',
        code: 'formations.name.too_long',
        path: `${basePath}.name`,
        message: `name must be <= ${MAX_NAME_LENGTH} characters`
      });
    }

    // created_turn <= current turn
    const created_turn = (f as any).created_turn;
    if (!Number.isInteger(created_turn) || created_turn > (state.meta?.turn ?? 0)) {
      issues.push({
        severity: 'error',
        code: 'formations.created_turn.invalid',
        path: `${basePath}.created_turn`,
        message: 'created_turn must be an integer <= current turn'
      });
    }

    // status in enum
    const status = (f as any).status;
    if (status !== 'active' && status !== 'inactive') {
      issues.push({
        severity: 'error',
        code: 'formations.status.invalid',
        path: `${basePath}.status`,
        message: 'status must be one of active|inactive'
      });
    }

    // assignment validation
    const assignment = (f as any).assignment;
    if (assignment !== null && assignment !== undefined) {
      if (typeof assignment !== 'object') {
        issues.push({
          severity: 'error',
          code: 'formations.assignment.invalid',
          path: `${basePath}.assignment`,
          message: 'assignment must be null or an object'
        });
      } else {
        const kind = (assignment as any).kind;
        if (kind !== 'region' && kind !== 'edge') {
          issues.push({
            severity: 'error',
            code: 'formations.assignment.kind.invalid',
            path: `${basePath}.assignment.kind`,
            message: 'assignment.kind must be one of region|edge'
          });
        } else if (kind === 'region') {
          const region_id = (assignment as any).region_id;
          if (typeof region_id !== 'string' || region_id.length === 0) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.region_id.invalid',
              path: `${basePath}.assignment.region_id`,
              message: 'assignment.region_id must be a non-empty string when kind is "region"'
            });
          } else if (frontRegions && knownRegionIds.size > 0 && !knownRegionIds.has(region_id)) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.region_id.unknown',
              path: `${basePath}.assignment.region_id`,
              message: 'assignment.region_id must exist in derived front regions'
            });
          }
          // edge_id should not be present for region kind
          if ((assignment as any).edge_id !== undefined) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.edge_id.unexpected',
              path: `${basePath}.assignment.edge_id`,
              message: 'assignment.edge_id must not be present when kind is "region"'
            });
          }
        } else if (kind === 'edge') {
          const edge_id = (assignment as any).edge_id;
          if (typeof edge_id !== 'string' || edge_id.length === 0) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.edge_id.invalid',
              path: `${basePath}.assignment.edge_id`,
              message: 'assignment.edge_id must be a non-empty string when kind is "edge"'
            });
          } else if (frontEdges && knownEdgeIds.size > 0 && !knownEdgeIds.has(edge_id)) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.edge_id.unknown',
              path: `${basePath}.assignment.edge_id`,
              message: 'assignment.edge_id must exist in derived front edges'
            });
          }
          // region_id should not be present for edge kind
          if ((assignment as any).region_id !== undefined) {
            issues.push({
              severity: 'error',
              code: 'formations.assignment.region_id.unexpected',
              path: `${basePath}.assignment.region_id`,
              message: 'assignment.region_id must not be present when kind is "edge"'
            });
          }
        }
      }
    }

    // Phase 10: ops validation (if present)
    const ops = (f as any).ops;
    if (ops !== undefined) {
      if (typeof ops !== 'object' || ops === null) {
        issues.push({
          severity: 'error',
          code: 'formations.ops.invalid',
          path: `${basePath}.ops`,
          message: 'ops must be an object if present'
        });
      } else {
        const fatigue = (ops as any).fatigue;
        if (!Number.isInteger(fatigue) || fatigue < 0) {
          issues.push({
            severity: 'error',
            code: 'formations.ops.fatigue.invalid',
            path: `${basePath}.ops.fatigue`,
            message: 'ops.fatigue must be an integer >= 0'
          });
        }
        const lastSuppliedTurn = (ops as any).last_supplied_turn;
        if (lastSuppliedTurn !== null && lastSuppliedTurn !== undefined) {
          if (!Number.isInteger(lastSuppliedTurn) || lastSuppliedTurn > (state.meta?.turn ?? 0)) {
            issues.push({
              severity: 'error',
              code: 'formations.ops.last_supplied_turn.invalid',
              path: `${basePath}.ops.last_supplied_turn`,
              message: 'ops.last_supplied_turn must be null or an integer <= current turn'
            });
          }
        }
      }
    }

    // tags validation (if present)
    const tags = (f as any).tags;
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        issues.push({
          severity: 'error',
          code: 'formations.tags.invalid',
          path: `${basePath}.tags`,
          message: 'tags must be an array if present'
        });
      } else {
        const trimmedTags: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < tags.length; i += 1) {
          const tag = tags[i];
          if (typeof tag !== 'string') {
            issues.push({
              severity: 'error',
              code: 'formations.tags.item.invalid',
              path: `${basePath}.tags[${i}]`,
              message: 'tags must contain only strings'
            });
            continue;
          }
          const trimmed = tag.trim();
          if (trimmed.length === 0) {
            issues.push({
              severity: 'error',
              code: 'formations.tags.item.empty',
              path: `${basePath}.tags[${i}]`,
              message: 'tags must not contain empty strings'
            });
            continue;
          }
          if (seen.has(trimmed)) {
            issues.push({
              severity: 'error',
              code: 'formations.tags.duplicate',
              path: `${basePath}.tags[${i}]`,
              message: `tags must be unique (duplicate: ${trimmed})`
            });
            continue;
          }
          seen.add(trimmed);
          trimmedTags.push(trimmed);
        }
      }
    }
  }

  return issues;
}
