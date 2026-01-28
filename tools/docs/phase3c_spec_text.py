# Phase 3C formal spec text (verbatim). Used by edit_phase3c_spec.py.
# No timestamps, no random IDs, deterministic.

MANUAL_SECTION_TITLE = "Phase 3C — Exhaustion → Collapse Gating (Design Freeze)"

MANUAL_SPEC_BODY = r"""
Phase 3C — Exhaustion → Collapse Gating
Formal Specification (Design Freeze)

1. Purpose and Scope

Phase 3C defines the eligibility conditions under which accumulated exhaustion may begin to destabilize political, military, and spatial systems.

This phase exists to:
- prevent exhaustion from acting as an implicit collapse trigger,
- ensure collapse remains delayed, contingent, and multi-causal,
- gate downstream failure modes behind persistence and state coherence.

Phase 3C does not cause collapse, fragmentation, or territorial change. It only governs when such outcomes may become possible.

2. Conceptual Definition

Collapse represents the loss of coordinated governance, command coherence, or spatial integrity sufficient to invalidate normal system behavior.

Exhaustion alone is never sufficient to cause collapse.

Phase 3C defines collapse eligibility, not collapse resolution.

3. Canonical Inputs (Locked)

Phase 3C operates exclusively on:
- exhaustion values accumulated through prior phases,
- authority state variables,
- command cohesion and formation readiness states,
- supply and connectivity states,
- persistence counters derived from earlier phases.

No new spatial metrics, randomness, or probabilistic models are introduced.

4. Structural Position in Turn Order

Collapse gating executes:
- after exhaustion accrual (Phase 3B),
- before any collapse, fragmentation, or negotiation logic,
- once per turn.

The output of Phase 3C is eligibility flags only.

5. Collapse Eligibility Model

Collapse eligibility is evaluated independently for each applicable domain:
- authority collapse,
- command cohesion collapse,
- spatial integrity collapse.

Eligibility in one domain does not automatically imply eligibility in another.

6. Exhaustion Threshold Gating (Necessary, Not Sufficient)

6.1 Threshold Crossing

Each collapse domain defines a minimum exhaustion threshold that must be exceeded before eligibility is even considered.

Threshold crossing alone produces no effect.

6.2 Persistence Requirement (Hard)

Exhaustion must remain above the relevant threshold for N consecutive turns.

One-turn threshold crossings are ignored.
Persistence counters reset if exhaustion falls below threshold (if permitted by rules).

7. State Coherence Gating (Hard)

Collapse eligibility additionally requires concurrent degradation in at least one supporting system.

Examples include:
- degraded or failed authority consolidation,
- brittle or cut supply dependencies,
- sustained static fronts,
- command fragmentation or disobedience signals.

Exhaustion without supporting degradation cannot unlock collapse eligibility.

8. Suppression and Immunity Rules

8.1 Temporary Suppression

Collapse eligibility is suppressed if:
- authority recovery actions are active and effective,
- emergency supply restoration succeeds,
- external stabilization is applied.

Suppression pauses persistence counters but does not erase exhaustion.

8.2 Immunity Conditions

Certain states confer temporary immunity to collapse eligibility, such as:
- early-war coercive phases,
- newly stabilized settlements,
- recently reorganized formations.

Immunity is time-limited and explicitly tracked.

9. Output Contract

Phase 3C produces eligibility flags only, including:
- domain-specific collapse eligibility markers,
- persistence counter states,
- suppression or immunity annotations.

No collapse resolution occurs in this phase.

10. Determinism and Auditability

Phase 3C enforces:
- deterministic evaluation order,
- stable persistence counters,
- no randomness,
- no timestamps,
- auditable eligibility state per turn.

11. Canonical Interpretation (Binding)

Exhaustion enables collapse only when sustained strain coincides with institutional or spatial degradation. Collapse is never automatic, never instantaneous, and never driven by exhaustion alone. Eligibility precedes failure.

12. Explicit Non-Effects

Phase 3C does not:
- trigger collapse,
- fragment municipalities,
- alter control,
- force negotiations,
- modify pressure or exhaustion values.

13. Freeze Status

Phase 3C exhaustion → collapse gating is design-frozen.

Any modification requires:
- explicit phase advancement,
- ledger entry,
- justification against exhaustion, authority, and determinism invariants.
"""

RULEBOOK_SUBSECTION_TITLE = "Phase 3C — Exhaustion and collapse eligibility"

RULEBOOK_SUBSECTION_BODY = (
    "Exhaustion does not automatically cause collapse. When accumulated exhaustion persists and "
    "coincides with institutional or spatial degradation, it may unlock eligibility for collapse in "
    "specific domains such as authority, command cohesion, or spatial integrity. Eligibility does not "
    "imply immediate failure. Collapse remains delayed, contingent, and multi-causal. The formal "
    "frozen specification for collapse gating is defined in the Systems & Mechanics Manual under "
    "\"Phase 3C — Exhaustion → Collapse Gating (Design Freeze)\"."
)
