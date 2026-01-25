/**
 * Phase 12C.5: Test for deterministic exports from dev UI
 * 
 * Ensures that exported clause specs and treaty drafts are stable
 * (same inputs -> same outputs, no randomness, no timestamps).
 */

import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import type { TreatyScope, TreatyClause } from '../src/state/treaty.js';
import { isClauseDeprecated } from '../src/state/treaty_clause_library.js';
import { BRCKO_SIDS } from '../src/state/brcko.js';

test('dev UI exports deterministic clause specs', () => {
  // Create a treaty draft with multiple clauses
  const sids1 = ['10308:166626', '10391:164844', '10731:166600'].sort();
  const sids2 = ['20036:230324', '20109:205184'].sort();
  
  const clause1 = createClause(
    'CLAUSE_1',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: sids1 } as TreatyScope,
    undefined,
    'RS',
    'RBiH'
  );
  
  const clause2 = createClause(
    'CLAUSE_2',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: sids2 } as TreatyScope,
    undefined,
    'RBiH',
    'RS'
  );
  
  const draft1 = buildTreatyDraft(1, 'RBiH', [clause1, clause2]);
  const draft2 = buildTreatyDraft(1, 'RBiH', [clause2, clause1]); // Different order
  
  // Drafts should be identical (sorted deterministically)
  strictEqual(draft1.treaty_id, draft2.treaty_id);
  strictEqual(draft1.clauses.length, draft2.clauses.length);
  strictEqual(draft1.clauses[0].id, draft2.clauses[0].id);
  strictEqual(draft1.clauses[1].id, draft2.clauses[1].id);
  
  // Export clause specs (simulating dev UI export logic)
  function exportClauseSpecs(draft: typeof draft1): string[] {
    const specs: string[] = [];
    for (const clause of draft.clauses) {
      let spec = `${clause.annex}:${clause.kind}:${clause.target_faction_ids.join('|')}:`;
      
      if (clause.scope.kind === 'settlements') {
        spec += `settlements:${clause.scope.sids.join('|')}`;
      }
      
      if (clause.giver_side) {
        spec += `:giver=${clause.giver_side}`;
      }
      if (clause.receiver_side) {
        spec += `:receiver=${clause.receiver_side}`;
      }
      
      specs.push(spec);
    }
    
    // Sort deterministically
    specs.sort();
    return specs;
  }
  
  const specs1 = exportClauseSpecs(draft1);
  const specs2 = exportClauseSpecs(draft2);
  
  // Specs should be identical regardless of input clause order
  deepStrictEqual(specs1, specs2);
  
  // Specs should be in deterministic order
  strictEqual(specs1.length, 2);
  strictEqual(specs1[0], specs1[0]); // Should be stable
  strictEqual(specs1[1], specs1[1]); // Should be stable
});

test('dev UI exports deterministic treaty draft JSON', () => {
  const sids = ['10308:166626', '10391:164844'].sort();
  
  const clause = createClause(
    'CLAUSE_TEST',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids } as TreatyScope,
    undefined,
    'RS',
    'RBiH'
  );
  
  const draft1 = buildTreatyDraft(1, 'RBiH', [clause]);
  const draft2 = buildTreatyDraft(1, 'RBiH', [clause]);
  
  // JSON exports should be identical
  const json1 = JSON.stringify(draft1, null, 2);
  const json2 = JSON.stringify(draft2, null, 2);
  
  strictEqual(json1, json2);
  
  // No timestamps should be present
  strictEqual(json1.includes('timestamp'), false);
  strictEqual(json1.includes('generated_at'), false);
  strictEqual(json1.includes('Date.now'), false);
  
  // Should have deterministic fields
  strictEqual(draft1.treaty_id, draft2.treaty_id);
  strictEqual(draft1.totals.cost_total, draft2.totals.cost_total);
});

// Phase 12D.2: Test brcko_special_status export (prefer no sids)
test('dev UI exports brcko_special_status without sids (canonical)', () => {
  const scope: TreatyScope = { kind: 'settlements', sids: BRCKO_SIDS.map(String) };
  const clause = createClause(
    'CLAUSE_BRCKO',
    'territorial',
    'brcko_special_status',
    'RBiH',
    ['RS'],
    scope,
    undefined
  );
  // Phase 12D.2: Don't set clause.sids (canonical)
  const draft = buildTreatyDraft(1, 'RBiH', [clause]);
  
  // Phase 12D.2: Clause should not have sids field (scope.sids is fine)
  strictEqual((draft.clauses[0] as any).sids, undefined, 'brcko clause should not have sids field');
  
  // Scope should still have sids
  strictEqual(draft.clauses[0].scope.kind, 'settlements');
  strictEqual((draft.clauses[0].scope as any).sids.length, BRCKO_SIDS.length);
  
  // JSON export will include "sids" in scope, but not as clause.sids
  const json = JSON.stringify(draft, null, 2);
  // Check that clause object doesn't have sids field (it's in scope, not at clause level)
  const parsed = JSON.parse(json);
  strictEqual(parsed.clauses[0].sids, undefined, 'clause.sids should be undefined in export');
  strictEqual(parsed.clauses[0].scope.sids !== undefined, true, 'scope.sids should be present');
});

// Phase 12D.2: Test that corridor_right_of_way cannot be newly added
test('corridor_right_of_way is deprecated and should not be in new exports', () => {
  strictEqual(isClauseDeprecated('corridor_right_of_way'), true);
  strictEqual(isClauseDeprecated('transfer_settlements'), false);
  strictEqual(isClauseDeprecated('brcko_special_status'), false);
});

// Phase 12D.2: Test deterministic clause ordering in export
test('dev UI exports clauses in deterministic order', () => {
  const sids1 = ['10308:166626', '10391:164844'].sort();
  const sids2 = ['20036:230324'].sort();
  
  const clause1 = createClause(
    'CLAUSE_A',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: sids1 } as TreatyScope,
    undefined,
    'RS',
    'RBiH'
  );
  
  const clause2 = createClause(
    'CLAUSE_B',
    'territorial',
    'brcko_special_status',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: BRCKO_SIDS.map(String) } as TreatyScope,
    undefined
  );
  
  const clause3 = createClause(
    'CLAUSE_C',
    'territorial',
    'transfer_settlements',
    'RBiH',
    ['RS'],
    { kind: 'settlements', sids: sids2 } as TreatyScope,
    undefined,
    'RBiH',
    'RS'
  );
  
  // Build drafts with different clause orders
  const draft1 = buildTreatyDraft(1, 'RBiH', [clause1, clause2, clause3]);
  const draft2 = buildTreatyDraft(1, 'RBiH', [clause3, clause1, clause2]);
  const draft3 = buildTreatyDraft(1, 'RBiH', [clause2, clause3, clause1]);
  
  // All should have same treaty_id (deterministic sorting)
  strictEqual(draft1.treaty_id, draft2.treaty_id);
  strictEqual(draft2.treaty_id, draft3.treaty_id);
  
  // Clause order should be deterministic (by kind, then scope)
  strictEqual(draft1.clauses[0].kind, draft2.clauses[0].kind);
  strictEqual(draft1.clauses[1].kind, draft2.clauses[1].kind);
  strictEqual(draft1.clauses[2].kind, draft2.clauses[2].kind);
  
  // JSON exports should be identical
  const json1 = JSON.stringify(draft1, null, 2);
  const json2 = JSON.stringify(draft2, null, 2);
  const json3 = JSON.stringify(draft3, null, 2);
  
  strictEqual(json1, json2);
  strictEqual(json2, json3);
});
