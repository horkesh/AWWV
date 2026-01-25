import { GameState, SupplyRightsState, SupplyCorridorRight, PoliticalSideId } from '../state/game_state.js';
import { ValidationIssue } from './validate.js';
import { POLITICAL_SIDES } from '../state/identity.js';

/**
 * Validate supply_rights state.
 */
export function validateSupplyRights(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const currentTurn = state?.meta?.turn ?? 0;

  if (!state.supply_rights) {
    return issues; // optional field
  }

  const supplyRights = state.supply_rights;
  if (typeof supplyRights !== 'object') {
    issues.push({
      severity: 'error',
      code: 'supply_rights.invalid',
      path: 'supply_rights',
      message: 'supply_rights must be an object'
    });
    return issues;
  }

  if (!Array.isArray(supplyRights.corridors)) {
    issues.push({
      severity: 'error',
      code: 'supply_rights.corridors.invalid',
      path: 'supply_rights.corridors',
      message: 'supply_rights.corridors must be an array'
    });
    return issues;
  }

  // Validate each corridor
  const seenIds = new Set<string>();
  for (let i = 0; i < supplyRights.corridors.length; i += 1) {
    const corridor = supplyRights.corridors[i];
    const basePath = `supply_rights.corridors[${i}]`;

    if (!corridor || typeof corridor !== 'object') {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.invalid',
        path: basePath,
        message: 'corridor must be an object'
      });
      continue;
    }

    // Validate id
    if (!corridor.id || typeof corridor.id !== 'string' || corridor.id.length === 0) {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.id.invalid',
        path: `${basePath}.id`,
        message: 'corridor.id must be a non-empty string'
      });
    } else if (seenIds.has(corridor.id)) {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.id.duplicate',
        path: `${basePath}.id`,
        message: `duplicate corridor.id: ${corridor.id}`
      });
    } else {
      seenIds.add(corridor.id);
    }

    // Validate treaty_id
    if (!corridor.treaty_id || typeof corridor.treaty_id !== 'string') {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.treaty_id.invalid',
        path: `${basePath}.treaty_id`,
        message: 'corridor.treaty_id must be a non-empty string'
      });
    }

    // Validate beneficiary
    if (!corridor.beneficiary || typeof corridor.beneficiary !== 'string') {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.beneficiary.invalid',
        path: `${basePath}.beneficiary`,
        message: 'corridor.beneficiary must be a non-empty string'
      });
    } else {
      const beneficiaryId = corridor.beneficiary;
      if (!(POLITICAL_SIDES as readonly string[]).includes(beneficiaryId)) {
        issues.push({
          severity: 'warn',
          code: 'supply_rights.corridor.beneficiary.unknown',
          path: `${basePath}.beneficiary`,
          message: `corridor.beneficiary must be a valid political side: ${corridor.beneficiary}`
        });
      }
    }

    // Validate scope
    if (!corridor.scope || typeof corridor.scope !== 'object') {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.scope.invalid',
        path: `${basePath}.scope`,
        message: 'corridor.scope must be an object'
      });
    } else {
      const scope = corridor.scope as any;
      if (scope.kind === 'region') {
        if (typeof scope.region_id !== 'string' || scope.region_id.length === 0) {
          issues.push({
            severity: 'error',
            code: 'supply_rights.corridor.scope.region_id.invalid',
            path: `${basePath}.scope.region_id`,
            message: 'scope.region_id must be a non-empty string'
          });
        }
      } else if (scope.kind === 'edges') {
        if (!Array.isArray(scope.edge_ids)) {
          issues.push({
            severity: 'error',
            code: 'supply_rights.corridor.scope.edge_ids.invalid',
            path: `${basePath}.scope.edge_ids`,
            message: 'scope.edge_ids must be an array'
          });
        } else if (!scope.edge_ids.every((eid: unknown) => typeof eid === 'string' && eid.length > 0)) {
          issues.push({
            severity: 'error',
            code: 'supply_rights.corridor.scope.edge_ids.invalid_item',
            path: `${basePath}.scope.edge_ids`,
            message: 'scope.edge_ids must contain non-empty strings'
          });
        }
      } else if (scope.kind === 'settlements') {
        if (!Array.isArray(scope.sids)) {
          issues.push({
            severity: 'error',
            code: 'supply_rights.corridor.scope.sids.invalid',
            path: `${basePath}.scope.sids`,
            message: 'scope.sids must be an array'
          });
        } else if (!scope.sids.every((sid: unknown) => typeof sid === 'string' && sid.length > 0)) {
          issues.push({
            severity: 'error',
            code: 'supply_rights.corridor.scope.sids.invalid_item',
            path: `${basePath}.scope.sids`,
            message: 'scope.sids must contain non-empty strings'
          });
        }
      } else {
        issues.push({
          severity: 'error',
          code: 'supply_rights.corridor.scope.kind.invalid',
          path: `${basePath}.scope.kind`,
          message: `scope.kind must be one of: region, edges, settlements (got: ${scope.kind})`
        });
      }
    }

    // Validate since_turn
    if (!Number.isInteger(corridor.since_turn) || corridor.since_turn < 0 || corridor.since_turn > currentTurn) {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.since_turn.invalid',
        path: `${basePath}.since_turn`,
        message: `corridor.since_turn must be an integer >= 0 and <= current turn (${currentTurn})`
      });
    }

    // Validate until_turn
    if (corridor.until_turn !== null && (!Number.isInteger(corridor.until_turn) || corridor.until_turn < corridor.since_turn)) {
      issues.push({
        severity: 'error',
        code: 'supply_rights.corridor.until_turn.invalid',
        path: `${basePath}.until_turn`,
        message: 'corridor.until_turn must be null or an integer >= since_turn'
      });
    }
  }

  // Check deterministic ordering: corridors should be sorted by id
  const corridors = supplyRights.corridors;
  for (let i = 1; i < corridors.length; i += 1) {
    const prev = corridors[i - 1];
    const curr = corridors[i];
    if (prev && curr && typeof prev.id === 'string' && typeof curr.id === 'string') {
      if (prev.id.localeCompare(curr.id) > 0) {
        issues.push({
          severity: 'warn',
          code: 'supply_rights.corridors.not_sorted',
          path: 'supply_rights.corridors',
          message: 'corridors should be sorted by id (ascending) for deterministic ordering'
        });
        break; // Only warn once
      }
    }
  }

  return issues;
}
