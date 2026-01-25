/**
 * Phase 13A.0: Institutional competences as treaty outcomes
 * Phase 14: Expanded competence catalog
 *
 * Defines a canonical list of institutional competences that can be allocated
 * at peace via treaties. Competences are frozen outcomes in end_state, not
 * simulated post-war governance.
 */

export type CompetenceId =
  | "airspace_control"
  | "armed_forces_command"
  | "border_control"
  | "currency_authority"
  | "customs"
  | "defence_policy"
  | "education_policy"
  | "health_policy"
  | "indirect_taxation"
  | "international_representation"
  | "police_internal_security";

/**
 * Canonical ordered list of all competences.
 * This list is authoritative and deterministically ordered (sorted by id ascending).
 * Phase 14: Expanded to include additional institutional competences.
 */
export const ALL_COMPETENCES: CompetenceId[] = [
  "airspace_control",
  "armed_forces_command",
  "border_control",
  "currency_authority",
  "customs",
  "defence_policy",
  "education_policy",
  "health_policy",
  "indirect_taxation",
  "international_representation",
  "police_internal_security"
];

/**
 * Validate that a competence ID is in the canonical list.
 */
export function isValidCompetence(competence: string): competence is CompetenceId {
  return ALL_COMPETENCES.includes(competence as CompetenceId);
}
