# Phase 3A — pressure propagation eligibility over the Phase 2 contact graph

## 0. Purpose

Phase 3A defines the first simulation consumer of the truthful spatial substrate.

- It derives an **Effective Pressure Propagation Graph** each turn from the **Phase 2 enriched contact graph**.
- It decides which edges can carry pressure this turn, and how strongly.
- It does not modify the stored substrate and does not imply movement, supply access, or control.

Pressure propagation is negative-sum:
- It dissipates over time.
- It can be blocked by collapse/friction.
- It saturates (no runaway cascades from a single edge).

## 1. Inputs, outputs, and invariants

### 1.1 Authoritative inputs (static)
- `data/derived/settlement_contact_graph_enriched.json` (Phase 2)

### 1.2 Dynamic per-turn inputs (from state)
Phase 3A consumes state variables if they exist in the engine. It must not require roads, supply, or municipality borders.

Required:
- `pressure[sid]` (scalar)

Optional gates/modulators if present in state:
- `exhaustion[sid]` (scalar, irreversible)
- `cohesion[sid]` (scalar)
- `posture[sid]` (categorical or scalar)

If optional variables are absent, Phase 3A must still function with conservative defaults (no gating, neutral weights).

### 1.3 Outputs (per turn, in-memory)
Phase 3A produces an effective edge set for the current turn:

- `pressure_edges_t`: list of edges with:
  - endpoints `a`, `b`
  - `eligible: boolean`
  - `w: number` in [0,1]
  - `reasons: string[]` (reason codes for ineligibility or null metrics)
  - `terms: { base?, f_distance?, f_shape?, f_state?, f_posture? }` (debug only)

No new derived map artifacts are written by default.

Optional (debug-only, deterministic):
- per-turn summary of eligible edge counts and weight distributions, written to the simulation debug log or a deterministic audit channel.

### 1.4 Invariants
- No mutation or rewriting of Phase 2 artifacts.
- Deterministic given same state + same graph.
- No timestamps, no randomness.
- Eligibility is system-specific (pressure only).
- Eligible edges do not imply movement, supply, or control.

## 2. Contact types and metrics

Each contact edge has:
- `type ∈ { shared_border, point_touch, distance_contact }`
- metrics may include:
  - `centroid_distance_svg`
  - `contact_span_svg`
  - `bbox_overlap_ratio`
  - `area_ratio`, `perimeter_ratio`
  - Phase 1 carry-through fields if present: `min_dist`, `overlap_len`

Missing metrics are permitted and must be handled conservatively (never guessed).

## 3. Policy structure

Per edge each turn, Phase 3A applies:

1) Hard gates (minimal): if any gate fails, edge is ineligible.
2) Weight function: if eligible, compute a bounded coupling weight `w`.

Phase 3A must remain auditable:
- an edge’s eligibility and weight must be explainable from its metrics + current state.

## 4. Hard gates

Hard gates are intentionally minimal and conservative.

### 4.1 Data integrity gate
If required fields for a safe computation are missing:
- do not fail the entire build
- mark edge as eligible with conservative weight OR ineligible with explicit reasons
- record missing metrics counts in the audit

### 4.2 Exhaustion collapse gate (only if exhaustion exists)
If either endpoint is at or beyond collapse:
- `exhaustion[a] ≥ E_collapse` OR `exhaustion[b] ≥ E_collapse` → ineligible

### 4.3 Cohesion failure gate (only if cohesion exists)
If either endpoint is below floor:
- `cohesion[a] ≤ C_floor` OR `cohesion[b] ≤ C_floor` → ineligible

Phase 3A must not require these variables to exist.

## 5. Weight function

For eligible edges:

`w = base(type) * f_distance(edge) * f_shape(edge) * f_state(a,b) * f_posture(a,b)`

Clamp to [0,1]. Default is symmetric and undirected.

### 5.1 Base weights by contact type
Parameters:
- `B_sb, B_pt, B_dc`

Constraints:
- `B_sb ≥ B_pt ≥ B_dc`
- none are implicitly zero

### 5.2 Distance attenuation
Monotone decreasing in `centroid_distance_svg`.

Default form (smooth, no cutoff):
- `f_distance = exp(- centroid_distance_svg / D_scale)`

If `centroid_distance_svg` missing:
- fallback to `min_dist` if present
- else use conservative constant `f_missing_distance`

### 5.3 Shape plausibility term (optional dampener)
Use `bbox_overlap_ratio` only as a gentle dampener (never as a gate unless later validated).

Example:
- `f_shape = clamp(bbox_overlap_ratio / O_ref, f_shape_min, 1)`

If missing:
- `f_shape = 1`

### 5.4 State coupling term (bounded, non-amplifying)
If exhaustion/cohesion exist, they can only reduce coupling, never amplify it.

- `f_state = g(exhaustion[a], exhaustion[b]) * h(cohesion[a], cohesion[b])`
- `g` decreases with higher exhaustion
- `h` decreases with lower cohesion

If state variables are absent:
- `f_state = 1`

### 5.5 Posture term (bounded, symmetric)
If posture exists:
- `f_posture ∈ [P_min, P_max]`, conservative range
If absent:
- `f_posture = 1`

## 6. Use of weights in propagation (constraints)
Phase 3A defines eligibility + coupling weights, not the full pressure update law.

However, any propagation law that uses `w` must uphold:
- dissipation (no global pressure increase without explicit sources)
- saturation (bounded per-turn outflow/inflow)
- locality (weights constrain spread)

## 7. Audits (required when enabled)
When deterministic audit mode is enabled, record per turn:
- eligible edge count and fraction by contact type
- weight distributions by type (min/p50/p90/p99/max)
- counts blocked by each gate
- top-N strongest/weakest eligible edges (stable tie-break by sid pair)

Audit mode must not affect simulation outcomes.

## 8. Parameters and governance
All parameters are explicit and documented:
- `E_collapse`, `C_floor`
- `B_sb`, `B_pt`, `B_dc`
- `D_scale`
- `O_ref`, `f_shape_min`
- `f_missing_distance`
- posture bounds if used

No silent tuning.

## 9. Out of scope
Phase 3A does not:
- create fronts,
- move units,
- compute supply,
- compute control,
- adjust adjacency,
- use roads/rivers/elevation,
- prune long edges.

## 10. Acceptance criteria
Phase 3A is complete when:
- effective weights are deterministic for a fixed state + graph
- substrate is never mutated
- audit mode yields stable summaries and does not alter results
- coupling is bounded and non-amplifying by construction
