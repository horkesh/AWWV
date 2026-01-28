# FORAWWV.md
## Canon extensions and validated implementation insights for *A War Without Victory*

This file records **validated systemic truths** discovered during implementation that extend (and must never contradict) the Rulebook, Systems & Mechanics Manual, and Engine Invariants. It is not a design pitch, not a dev diary, and not a substitute for the canonical docs. It exists to prevent “quiet drift” between intent, data reality, and code.

---

## 1. Canon hierarchy and operating rules

### 1.1 Document precedence
If there is a conflict:
1) Engine Invariants  
2) Rulebook  
3) Systems & Mechanics Manual  
4) This file (FORAWWV.md)  
5) Code

If code contradicts the documents, **code is wrong**.

### 1.2 Determinism doctrine
The engine and all derived artifacts must be deterministic:
- No randomness in simulation core
- No timestamps in derived artifacts
- Stable ordering everywhere (IDs, arrays, maps, outputs)
- Re-running the same command on the same inputs must produce byte-identical outputs

### 1.3 “Truthful substrate” rule
The map layer must never be “fixed” by invention:
- No hulls, unions, smoothing, buffering, snapping, or silent repairs
- If data is wrong or incomplete, it must be:
  - audited,
  - logged (mistake log if it’s our process mistake),
  - and surfaced as a constraint in canon if it affects design

---

## 2. Spatial substrate is settlement-first

### 2.1 Settlement-first doctrine
Settlements are the **only authoritative spatial entities** in the simulation:
- Settlements are entities tied to polygons
- Municipalities exist only as **metadata/reference containers**
- No simulation logic may depend on municipality borders

### 2.2 Canonical inputs and outputs
Authoritative source inputs:
- `data/source/settlements/**` (municipality JS files containing SVG shapes)
- `data/source/bih_census_1991.json` (canonical settlement identity + demographics)

Canonical derived substrate:
- `data/derived/settlements_substrate.geojson`
- `data/derived/settlements_substrate.audit.json`
- `data/derived/settlements_substrate.audit.txt`

Canonical viewer:
- `data/derived/substrate_viewer/` (canvas viewer, borders-first inspection)
- Viewer must detect `file://` and show a clear local-server instruction message.

Legacy note:
- Prior master-derived substrate is preserved under `data/derived/_legacy_master_substrate/` and is not used by canon going forward.

### 2.3 Coordinate regime
The canonical settlements substrate is in an **SVG coordinate regime**, not a geographic CRS.
This is acceptable and canonical because:
- The simulation uses topology and graph relations, not real-world lat/lon distances
- Any conversion to real-world coordinates (if ever needed) must be explicit, audited, and treated as a separate system layer

---

## 3. Adjacency is a modeled relationship, not “who shares a border”

### 3.1 Validated data truth: settlements are footprints, not a partition fabric
A deterministic border-fabric forensic audit on the **canonical SVG-derived substrate** established:

- Total boundary length: ~267,375 units  
- Shared-border length (owned by exactly two settlements): ~430 units  
- Shared-border ratio: ~0.16%  
- Anomalies (>2 owners): 0  

Interpretation:
- Settlement polygons overwhelmingly do **not** share boundary-length borders.
- Therefore, the settlements substrate is not a tessellated administrative partition.
- Any system that assumes “adjacency = shared border” will produce extreme isolation and fragmentation.

This is a **data truth**, not a code defect.

### 3.2 Canonical implication
**Phase 1 settlement adjacency cannot be derived as shared-border-only.**

Adjacency must instead represent **contact potential**: where pressure, authority, and interaction can propagate, subject to other systems (supply, posture, cohesion, command friction). Adjacency does not automatically imply:
- movement,
- supply access,
- control,
- authority,
- or sustained combat capability.

Adjacency is only the base connectivity layer.

### 3.3 Canonical adjacency definition (Phase 1)
The canonical Phase 1 adjacency is a **Contact Graph**, not a Border Graph.

Two settlements are adjacent if any of the following holds:
1) Shared border segment with positive length (rare but true)
2) Point-touch contact (vertex contact)
3) Minimum boundary-to-boundary distance ≤ **D₀** (a small, explicit “local contact radius”)

Where:
- **D₀ is a canon parameter**, not a hidden tolerance hack.
- D₀ must be deterministic and documented in the adjacency audit artifacts.
- D₀ must be used only for *contact potential*, not for inventing borders.
- This is not “snapping geometry”; it is defining a contact relationship.

### 3.4 Required audits for adjacency canon
Any adjacency graph derived under 3.3 must output:
- nodes, edges
- isolated count/percentage
- component count and largest component size
- degree distribution
- breakdown of edge types: shared-border vs point-touch vs distance-contact
- sensitivity report for D₀ (if D₀ is adjusted, the impact must be auditable)

---

## 4. Areas of Responsibility depend on the contact graph, not borders

Brigade Areas of Responsibility (AoRs) require a contiguity substrate that is:
- stable,
- deterministic,
- and sufficiently connected to support meaningful sectors

Given the data truth in §3.1, AoR contiguity must be defined over the **contact graph**, not shared borders.

AoR invariants remain:
- each settlement assigned to exactly one brigade AoR
- AoRs must be contiguous under the canonical adjacency graph
- transfers between brigades must preserve contiguity

---

## 5. Mistake log and ledger are part of the engine, not “process fluff”

### 5.1 Mistake log
`docs/ASSISTANT_MISTAKES.log` is authoritative and append-only.
The mistake guard exists to prevent repeat failures and must remain active in scripts.

Automation requirement (now implemented in tooling):
- Confirmed mistakes should be recorded via structured, append-only entries
- Warnings should not spam repeatedly once the mistake is recorded and addressed

### 5.2 Project ledger
`docs/PROJECT_LEDGER.md` is mandatory for:
- phase tracking
- canon decisions
- explicit deferrals
- deterministic changelog of actions

---

## 6. What this file is NOT allowed to do

- It must not contradict the Rulebook, Manuals, or Engine Invariants.
- It must not encode “we should probably…” speculation as canon.
- It must not introduce new mechanics that haven’t been requested and validated.
- It must not quietly change the meaning of existing systems.

---

## 7. Current validated extensions (summary)

- Settlements substrate is canonical in SVG coordinate space.
- Settlement polygons are footprints; they do not form a shared-border partition at scale.
- Adjacency must be modeled as a **contact graph** with an explicit small contact radius D₀, plus point-touch and true shared-border where present.
- AoR contiguity must be defined on the contact graph.
- Mistake log and ledger are mandatory system guardrails, not optional workflow.