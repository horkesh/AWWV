# Project rules for A War Without Victory

- This is a strategic simulation, not a tactical wargame.
- No hard-coded historical outcomes. Outcomes must be emergent from state + rules.
- Distinguish: authority/legitimacy/control/logistics/exhaustion as separate state variables.
- Territory is political + logistical, not just geometry. Municipalities are base political units; settlements are capture points.
- Fronts are emergent from AoR assignment + adjacency interactions, not map primitives.
- Deterministic turn updates: given same input state + RNG seed, results must match exactly.
- All changes to state happen only inside the turn pipeline (no hidden side effects).
- Prefer small commits, minimal diffs, strong validation, loud failures.
- If unsure: add a validation check or a TODO, do not invent new mechanics.