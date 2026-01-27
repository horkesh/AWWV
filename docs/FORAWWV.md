# For AWWV: A Deep Dive into Building a War That Nobody Wins

> *"The best way to predict the future is to build it. The best way to understand war is to simulate it. The hardest way to do both is to make sure you get the details right."*

## What the Hell Is This Thing?

**A War Without Victory (AWWV)** is not your average strategy game. It's not Hearts of Iron. It's not Civilization. It's not even XCOM. It's something weirder, harder, and frankly more ambitious: a grand-strategy simulation of the Bosnian War (1991-1995) that treats conflict as a fundamentally negative-sum process where nobody truly wins—they just stop losing at different rates.

Think of it as **SimCity meets Clausewitz meets a historical tragedy**, where you're not building an empire but desperately trying to keep one from completely falling apart. Every decision has consequences. Every military victory generates exhaustion. Every political compromise creates new fractures. And the "victory conditions"? They're just different flavors of exhaustion-induced settlements.

This document is your roadmap to understanding how we built this monster, why we made the choices we did, what went catastrophically wrong (and how we fixed it), and what you can learn from building something this complex.

---

## Part I: The Big Picture — What Are We Even Building?

### The Core Philosophical Stance

Before you write a single line of code for a project like this, you need to answer a fundamental question: **What are you simulating, and why?**

AWWV isn't trying to simulate *fun*. It's trying to simulate *reality*—a specific, brutal reality where:
- Military power alone never resolves conflicts
- Political collapse can be as decisive as battlefield defeat
- Logistics and exhaustion matter more than heroic charges
- There are no clean victories, only negotiated exits

This is **not** a power fantasy. It's a strategic tragedy simulator.

### The Design Philosophy in Three Rules

1. **No cost-free violence**: Every military action generates exhaustion. Always. Forever. Even if you win.
2. **No unitless control**: You can't magically own territory. You need actual formations there, consuming supplies, generating pressure, and accumulating fatigue.
3. **No predetermined outcomes**: History constrains possibilities but doesn't script results. The simulation must allow for alternate paths.

These aren't just game design choices—they're **architectural invariants** that shape every system in the codebase.

---

## Part II: The Technical Stack — Why We Chose What We Chose

### TypeScript: The Language of Deterministic Regret

**Choice:** TypeScript for the entire simulation engine.

**Why?**
- **Type safety prevents simulation drift**: When you're modeling 109 municipalities, each with their own authority states, supply corridors, and exhaustion levels, runtime type errors are *catastrophic*. TypeScript catches these at compile time.
- **Interfaces as contracts**: The simulation has to be deterministic (same inputs → same outputs). TypeScript interfaces enforce contracts between systems without ambiguity.
- **Developer experience**: Autocomplete and IntelliSense are not luxuries when your data model has 50+ interconnected classes. They're survival tools.

**The Alternative We Rejected:**
We considered Python for rapid prototyping. Python is great for data science and would've made the census data processing easier. But for a deterministic simulation engine with complex state management? Python's dynamic typing would've killed us. Every refactor would've been a minefield.

**Lesson Learned:** Choose static typing for systems where bugs don't show themselves immediately. Dynamic typing is fine for scripts and data pipelines. It's a nightmare for stateful simulations.

---

### The Data Model: Settlement-Level Granularity

**Choice:** 6,141 settlements as atomic spatial units, grouped into 109 municipalities.

**Why?**
This was actually one of the hardest design decisions. We could have gone coarser (just municipalities) or finer (individual buildings). We chose settlements because:

1. **Historical accuracy**: The 1991 census data is settlement-based. Using it meant we could populate the world with real demographic data.
2. **Meaningful granularity**: Municipalities are too big—you lose the ability to model local control fragmentation. Buildings are too small—the simulation becomes unplayable.
3. **Graph-based connectivity**: Settlements naturally form a graph where edges = roads/supply routes. This makes pathfinding and supply tracing tractable.

**The Problem We Hit:**
When we first processed the census data, we got a **total population of 8.75 million**. This was wrong—the actual 1991 census showed **4.377 million**. 

**What Happened:**
We were double-counting. The census data includes both:
- Administrative aggregates (municipality-level totals)
- Individual settlement records

We were naively summing *everything*, which counted each person twice—once in their settlement, once in the municipality total.

**The Fix:**
We added a `type` field to the census data and **excluded** all aggregates. Only actual geographic settlements got counted. The code now explicitly checks:

```typescript
// Pseudo-code from the data processing pipeline
if (record.type === 'administrative_aggregate') {
  skip(); // Don't double-count
}
```

**Lesson Learned:** When working with hierarchical data, always verify totals against known ground truth. If your numbers don't match reality, you're probably double-counting or missing a level of aggregation.

---

### The Spatial Model: Why We Chose GeoJSON

**Choice:** GeoJSON for settlement geography and connectivity.

**Why?**
- **Industry standard**: Every mapping library understands GeoJSON. D3.js, Leaflet, Mapbox—they all speak GeoJSON natively.
- **Human-readable**: JSON is easy to debug. When your settlement graph breaks, you can *actually read* the data without specialized tools.
- **Feature properties**: GeoJSON lets you attach arbitrary metadata to each point/polygon. We store population, control status, supply state, everything.

**The Visualization Challenge:**
When we first tried to visualize 6,141 settlements in a browser, **the page froze**. Rendering that many SVG elements with hover tooltips is computationally expensive.

**The Solution:**
We created a **dual-track visualization system**:
1. **Lightweight embedded demo**: Pre-filters data to ~500-1000 most significant settlements, embeds data directly in HTML
2. **Full local server version**: Loads all 6,141 settlements via CORS-safe HTTP server, uses canvas rendering for better performance

**Lesson Learned:** Always plan for scale early. What works with 100 data points won't work with 10,000. Build performance budgets into your architecture from day one.

---

### No Randomness: The Determinism Doctrine

**Choice:** Zero randomness anywhere in the simulation core.

**Why?**
- **Reproducibility**: The same save file must produce identical results. No "well it worked on my machine" bugs.
- **Testing**: You can't write reliable tests for random behavior. Determinism makes every state transition verifiable.
- **Debugging**: When something breaks, you need to be able to replay the exact sequence of events. Randomness destroys this.

**How We Enforce It:**
The Engine Invariants document explicitly forbids:
- `Math.random()`
- `Date.now()` in derived artifacts
- Non-stable collection iteration (we sort everything with canonical IDs)

**The Temptation We Resisted:**
There were moments when adding a little RNG seemed so *easy*. "Just make combat outcomes slightly random for realism!" But that's a trap. Once you introduce one random element, the entire determinism guarantee collapses.

**Lesson Learned:** Determinism is a **system property**, not a feature you can add later. Either commit to it from the start or don't bother. Hybrid approaches fail.

---

## Part III: The Architecture — How the Pieces Fit Together

### The Layered Simulation Model

AWWV is structured as four interacting layers, with strict dependencies:

```
Political Layer (Authority, Legitimacy, Governance)
     ↓
Military Layer (Formations, Brigades, Combat Pressure)
     ↓
Logistical Layer (Supply, Corridors, Sustainability)
     ↓
Spatial Layer (Settlements, Municipalities, Connectivity)
```

**Key Insight:** No layer can override another. Military success doesn't automatically grant political authority. Logistics failure can doom battlefield dominance. This isn't a bug—it's the entire point.

### Brigade Areas of Responsibility: The Core Spatial Abstraction

This is where things get interesting. In most strategy games, you select units and tell them where to go. AWWV doesn't work that way.

**The Model:**
- Each brigade is assigned an **Area of Responsibility (AoR)**: a contiguous cluster of settlements
- Every settlement is assigned to exactly one brigade's AoR (no gaps, no overlaps)
- Players reshape AoRs by transferring settlements between adjacent brigades
- Territorial change happens through sustained pressure within AoRs, not direct settlement targeting

**Why This Design?**

1. **Realistic command abstraction**: Real brigade commanders don't micromanage individual towns. They're responsible for sectors.
2. **Computational tractability**: Instead of calculating pressure at 6,141 settlements, we calculate it at brigade AoR boundaries (~50-200 brigades depending on the faction).
3. **Emergent frontlines**: Fronts emerge where opposing brigades' AoRs meet. You don't draw them—they *happen*.

**The Invariant We Enforce:**
```typescript
// From Engine Invariants
// Each settlement must be assigned to exactly one brigade at all times
// No settlement may be unassigned or assigned to multiple brigades
```

This is checked **every turn**. If it's violated, the simulation halts.

**Lesson Learned:** When modeling complex systems, find the right abstraction level. Too granular = unplayable. Too abstract = meaningless. AoRs hit the sweet spot for strategic-level warfare.

---

### The Turn Resolution Pipeline

Every turn resolves in a **fixed order**. This is critical for determinism:

1. **Directive Phase**: Player inputs are collected
2. **Deployment Commitment Phase**: Formations commit to positions
3. **Military Interaction Phase**: Pressure calculations resolve
4. **Fragmentation Resolution Phase**: Municipalities may split into Control Zones
5. **Supply Resolution Phase**: Corridor states update
6. **Political Effects Phase**: Authority and legitimacy shift
7. **Exhaustion Update Phase**: All exhaustion accumulates
8. **Persistence Phase**: State is serialized for save/load

**Why This Order Matters:**
If you calculate supply *before* military interactions, you get different results than if you calculate it *after*. We fixed the order and documented it.

**The Bug We Hit:**
Early on, we had fragmentation resolving *before* supply. This meant a municipality could fragment, cutting a corridor, which would then affect supply calculations *in the same turn*. But the supply system hadn't updated yet, so the corridor state was stale.

**The Fix:**
We moved supply resolution to happen *after* fragmentation but *before* political effects. This ensures corridor states reflect current connectivity when authority degradation is calculated.

**Lesson Learned:** In turn-based simulations, **order is everything**. Write down the resolution order, document it, and enforce it in code. Don't let systems update in undefined sequences.

---

### The Exhaustion System: The Real Win Condition

Exhaustion is the secret sauce that makes AWWV work. It's tracked across three dimensions:

1. **Military Exhaustion**: Attrition, static fronts, overextension
2. **Political Exhaustion**: Authority collapse, fragmentation, legitimacy loss
3. **Societal Exhaustion**: Displacement, economic strain, civilian suffering

**The Mechanical Insight:**
Exhaustion is **monotonic** (it only goes up) and **irreversible** (you can't un-exhaust). This creates a natural pressure toward negotiation as the war drags on.

**Why This Works:**
Real wars don't end because one side is militarily defeated. They end because the cost of continuing exceeds the value of any achievable outcome. Exhaustion models this.

**The Design Pattern:**
```typescript
class ExhaustionSystem {
  // Exhaustion accumulates from multiple sources
  accumulateFromCombat(casualties: number): void { ... }
  accumulateFromFragmentation(zones: number): void { ... }
  accumulateFromDisplacement(refugees: number): void { ... }
  
  // Cross-dimensional amplification
  // High military exhaustion makes political exhaustion worse, and vice versa
  applyAmplification(): void { ... }
  
  // Exhaustion can never decrease
  // This is enforced in the validator
  validateMonotonicity(): void { ... }
}
```

**Lesson Learned:** When designing game systems, think about *what drives decisions*, not just *what players can do*. Exhaustion isn't fun, but it creates meaningful strategic pressure. That's more important than fun.

---

## Part IV: The Data Pipeline — From Census to GeoJSON

### The Census Data Challenge

We had to convert the 1991 Bosnia and Herzegovina census into a playable game world. This meant:

1. **Cleaning the data**: Removing administrative aggregates, handling missing coordinates
2. **Demographic breakdown**: Tracking Bosniaks, Serbs, Croats, and Others by settlement
3. **Spatial mapping**: Assigning lat/lon to each settlement
4. **Connectivity inference**: Building the settlement adjacency graph

**The Process:**

```
Raw Census CSV → Python Pandas → Cleaned CSV → GeoJSON Generator → 
Final GeoJSON → Browser Visualization
```

**The Double-Counting Bug (Reprise):**
This was the most painful bug in the entire project. We spent hours debugging why our population totals were wrong before realizing the census data had multiple levels of granularity.

**The Solution Pattern:**
```python
# Exclude administrative aggregates
df_filtered = df[df['type'] != 'administrative_aggregate']

# Verify totals match known census data
total_population = df_filtered['total_population'].sum()
assert total_population == 4_377_033, f"Expected 4.377M, got {total_population}"
```

**Lesson Learned:** Always assert your ground truth. If you know the answer should be X, assert it. Don't just hope your code is right.

---

### The Visualization Journey

**Problem:** How do you visualize 6,141 settlements without crashing the browser?

**Attempt 1: Naive SVG**
We generated one SVG circle per settlement with hover tooltips. The browser rendered about 2,000 before giving up.

**Attempt 2: Canvas Rendering**
Switched to HTML5 Canvas. Better performance, but lost SVG's native event handling. Had to implement hit detection manually.

**Attempt 3: Dual-Track Approach**
We ended up with two versions:
1. **Embedded demo** with ~500 settlements for quick testing
2. **Full server version** with all 6,141 settlements

**The CORS Battle:**
Browsers won't let you load local JSON files via `fetch()` from a file:// URL. Security policy.

**The Solution:**
```bash
# Start a simple HTTP server
python3 -m http.server 8000
```

Now the HTML can fetch data via `http://localhost:8000/data/settlements.geojson`.

**Lesson Learned:** Browser security exists for good reasons. Don't fight it—work with it. Local servers are your friend.

---

## Part V: The Peace Treaty System — When Wars End (But Not Really)

### The Treaty Architecture

Version 0.2.5 introduced a complete peace treaty system. This was complex because:

1. **Treaties are compositional**: They can include territorial clauses, institutional competence allocations, and military annexes
2. **Acceptance is computed, not guaranteed**: We calculate whether a faction accepts based on exhaustion, territorial control, and institutional valuations
3. **Some treaties trigger peace, some don't**: Only territorial transfer/recognition treaties end the war

**The Brčko Problem:**

In real-world Dayton negotiations, the status of Brčko (a strategic corridor city) was a deal-breaker. We modeled this:

```typescript
// Any peace-triggering treaty MUST address Brčko
if (isPeaceTriggeringTreaty(treaty) && !treaty.brcko_special_status) {
  return {
    accepted: false,
    rejection_reason: 'brcko_unresolved'
  };
}
```

**Why This Matters:**
It's a **completeness constraint**. It enforces historical accuracy while preventing the player from ignoring critical political realities.

**The Competence Bundle Rule:**

Some institutional powers must be allocated together:
- `customs + indirect_taxation` (you can't split trade policy)
- `defence_policy + armed_forces_command` (military command requires defense authority)

**The Implementation:**
```typescript
// Bundles are enforced at validation time
const bundles = [
  ['customs', 'indirect_taxation'],
  ['defence_policy', 'armed_forces_command']
];

function validateBundles(allocations: Map<CompetenceId, Holder>): boolean {
  for (const bundle of bundles) {
    const holders = bundle.map(c => allocations.get(c));
    if (!allSame(holders)) {
      return false; // Bundle members must have same holder
    }
  }
  return true;
}
```

**Lesson Learned:** When modeling real-world systems, pay attention to *inherent constraints*. Some things just can't be separated. Model them as invariants, not suggestions.

---

## Part VI: The Dev UI — Tools for the Toolmaker

### Why We Built a Dev UI

The simulation engine is headless—it's pure logic with no interface. But humans can't work with pure logic. We needed tools to:

1. **Inspect state**: What's the current exhaustion level of each faction?
2. **Construct scenarios**: Set up initial conditions for testing
3. **Debug treaties**: See why a treaty was rejected
4. **Visualize connectivity**: Which corridors are brittle? Which are cut?

**The Architecture:**

```
React Frontend ↔ Simulation Engine (TypeScript) ↔ Data Files (JSON)
```

The UI is a separate codebase (`dev_ui/`) that imports the engine as a library.

**The Key Pattern: Separation of Concerns**

```typescript
// Engine provides pure functions
export function calculateAcceptance(treaty: Treaty, state: GameState): number {
  // Pure calculation, no UI dependencies
}

// UI calls the engine and displays results
function TreatyInspector({ treaty, state }) {
  const acceptance = calculateAcceptance(treaty, state);
  return <div>Acceptance: {acceptance}%</div>;
}
```

**Why This Matters:**
By keeping the engine UI-agnostic, we can:
- Test it in isolation
- Use it from CLI tools
- Eventually build a real game UI without rewriting core logic

**Lesson Learned:** Build your engine as a library first, UI second. Not the other way around. Libraries force you to think about clean interfaces.

---

## Part VII: The Testing Philosophy

### What We Test (And What We Don't)

**We Test:**
- **Invariant enforcement**: Does the engine halt if a settlement is unassigned?
- **Determinism**: Does the same save file produce identical results?
- **Data integrity**: Do population totals match census records?

**We Don't Test:**
- **"Fun"**: This is subjective and changes based on playtesting
- **Balance**: Numbers will get tuned constantly
- **UI interactions**: UI is too volatile early in development

**The Test Structure:**

```
tests/
  unit/          # Individual system tests
  integration/   # Multi-system interaction tests
  invariants/    # Assertion validation tests
```

**A Sample Invariant Test:**

```typescript
test('every settlement must be assigned to exactly one brigade', () => {
  const state = loadGameState('test_scenario.json');
  
  const assignments = new Map<SettlementId, BrigadeId>();
  
  for (const settlement of state.settlements) {
    if (assignments.has(settlement.id)) {
      throw new Error(`Settlement ${settlement.id} assigned multiple times`);
    }
    if (!settlement.assignedBrigade) {
      throw new Error(`Settlement ${settlement.id} not assigned`);
    }
    assignments.set(settlement.id, settlement.assignedBrigade);
  }
});
```

**Lesson Learned:** Test invariants, not implementation details. Invariants are stable. Implementation changes.

---

## Part VIII: The Bugs We Hit (And How We Fixed Them)

### Bug #1: The Double-Counting Census Disaster

**Symptom:** Total population was 8.75M instead of 4.377M.

**Root Cause:** Including administrative aggregates in settlement sum.

**Fix:** Filter by record type, exclude aggregates.

**Prevention:** Assert ground truth in data pipeline.

---

### Bug #2: The Stale Corridor State Race Condition

**Symptom:** Corridors showed as "Open" when they should be "Cut" after fragmentation.

**Root Cause:** Supply resolution ran before fragmentation resolution.

**Fix:** Reorder turn phases: fragmentation → supply → political effects.

**Prevention:** Document and enforce turn resolution order.

---

### Bug #3: The Non-Contiguous AoR Explosion

**Symptom:** Reshaping AoRs could create non-contiguous chunks.

**Root Cause:** No validation that transferred settlements maintained contiguity.

**Fix:** Added graph connectivity check:

```typescript
function validateAoRContiguity(aor: Settlement[]): boolean {
  const visited = new Set<SettlementId>();
  const queue = [aor[0]];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    
    for (const neighbor of current.adjacentSettlements) {
      if (aor.includes(neighbor)) {
        queue.push(neighbor);
      }
    }
  }
  
  return visited.size === aor.length;
}
```

**Prevention:** Validate spatial invariants at allocation time, not later.

---

### Bug #4: The Treaty Acceptance NaN Bug

**Symptom:** Treaty acceptance calculations returned `NaN`.

**Root Cause:** Division by zero when exhaustion was zero (early game).

**Fix:** Add guard clause:

```typescript
function calculateAcceptance(treaty: Treaty, state: GameState): number {
  const exhaustion = state.getExhaustion();
  if (exhaustion === 0) return 0; // Can't accept peace with no pressure
  
  return (treaty.value * exhaustion) / maxExhaustion;
}
```

**Prevention:** Handle edge cases explicitly. Zero is a valid input.

---

## Part IX: The Lessons — What I Hope You Learn From This

### Lesson 1: Constraints Are Features

The most interesting parts of AWWV are the **things you can't do**:
- You can't control territory without units
- You can't ignore exhaustion
- You can't achieve total military victory

These aren't bugs. They're the core design. **Embrace constraints.**

---

### Lesson 2: Data Is Your Foundation

We spent weeks getting the census data right. It felt wasteful. But every hour spent on data quality saved us 10 hours debugging "Why does this municipality have negative population?"

**Get your data right first.** Everything else builds on it.

---

### Lesson 3: Determinism Is Worth It

The temptation to add randomness is constant. "Just a little RNG for combat outcomes!" No. Determinism is a superpower. It makes testing possible, debugging tractable, and saves reproducible.

**Choose determinism unless you have a very good reason not to.**

---

### Lesson 4: Document Your Invariants

The Engine Invariants document is 50+ lines of rules. "No cost-free violence." "No unitless control." "Exhaustion is monotonic."

These aren't suggestions—they're **architectural contracts**. Write them down. Reference them in code. Validate them at runtime.

**Invariants prevent system drift.**

---

### Lesson 5: Build Tools for Yourself

The Dev UI wasn't for players. It was for us. But it made development 10x faster. We could inspect state, test treaties, visualize corridors—all without diving into JSON files.

**Invest in developer tools early.** You'll pay it back 100x.

---

### Lesson 6: Abstraction Level Is Everything

AoRs are the perfect example. We could have gone settlement-by-settlement (too granular) or faction-by-faction (too abstract). Brigade-level AoRs hit the sweet spot.

**Find the abstraction level where complexity becomes manageable.**

---

### Lesson 7: Test What Matters

We don't test "Is this fun?" We test "Does this violate determinism?" Tests should validate **system properties**, not subjective experiences.

**Test contracts, not feelings.**

---

### Lesson 8: Performance Is a Feature

The visualization crashed with 6,141 settlements. We didn't give up—we built a dual-track system. Embedded demo for quick tests, full server for deep analysis.

**Plan for scale. Always.**

---

### Lesson 9: Real-World Constraints Matter

The Brčko rule. The competence bundles. These come from real geopolitical constraints. Modeling them makes the simulation *more* interesting, not less.

**Don't simplify away the interesting parts.**

---

### Lesson 10: Code Is a Living Document

The game bible is frozen at v0.2.5. But the code keeps evolving. Documentation lags. Tests catch regressions. The codebase is the truth.

**Treat code as your source of truth.** Document the *why*, not the *what*.

---

## Part X: What Comes Next

### Immediate Priorities

1. **Performance optimization**: 6,141 settlements is manageable, but combat calculations at scale are still slow
2. **Front visualization**: We need to show emergent frontlines in the UI
3. **Save/load system**: Full game state serialization and deserialization
4. **AI opponent**: Eventually, the player needs something to fight against

### Long-Term Vision

This isn't just a game about the Bosnian War. It's a **framework for simulating negative-sum conflicts**. The architecture should support:
- Different historical scenarios (Syria, Ukraine, etc.)
- Procedural generation of fictional conflicts
- Multi-faction simulations (not just 3 sides)

**The goal is to build a conflict simulation engine, not just a game.**

---

## Epilogue: Why This Matters

Building AWWV has been an exercise in confronting complexity. Not just technical complexity, but historical, political, and moral complexity. How do you simulate a war where everyone loses? How do you model exhaustion, trauma, and political fragmentation?

The answer is: **very carefully**.

Every system in this codebase represents a design choice about how to model human conflict. The exhaustion system says "wars are won by not losing." The AoR system says "control is continuous, not binary." The treaty system says "peace is negotiated, not achieved."

These aren't just game mechanics. They're **arguments about how the world works.**

And that's what makes this project worth building.

---

## Technical Appendix: The Stack at a Glance

**Languages:**
- TypeScript (simulation engine)
- Python (data processing)
- JavaScript/React (Dev UI)

**Core Libraries:**
- D3.js (visualization)
- Pandas (data processing)
- Node.js (tooling)

**Data Formats:**
- GeoJSON (spatial data)
- JSON (game state)
- CSV (census data)

**Architecture Patterns:**
- Layered simulation (Political → Military → Logistical → Spatial)
- Turn-based resolution pipeline
- Deterministic state machines
- Invariant-driven design

**Key Files:**
- `src/engine/` - Core simulation logic
- `src/systems/` - Individual subsystems (exhaustion, supply, combat)
- `data/` - GeoJSON and census data
- `dev_ui/` - Developer interface
- `tests/` - Invariant and integration tests

**Repository Structure:**
```
AWWV/
├── src/                    # Engine source code
│   ├── engine/            # Core simulation
│   ├── systems/           # Subsystems
│   └── data/              # Data models
├── data/                  # GeoJSON, census data
├── dev_ui/                # Developer UI (React)
├── tests/                 # Test suite
├── scripts/               # Build and data processing
├── docs/                  # Design documents
└── saves/                 # Save game files
```

---

## Final Thoughts: How Good Engineers Think

Throughout this project, we learned that good engineering isn't about writing clever code. It's about:

1. **Asking the right questions**: "What are we really simulating?" comes before "How do we code this?"
2. **Choosing the right abstractions**: Brigade AoRs over individual settlements
3. **Enforcing constraints**: Invariants prevent drift
4. **Planning for failure**: Every system has edge cases
5. **Building tools**: The Dev UI makes everything else faster
6. **Documenting intent**: Why is more important than what
7. **Testing what matters**: Invariants over implementation
8. **Accepting complexity**: Some problems are just hard

**The meta-lesson:** Building complex systems is an act of intellectual humility. You will be wrong. Your initial design will have holes. Your data will be messy. Your code will break.

**The goal is not perfection. The goal is resilience.**

Build systems that can survive your mistakes. Write tests that catch your oversights. Document your assumptions. And when you find a bug, don't just fix it—understand *why* it happened and prevent the entire class of bugs.

That's how you build something that lasts.

That's how you build AWWV.

---

## Addendum: Settlement Boundary Digitization and Adjacency Detection

**Date Added:** 2026-01-27
**Context:** Phase 1 Settlement Adjacency Graph Implementation

### The Discovery

During Phase 1 implementation of the settlement adjacency graph, we discovered a fundamental characteristic of the source geometry data that required a significant algorithmic pivot.

**The Problem:** Initial adjacency algorithms (v1, v2) detected only ~350 edges with ~90% of settlements isolated. This was implausible for a tessellation-like map where settlements should share borders.

**Root Cause:** Settlement polygons in `bih_master.geojson` were **digitized independently**. Neighboring settlements have boundaries that are:
- **Nearly parallel** but not on the exact same line
- **Within ~0.001-0.01 coordinate units** of each other
- **Not sharing exact coordinate sequences**

This means two adjacent settlements have boundaries like two parallel lines ~0.005 units apart, rather than a single shared line with different vertex placements.

### The Evidence

Analysis of 200 settlement pairs with overlapping bounding boxes revealed:
- **418 pairs** had boundaries within 0.01 units (essentially touching)
- **Only 84 pairs** (5.4%) had exact shared vertices at 4-decimal precision
- **Typical boundary gaps:** 0.001-0.01 units (digitization tolerance)

The v1/v2 algorithms used EPS ~1e-5 for colinearity detection, but actual gaps were 100x larger.

### The Architectural Invariant

**Settlement adjacency detection must use tolerance-based boundary matching, not exact coordinate comparison.**

This is not a bug to be fixed—it's a fundamental characteristic of the source data. Any adjacency algorithm for this dataset must:

1. **Accept parallel boundaries within tolerance** (not require exact colinearity)
2. **Use Hausdorff-distance or similar metrics** to measure "closeness" of boundary segments
3. **Derive tolerance parameters deterministically** from dataset bounds (not hardcode magic numbers)

### The Solution: v3 Algorithm

The v3 algorithm uses Hausdorff-distance segment matching:
- **Parallel threshold:** cos(10°) ≈ 0.985 (segments must be nearly parallel)
- **Distance tolerance:** ~0.02 units (derived as 2e-5 × max dimension)
- **Minimum overlap:** 0.1 units (reject tiny incidental overlaps)

**Results:**
| Version | Edges | Isolated | Isolation Rate |
|---------|-------|----------|----------------|
| v1 (exact) | 297 | 5,604 | 91.3% |
| v2 (colinear) | 345 | 5,519 | 89.9% |
| v3 (tolerance) | 15,260 | 61 | 1.0% |

### Implications for Future Work

1. **Any new adjacency algorithms** must account for independent boundary digitization
2. **Coordinate snapping or unification** is explicitly forbidden (would invent geometry)
3. **Tolerance parameters** should be derived from dataset bounds, not hardcoded
4. **Point-touch remains diagnostic-only**—v3's tolerance-based shared-border detection is the canonical method

### The Lesson

**Don't assume geographic data shares coordinates just because it looks like a tessellation.** Always verify with actual coordinate comparison before choosing an adjacency detection strategy. When boundaries are independently digitized, tolerance-based matching is not a workaround—it's the correct approach.

---

**Now go forth and simulate the unsimulatable.**
