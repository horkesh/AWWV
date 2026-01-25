import type { GameState } from '../state/game_state.js';
import type { ValidationIssue } from './validate.js';
import type { FrontEdge } from '../map/front_edges.js';

/**
 * Validate ceasefire structure.
 */
export function validateCeasefire(state: GameState, derivedFrontEdges?: FrontEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const negotiationStatus = state.negotiation_status;
  if (negotiationStatus !== undefined) {
    if (!negotiationStatus || typeof negotiationStatus !== 'object') {
      issues.push({
        severity: 'error',
        code: 'negotiation_status.invalid',
        path: 'negotiation_status',
        message: 'negotiation_status must be an object'
      });
    } else {
      if (typeof negotiationStatus.ceasefire_active !== 'boolean') {
        issues.push({
          severity: 'error',
          code: 'negotiation_status.ceasefire_active.invalid',
          path: 'negotiation_status.ceasefire_active',
          message: 'ceasefire_active must be a boolean'
        });
      }
      const currentTurn = state.meta?.turn ?? 0;
      if (negotiationStatus.ceasefire_since_turn !== null && (!Number.isInteger(negotiationStatus.ceasefire_since_turn) || negotiationStatus.ceasefire_since_turn > currentTurn)) {
        issues.push({
          severity: 'error',
          code: 'negotiation_status.ceasefire_since_turn.invalid',
          path: 'negotiation_status.ceasefire_since_turn',
          message: 'ceasefire_since_turn must be null or an integer <= current turn'
        });
      }
      if (negotiationStatus.last_offer_turn !== null && (!Number.isInteger(negotiationStatus.last_offer_turn) || negotiationStatus.last_offer_turn > currentTurn)) {
        issues.push({
          severity: 'error',
          code: 'negotiation_status.last_offer_turn.invalid',
          path: 'negotiation_status.last_offer_turn',
          message: 'last_offer_turn must be null or an integer <= current turn'
        });
      }
    }
  }

  const ceasefire = state.ceasefire;
  if (ceasefire !== undefined) {
    if (!ceasefire || typeof ceasefire !== 'object') {
      issues.push({
        severity: 'error',
        code: 'ceasefire.invalid',
        path: 'ceasefire',
        message: 'ceasefire must be an object'
      });
    } else {
      const currentTurn = state.meta?.turn ?? 0;
      const knownEdgeIds = new Set<string>();
      if (derivedFrontEdges) {
        for (const edge of derivedFrontEdges) {
          if (edge && typeof edge.edge_id === 'string') {
            knownEdgeIds.add(edge.edge_id);
          }
        }
      }

      const edgeIds = Object.keys(ceasefire).sort();
      for (const edgeId of edgeIds) {
        const entry = ceasefire[edgeId];
        if (!entry || typeof entry !== 'object') {
          issues.push({
            severity: 'error',
            code: 'ceasefire.entry.invalid',
            path: `ceasefire.${edgeId}`,
            message: 'ceasefire entry must be an object'
          });
          continue;
        }

        // Validate since_turn
        if (!Number.isInteger(entry.since_turn) || entry.since_turn < 0 || entry.since_turn > currentTurn) {
          issues.push({
            severity: 'error',
            code: 'ceasefire.entry.since_turn.invalid',
            path: `ceasefire.${edgeId}.since_turn`,
            message: 'since_turn must be an integer >= 0 and <= current turn'
          });
        }

        // Validate until_turn
        if (entry.until_turn !== null) {
          if (!Number.isInteger(entry.until_turn)) {
            issues.push({
              severity: 'error',
              code: 'ceasefire.entry.until_turn.invalid',
              path: `ceasefire.${edgeId}.until_turn`,
              message: 'until_turn must be null or an integer'
            });
          } else if (entry.until_turn < entry.since_turn) {
            issues.push({
              severity: 'error',
              code: 'ceasefire.entry.until_turn.before_since',
              path: `ceasefire.${edgeId}.until_turn`,
              message: 'until_turn must be >= since_turn'
            });
          }
        }

        // Validate edge_id exists (warning only if derivedFrontEdges provided)
        if (derivedFrontEdges && knownEdgeIds.size > 0 && !knownEdgeIds.has(edgeId)) {
          issues.push({
            severity: 'warn',
            code: 'ceasefire.entry.edge_id.unknown',
            path: `ceasefire.${edgeId}`,
            message: `edge_id ${edgeId} not found in derived front edges`
          });
        }
      }

      // Check for duplicate edge_ids (shouldn't happen, but validate)
      const seen = new Set<string>();
      for (const edgeId of edgeIds) {
        if (seen.has(edgeId)) {
          issues.push({
            severity: 'error',
            code: 'ceasefire.duplicate_edge_id',
            path: `ceasefire.${edgeId}`,
            message: `duplicate edge_id ${edgeId} in ceasefire`
          });
        }
        seen.add(edgeId);
      }

      // Check consistency: if ceasefire_active is true, there should be active entries (warning only)
      if (negotiationStatus && typeof negotiationStatus === 'object' && negotiationStatus.ceasefire_active === true) {
        const activeEntries = edgeIds.filter((edgeId) => {
          const entry = ceasefire[edgeId];
          if (!entry || typeof entry !== 'object') return false;
          const untilTurn = entry.until_turn;
          const currentTurn = state.meta?.turn ?? 0;
          // Entry is active if indefinite or not yet expired
          return untilTurn === null || untilTurn > currentTurn;
        });
        if (activeEntries.length === 0) {
          issues.push({
            severity: 'warn',
            code: 'ceasefire.inconsistent_active',
            path: 'negotiation_status.ceasefire_active',
            message: 'ceasefire_active is true but no active freeze entries found'
          });
        }
      }
    }
  }

  return issues;
}
