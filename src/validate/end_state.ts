/**
 * Phase 12D.0: Validate end_state field
 * Phase 12D.1: Validate snapshot and Brčko controller rules
 */

import type { GameState, EndState } from '../state/game_state.js';
import type { ValidationIssue } from './validate.js';
import { BRCKO_CONTROLLER_ID } from '../state/brcko.js';
import { getEffectiveSettlementSide } from '../state/control_effective.js';

export function validateEndState(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const endState = state.end_state;
  if (endState === undefined || endState === null) {
    // end_state is optional, so undefined/null is valid
    // Phase 12D.1: But BRCKO_CONTROLLER_ID must not appear in control maps when end_state is not set
    // Check control_overrides for BRCKO_CONTROLLER_ID
    if (state.control_overrides) {
      for (const [sid, override] of Object.entries(state.control_overrides)) {
        if (override && typeof override === 'object' && override.side === BRCKO_CONTROLLER_ID) {
          issues.push({
            severity: 'error',
            code: 'brcko_controller_without_end_state',
            message: `BRCKO_CONTROLLER_ID found in control_overrides for ${sid} but end_state is not set`,
            path: `control_overrides.${sid}.side`
          });
        }
      }
    }
    return issues;
  }

  if (typeof endState !== 'object') {
    issues.push({
      severity: 'error',
      code: 'end_state.not_object',
      message: 'end_state must be an object',
      path: 'end_state'
    });
    return issues;
  }

  // Validate kind
  const kind = (endState as any).kind;
  if (kind !== 'peace_treaty') {
    issues.push({
      severity: 'error',
      code: 'end_state.kind.invalid',
      message: `end_state.kind must be "peace_treaty" (got: ${String(kind)})`,
      path: 'end_state.kind'
    });
  }

  // Validate treaty_id
  const treatyId = (endState as any).treaty_id;
  if (typeof treatyId !== 'string' || treatyId.length === 0) {
    issues.push({
      severity: 'error',
      code: 'end_state.treaty_id.invalid',
      message: 'end_state.treaty_id must be a non-empty string',
      path: 'end_state.treaty_id'
    });
  }

  // Validate since_turn
  const sinceTurn = (endState as any).since_turn;
  if (!Number.isInteger(sinceTurn) || sinceTurn < 0) {
    issues.push({
      severity: 'error',
      code: 'end_state.since_turn.invalid',
      message: 'end_state.since_turn must be an integer >= 0',
      path: 'end_state.since_turn'
    });
  } else {
    // since_turn must be <= current turn
    const currentTurn = state.meta?.turn ?? 0;
    if (sinceTurn > currentTurn) {
      issues.push({
        severity: 'error',
        code: 'end_state.since_turn.future',
        message: `end_state.since_turn (${sinceTurn}) must be <= current turn (${currentTurn})`,
        path: 'end_state.since_turn'
      });
    }
  }

  // Validate note (optional)
  const note = (endState as any).note;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') {
      issues.push({
        severity: 'error',
        code: 'end_state.note.invalid',
        message: 'end_state.note must be a string if present',
        path: 'end_state.note'
      });
    } else {
      const trimmed = note.trim();
      if (trimmed.length === 0) {
        issues.push({
          severity: 'error',
          code: 'end_state.note.empty',
          message: 'end_state.note must not be empty if present',
          path: 'end_state.note'
        });
      }
    }
  }

  // Phase 12D.1: Validate snapshot if present
  const snapshot = (endState as any).snapshot;
  if (snapshot !== undefined && snapshot !== null) {
    if (typeof snapshot !== 'object') {
      issues.push({
        severity: 'error',
        code: 'end_state.snapshot.not_object',
        message: 'end_state.snapshot must be an object if present',
        path: 'end_state.snapshot'
      });
    } else {
      // Validate snapshot.turn equals end_state.since_turn
      const snapshotTurn = (snapshot as any).turn;
      if (!Number.isInteger(snapshotTurn) || snapshotTurn !== sinceTurn) {
        issues.push({
          severity: 'error',
          code: 'end_state.snapshot.turn.mismatch',
          message: `end_state.snapshot.turn (${snapshotTurn}) must equal end_state.since_turn (${sinceTurn})`,
          path: 'end_state.snapshot.turn'
        });
      }

      // Validate controllers is sorted by sid asc, unique sids
      const controllers = (snapshot as any).controllers;
      if (Array.isArray(controllers)) {
        for (let i = 0; i < controllers.length; i += 1) {
          const entry = controllers[i];
          if (!Array.isArray(entry) || entry.length !== 2) {
            issues.push({
              severity: 'error',
              code: 'end_state.snapshot.controllers.invalid_entry',
              message: `end_state.snapshot.controllers[${i}] must be [sid, controller] tuple`,
              path: `end_state.snapshot.controllers[${i}]`
            });
            continue;
          }
          const [sid, controller] = entry;
          if (!Number.isInteger(sid) || typeof controller !== 'string') {
            issues.push({
              severity: 'error',
              code: 'end_state.snapshot.controllers.invalid_types',
              message: `end_state.snapshot.controllers[${i}] must have [number, string] types`,
              path: `end_state.snapshot.controllers[${i}]`
            });
          }
          // Check sorting
          if (i > 0) {
            const prevSid = controllers[i - 1][0];
            if (sid <= prevSid) {
              issues.push({
                severity: 'error',
                code: 'end_state.snapshot.controllers.not_sorted',
                message: `end_state.snapshot.controllers must be sorted by sid ascending`,
                path: `end_state.snapshot.controllers[${i}]`
              });
            }
          }
        }
      }

      // Phase 13A.0: Validate competences array if present
      const competences = (snapshot as any).competences;
      if (competences !== undefined && competences !== null) {
        if (!Array.isArray(competences)) {
          issues.push({
            severity: 'error',
            code: 'end_state.snapshot.competences.not_array',
            message: 'end_state.snapshot.competences must be an array if present',
            path: 'end_state.snapshot.competences'
          });
        } else {
          // Validate competences only present if end_state.kind == "peace_treaty"
          if (kind !== 'peace_treaty') {
            issues.push({
              severity: 'error',
              code: 'end_state.snapshot.competences.requires_peace',
              message: 'end_state.snapshot.competences may only be present when end_state.kind is "peace_treaty"',
              path: 'end_state.snapshot.competences'
            });
          } else {
            const seenCompetences = new Set<string>();
            for (let i = 0; i < competences.length; i += 1) {
              const comp = competences[i];
              if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
                issues.push({
                  severity: 'error',
                  code: 'end_state.snapshot.competences.invalid_entry',
                  message: `end_state.snapshot.competences[${i}] must be an object with competence and holder`,
                  path: `end_state.snapshot.competences[${i}]`
                });
                continue;
              }
              
              const compId = comp.competence;
              const holder = comp.holder;
              
              if (typeof compId !== 'string' || compId.length === 0) {
                issues.push({
                  severity: 'error',
                  code: 'end_state.snapshot.competences.invalid_competence',
                  message: `end_state.snapshot.competences[${i}].competence must be a non-empty string`,
                  path: `end_state.snapshot.competences[${i}].competence`
                });
              }
              
              if (typeof holder !== 'string' || holder.length === 0) {
                issues.push({
                  severity: 'error',
                  code: 'end_state.snapshot.competences.invalid_holder',
                  message: `end_state.snapshot.competences[${i}].holder must be a non-empty string`,
                  path: `end_state.snapshot.competences[${i}].holder`
                });
              }
              
              // Check for duplicates
              if (seenCompetences.has(compId)) {
                issues.push({
                  severity: 'error',
                  code: 'end_state.snapshot.competences.duplicate',
                  message: `end_state.snapshot.competences: duplicate competence ${compId}`,
                  path: `end_state.snapshot.competences[${i}]`
                });
              } else {
                seenCompetences.add(compId);
              }
              
              // Check sorting (must be sorted by competence ID)
              if (i > 0) {
                const prevComp = competences[i - 1];
                if (prevComp && typeof prevComp === 'object' && !Array.isArray(prevComp)) {
                  const prevCompId = prevComp.competence;
                  if (typeof prevCompId === 'string' && typeof compId === 'string' && compId < prevCompId) {
                    issues.push({
                      severity: 'error',
                      code: 'end_state.snapshot.competences.not_sorted',
                      message: 'end_state.snapshot.competences must be sorted by competence ID ascending',
                      path: `end_state.snapshot.competences[${i}]`
                    });
                  }
                }
              }
            }
          }
        }
      }

      // Validate outcome_hash is 64 hex chars
      const outcomeHash = (snapshot as any).outcome_hash;
      if (typeof outcomeHash !== 'string' || !/^[0-9a-f]{64}$/.test(outcomeHash)) {
        issues.push({
          severity: 'error',
          code: 'end_state.snapshot.outcome_hash.invalid',
          message: 'end_state.snapshot.outcome_hash must be a 64-character hex string',
          path: 'end_state.snapshot.outcome_hash'
        });
      }

      // Validate settlements_by_controller matches controllers aggregation (optional consistency check)
      const settlementsByController = (snapshot as any).settlements_by_controller;
      if (Array.isArray(settlementsByController) && Array.isArray(controllers)) {
        const controllerCounts = new Map<string, number>();
        for (const [sid, controller] of controllers) {
          const count = controllerCounts.get(controller) ?? 0;
          controllerCounts.set(controller, count + 1);
        }
        const expected = Array.from(controllerCounts.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([controller, count]) => [controller, count]);
        const actual = settlementsByController
          .map((entry: any) => Array.isArray(entry) && entry.length === 2 ? entry : null)
          .filter((e: any) => e !== null)
          .sort((a: any, b: any) => a[0].localeCompare(b[0]));
        
        if (expected.length !== actual.length || !expected.every((e, i) => actual[i] && e[0] === actual[i][0] && e[1] === actual[i][1])) {
          issues.push({
            severity: 'warn',
            code: 'end_state.snapshot.settlements_by_controller.mismatch',
            message: 'end_state.snapshot.settlements_by_controller does not match controllers aggregation',
            path: 'end_state.snapshot.settlements_by_controller'
          });
        }
      }
    }
  }

  return issues;
}
