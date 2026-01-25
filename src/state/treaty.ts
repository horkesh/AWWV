/**
 * Phase 12B: Treaty data model (propose/evaluate only, no apply)
 *
 * Treaty system for deterministic proposal and evaluation.
 * No territory or institutional changes applied in Phase 12B.
 */

export type TreatyScope =
  | { kind: 'global' }
  | { kind: 'region'; region_id: string }
  | { kind: 'edges'; edge_ids: string[] }
  | { kind: 'settlements'; sids: string[] }
  | { kind: 'municipalities'; mun_ids: string[] };

export type TreatyAnnex = 'military' | 'territorial' | 'institutional';

export type TreatyClauseKind =
  // MILITARY
  | 'ceasefire_global'
  | 'freeze_region'
  | 'freeze_edges'
  | 'monitoring_light'
  | 'monitoring_robust'
  // TERRITORIAL
  | 'recognize_control_settlements'
  | 'corridor_right_of_way'
  | 'transfer_settlements'
  | 'brcko_special_status' // Phase 12D.1: Special status for Brčko District
  // INSTITUTIONAL
  | 'autonomy_municipal'
  | 'autonomy_regional'
  | 'independence_pathway_step1'
  | 'allocate_competence'; // Phase 13A.0: Allocate institutional competence to holder

export interface TreatyClause {
  id: string; // deterministic within treaty
  annex: TreatyAnnex;
  kind: TreatyClauseKind;
  proposer_faction_id: string;
  target_faction_ids: string[]; // who must accept (sorted unique)
  scope: TreatyScope;
  cost: number; // integer >= 0 (paid by proposer capital if accepted later)
  acceptance_impact: number; // integer (positive makes acceptance harder for targets)
  enforcement_burden: number; // integer >= 0 (used in enforceability scoring)
  tags?: string[]; // optional, deterministic cleanup like formations tags
  // Phase 12C.0: transfer_settlements clause fields
  giver_side?: string; // PoliticalSideId (required when kind == transfer_settlements)
  receiver_side?: string; // PoliticalSideId (required when kind == transfer_settlements)
  // Phase 12C.3: corridor_right_of_way clause field
  beneficiary?: string; // PoliticalSideId (required when kind == corridor_right_of_way)
  // Phase 12D.1: brcko_special_status clause field
  sids?: number[]; // optional sids allows future proofing, default is canonical Brčko set
  // Phase 13A.0: allocate_competence clause fields
  competence?: string; // CompetenceId (required when kind == allocate_competence)
  holder?: string; // PoliticalSideId or special identifier (required when kind == allocate_competence)
}

export interface TreatyDraft {
  schema: 1;
  turn: number;
  treaty_id: string; // deterministic hash of sorted clause ids
  proposer_faction_id: string;
  clauses: TreatyClause[]; // sorted by annex then kind then scope hash then id
  totals: {
    cost_total: number;
    acceptance_impact_total: number;
    enforcement_burden_total: number;
  };
  package_warnings: string[]; // deterministic list of warnings
}
