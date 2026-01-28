# Phase 2: Contact Graph Enrichment — Specification

**Status:** Spec only (no implementation).  
**Builds on:** Phase 0 (settlement substrate), Phase 1 (contact graph).  
**Authority:** This document is the authoritative spec for Phase 2 enrichment. Implementation must conform.

---

## 1. Purpose

Phase 2 **enriches** the Phase 1 settlement contact graph with additional node- and edge-level fields derived **only** from the canonical inputs. No geometry invention, no inference, no pruning. The enriched graph remains a purely descriptive, deterministic artifact.

---

## 2. Artifacts

### 2.1 Inputs

- `data/derived/settlements_substrate.geojson` — Canonical settlement polygons (Phase 0).
- `data/derived/settlement_contact_graph.json` — Canonical Phase 1 contact graph (nodes, edges).

### 2.2 Outputs

- `data/derived/settlement_contact_graph_enriched.json` — Enriched graph (schema below).
- `data/derived/settlement_contact_graph_enriched.audit.json` — Machine-readable audit report.
- `data/derived/settlement_contact_graph_enriched.audit.txt` — Human-readable audit report.

---

## 3. Invariants

1. **Same nodes, same edges.** The enriched graph has exactly the same set of nodes and the same set of edges as the Phase 1 input. No additions, no removals.
2. **Additive only.** Enrichment adds fields to nodes and edges. It does not drop or alter existing Phase 1 fields.
3. **No geometry invention.** All enrichment is derived from existing substrate geometry and Phase 1 graph structure. No buffering, hulls, unions, smoothing, or tolerance-based inference beyond what Phase 1 already uses.
4. **Read-only inputs.** Substrate and Phase 1 graph are read-only. No writes to those files.

---

## 4. Determinism and stable ordering

- **Determinism:** Re-running the Phase 2 derivation on the same inputs must produce **byte-identical** outputs. No randomness, no timestamps, no wall-clock time in any output.
- **Node ordering:** Same as Phase 1 — **stable sid lexicographic** order.
- **Edge ordering:** Same as Phase 1 — **stable lexicographic pair** `(a, b)` (e.g. sort by `a`, then `b`).
- **JSON key order:** Canonical key ordering for all emitted JSON (e.g. alphabetical or a fixed schema order) so that diffs and hashes are stable.

---

## 5. Node fields

Every node in `settlement_contact_graph_enriched.json` has the following fields. Phase 1 fields are retained; enrichment adds only those marked *Phase 2*.

| Field    | Type     | Required | Source        | Notes                                      |
|----------|----------|----------|---------------|--------------------------------------------|
| `sid`    | `string` | yes      | Phase 1       | Settlement ID.                             |
| `degree` | `number` | yes      | Phase 2       | Number of edges incident to this node.     |

Additional Phase 2 node fields may be added only if derived from the **inputs** (substrate properties joined by `sid`, or graph structure). Any such field must be documented here, deterministic, and never inferred or guessed.

---

## 6. Edge fields

Every edge has the following fields. Phase 1 fields are retained; enrichment adds only those marked *Phase 2*.

| Field        | Type     | Required | Source  | Notes                                                                 |
|--------------|----------|----------|---------|-----------------------------------------------------------------------|
| `a`          | `string` | yes      | Phase 1 | First settlement ID (lexicographically smaller when ordering).        |
| `b`          | `string` | yes      | Phase 1 | Second settlement ID.                                                 |
| `type`       | `string` | yes      | Phase 1 | One of `shared_border`, `point_touch`, `distance_contact`.            |
| `overlap_len`| `number` | no       | Phase 1 | Present when `type === 'shared_border'`. Overlap length.              |
| `min_dist`   | `number` | no       | Phase 1 | Present when `type === 'distance_contact'`. Min boundary distance.    |

No edge pruning, no minimum length/distance thresholds, and no eligibility flags for gameplay. All Phase 1 edges are preserved as-is.

---

## 7. Audit requirements

### 7.1 `settlement_contact_graph_enriched.audit.json`

Must include at least:

- **Source paths:** Input substrate and Phase 1 graph paths (or identifiers).
- **Parameters:** Any Phase 2 parameters (if none, state explicitly).
- **Counts:** `nodes`, `edges_total`, `edges_shared_border`, `edges_point_touch`, `edges_distance_contact`.
- **Invariants check:** Confirmation that node set and edge set match Phase 1 input (e.g. counts, or explicit equality check).
- **Determinism:** `node_ordering`, `edge_ordering`, `no_timestamps`, `no_randomness` (all true).
- **Degree stats:** e.g. `min`, `max`, `median`, `p90`; optional `top_settlements_by_degree`.
- **Component analysis:** Optional but recommended (e.g. `component_count`, `largest_component_size`).

### 7.2 `settlement_contact_graph_enriched.audit.txt`

Human-readable summary of the above, in a fixed format. No timestamps or non-deterministic content.

---

## 8. Acceptance criteria

1. **Artifacts exist:** All three outputs are written under `data/derived/`.
2. **Schema:** Enriched JSON has `nodes` and `edges` arrays; each node has `sid` and `degree`; each edge has `a`, `b`, `type` and optional `overlap_len` / `min_dist` as above.
3. **Invariants:** Node count and edge count match Phase 1 input; no nodes or edges added or removed.
4. **Determinism:** Re-run produces byte-identical `settlement_contact_graph_enriched.json` and audit files.
5. **Ordering:** Nodes sorted by `sid` lexicographic; edges sorted by `(a,b)` lexicographic.
6. **Audit:** Both audit files present, reflect actual counts and determinism guarantees, and contain no timestamps.

---

## 9. Out of scope (forbidden)

Phase 2 **must not**:

- **Prune** nodes or edges (e.g. by degree, connectivity, or type).
- **Apply thresholds** to include or exclude edges (e.g. minimum distance, maximum degree).
- **Add gameplay eligibility** (e.g. "movement_allowed", "supply_eligible"). The enriched graph remains purely descriptive.
- **Invent geometry** or infer new adjacency.
- **Change** Phase 1 graph structure; only add fields.

These constraints keep Phase 2 strictly additive and preserve the contact graph as a truthful substrate.
