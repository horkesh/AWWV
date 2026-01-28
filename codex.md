# Codex Context: A War Without Victory (AWWV)

## Project overview
AWWV is a strategic-level simulation of the 1991–1995 war in Bosnia and Herzegovina. It is **not** a tactical wargame: there is no unit micromanagement or battle resolution. The simulation emphasizes negative-sum conflict, irreversible exhaustion, and emergent outcomes from logistics, control, legitimacy, and fragmentation rather than scripted history or geographic guesswork.

## Canon and constraints
- **Design docs override code.** If code conflicts with the Rulebook, Systems & Mechanics Manual, or Engine Invariants, the code is wrong.
- **Settlement-first doctrine.** Settlements are the authoritative spatial substrate. Municipality geometry is treated as metadata and must not drive simulation logic.
- **Determinism is mandatory.** Outputs must be stable with fixed sorting, precision, and no timestamps.
- **No geography invention.** No hulls/union smoothing, border guessing, or silent correction of data.

## Current phase summary
The project is in **Map Rebuild (Path A)** mode:
- Polygons (`poly_id`) represent territorial micro-areas from SVG/HTML sources.
- Settlements (`sid`) are simulation entities from Excel and are point/graph-based.
- Polygons and settlements link only via municipalities (`mid`), not directly to each other.
- Crosswalks and outline derivations are explicit and deterministic; missing crosswalks produce fallback outputs.

## Key repositories and artifacts
- **Source data:** `data/source/`
- **Derived artifacts:** `data/derived/`
- **Map tools:** `tools/map/`
- **Simulation code:** `src/`
- **Docs and specs:** `docs/`

## Operational rules (must follow)
- **Aggregate rows filtering:** Any row containing `∑` in *any* cell is excluded from settlement-level data.
- **GeoJSON output required:** Emit valid GeoJSON even if `features` is empty.
- **Render-valid primary gate:** Use render-validity as the gate; GIS validity is diagnostic.
- **Settlement IDs must be globally unique:** Remapping is only allowed with explicit mapping files.
- **Canvas polygon isolation:** Each polygon is drawn with its own `beginPath()/moveTo()/closePath()`.

## Deterministic build/testing commands
- Map build: `npm run build:map`
- Map checks: `npm run map:check`
- Audit municipality coverage: `npm run audit:muni`
- Settlement/municipality alignment audit: `npm run audit:settlements:muni`

## Notes on tooling
- TypeScript scripts are run with `tsx` (no compile step).
- Deterministic ordering and fixed precision are required across outputs.
- Use `npm` if `pnpm` is unavailable.

## When adding work
- Respect the Map Rebuild (Path A) architecture: polygons are **not** settlements.
- Never infer or fix missing data silently; log issues or add explicit reports.
- If new systemic design insights appear, flag `docs/FORAWWV.md` for a possible addendum (do not edit it automatically).
