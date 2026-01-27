# A WAR WITHOUT VICTORY PROJECT HANDOVER / CONTINUATION PROMPT

## SETTLEMENT-FIRST PHASE (AUTHORITATIVE)

This prompt re-establishes full project context so work can continue seamlessly in a new chat. **Treat this as authoritative.**

---

## 1. PROJECT FRAME (NON-NEGOTIABLE)

Strategic-level simulation of the 1991–1995 war in Bosnia and Herzegovina

- **NOT** a tactical wargame
- **NOT** unit micromanagement
- **NOT** battle resolution

Core principles:
- War is **negative-sum**, no total victory possible
- **Exhaustion is irreversible** and central
- Fragmentation and loss of control are expected
- Territory is political and logistical, not merely spatial
- Control, legitimacy, logistics, and force are **distinct variables**
- Player intent degrades over time via **command friction**
- Fronts emerge from pressure and interaction, **not player placement**
- **Settlements are the only authoritative spatial substrate**
- Municipalities exist only as metadata / reference containers
- Outcomes must be **emergent, never scripted**

---

## 2. HISTORICAL & DESIGN CANON (BINDING)

**Primary analytical anchor:** *Balkan Battlegrounds*
- Anchor, not a script
- Independent historical reasoning required
- No nationalist or post-war narratives
- No hard-coded historical outcomes

**Design documents override code.** If code contradicts them, code is wrong:
1. Rulebook (Game Bible)
2. Systems & Mechanics Manual
3. Engine Invariants

---

## 3. CURRENT CANON: MAP & GEOGRAPHY (LOCKED)

### Settlement-first doctrine (ACTIVE, LOCKED)

- Settlement polygons are the **only** authoritative geometry
- Settlements are entities tied to polygons
- Municipality geometry is **explicitly deferred**
- Municipality IDs exist only as attributes on settlements
- **No simulation logic may depend on municipality borders**

### Canonical source data

**Authoritative source files:**
- `data/source/bih_master.geojson`
- `data/source/bih_census_1991.json`

**Canonical derived substrate (Phase 0):**
- `data/derived/settlements_substrate.geojson`
- `data/derived/settlements_substrate.audit.json`
- `data/derived/settlements_substrate.audit.txt`

**Canonical viewer:**
- `data/derived/substrate_viewer/`
  - `index.html`
  - `viewer.js`
  - `data_index.json`

**Canonical scripts:**
- `scripts/map/derive_settlement_substrate_from_master.ts`
- `scripts/map/build_substrate_viewer_index.ts`

**Canonical npm commands:**
- `map:derive:substrate`
- `map:viewer:substrate:index`

### What is explicitly NOT used

- Municipality geometry
- Municipality borders in simulation logic
- Inferred, repaired, or guessed borders
- SVG-derived settlement polygons
- Any hulls, unions, smoothing, buffering

---

## 4. PHASE 0 STATUS (COMPLETE & LOCKED)

**Phase 0 goals achieved:**
- Settlement substrate derived deterministically from `bih_master.geojson`
- 6,135 settlement polygons
- Stable settlement IDs
- Valid polygon geometries
- Municipality IDs present as metadata
- No geometry invention or repair
- Full audit artifacts produced
- Viewer renders settlements correctly
- Viewer colors by settlement-level majority ethnicity, not municipality

**Phase 0 is locked.** No further changes unless explicitly authorized and logged.

---

## 5. EXPLICITLY FORBIDDEN (STILL IN FORCE)

- Inventing geography
- Boolean unions, hulls, smoothing, buffering
- Guessing or repairing borders
- Adjusting game systems to fit bad geography
- UI tricks to hide uncertainty
- Silent correction of data

**If data is wrong → log it**
**If assumptions fail → record them**
**If design shifts → flag FORAWWV.md**

---

## 6. MISTAKE-LOG GUARDRAIL (MANDATORY, ABSOLUTE)

**Authoritative file:** `docs/ASSISTANT_MISTAKES.log` (plain text, append-only)

**Helper module (must be used):** `tools/assistant/mistake_guard.ts`

Exports:
- `loadMistakes()`
- `assertNoRepeat(context: string)`
- `appendMistake(entry)`

### Integration rule (ABSOLUTE)

At the top of every script touched:

```typescript
import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";

loadMistakes();
assertNoRepeat("<short description of what this script does>");
```

- Warnings only
- Never throw
- If a real mistake is discovered, append it

---

## 7. PROJECT LEDGER SYSTEM (MANDATORY)

**Authoritative file:** `docs/PROJECT_LEDGER.md`

**Purpose:**
- Current phase
- Canon decisions
- What is being worked on
- What is deferred
- Changelog of actions

### Rule (ABSOLUTE)

Every Cursor prompt must:
1. **READ** `docs/PROJECT_LEDGER.md`
2. **WRITE** a new changelog entry after completion

No exceptions.

---

## 8. FORAWWV.md — DESIGN CANON EXTENSION (MANDATORY)

**Authoritative conceptual addendum:** `docs/FORAWWV.md`

**Purpose:**
- Record validated systemic insights
- Capture design truths discovered during implementation
- Extend (never contradict) the Rulebook & Manuals

### Rule (ABSOLUTE)

- Cursor must **never** edit FORAWWV.md automatically
- Every Cursor prompt must include:

> If this task reveals a systemic design insight or invalidates an assumption, explicitly flag that `docs/FORAWWV.md` may require an addendum. Do not edit it automatically.

---

## 9. CURSOR PROMPT RULES (VERY IMPORTANT)

Cursor prompts are:
- **ALWAYS** code blocks
- **NEVER** prose
- **NEVER** mixed

**Cursor always runs the scripts**

Every Cursor prompt **MUST** include:
- Ledger action (READ + WRITE)
- Mistake-log guardrail
- FORAWWV.md flag rule
- Single, narrow task
- Files to touch
- Deterministic constraints
- Acceptance criteria
- How to run / test

### Canonical header template

```
You are Cursor editing the AWWV repo.

LEDGER ACTION (MANDATORY)
1) READ docs/PROJECT_LEDGER.md
2) WRITE a new changelog entry after completion

MISTAKE LOG (MANDATORY)
- loadMistakes()
- assertNoRepeat("...")

FORAWWV.md NOTE (MANDATORY)
- If this task reveals a systemic design insight or invalidates an assumption,
  explicitly flag that docs/FORAWWV.md may require an addendum. Do NOT edit it.

Task: ...

Constraints:
- Deterministic
- No inference
- No geometry invention

Acceptance: ...

How to test: ...
```

---

## 10. SETTLEMENT-FIRST ROADMAP (ACTIVE PLAN)

### Phase 0 — Freeze settlement substrate ✅ COMPLETE, LOCKED

### Phase 1 — Settlement adjacency graph (NEXT)
- Derive deterministic adjacency between settlement polygons
- Undirected graph
- Edges represent physical contiguity only
- Optional metadata allowed (e.g. border length)
- No terrain inference yet
- **Deliverables:**
  - `settlement_graph.json`
  - Audit report

### Phase 2 — Settlement-level state model
- Per-settlement state only:
  - Control
  - Authority / legitimacy
  - Supply access
  - Population present / displaced
  - Exhaustion (irreversible)
- No formations
- No fronts
- No combat

### Phase 3 — Pre-frontline coercion & fragmentation
- Authority collapse without fronts
- Coercive spread via adjacency
- Internal fragmentation possible

### Phase 4 — Formations as overlays
- Formations = overlays on settlements
- AoR = set of settlements
- Command friction & cohesion decay

### Phase 5 — Pressure & attrition combat
- Pressure across adjacency
- Attrition + exhaustion drive collapse
- Encirclement = graph cut + supply failure

### Phase 6 — Displacement & mobilization coupling
- Displacement permanently alters capacity
- Recruitment responds to catastrophe
- Population loss irreversible

### Phase 7 — External patrons
- Aid, embargo, recognition
- Conditional, asymmetric pressure

### Phase 8 — Negotiation endgame
- Negotiation pressure from exhaustion + displacement
- Treaty ends war
- End-state snapshot

---

## 11. FINAL DIRECTIVE

You are not fixing a map. You are building a **truthful substrate** that:
- exposes uncertainty
- preserves determinism
- never lies to the simulation

**Nothing is silently corrected. Everything is logged, audited, or flagged.**

---

## State at handover

- **Phase 0 is locked and complete.**
- **Repository is clean.**
- **Next work begins at Phase 1: Settlement adjacency graph.**
