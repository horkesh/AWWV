# AWWV context primer

## Authoritative docs

- **[ARCHITECTURE_SUMMARY.md](ARCHITECTURE_SUMMARY.md)** — Phase changelog and architecture summary.
- **[docs/ENGINE_FREEZE_v0_2_6.md](docs/ENGINE_FREEZE_v0_2_6.md)** — Frozen engine contract (v0.2.6).

## Mandatory workflow guardrails

- **Ledger:** Every Cursor prompt must **READ** [docs/PROJECT_LEDGER.md](docs/PROJECT_LEDGER.md) and **WRITE** a new changelog entry after completion.
- **Mistake log:** Use `loadMistakes()` and `assertNoRepeat("<context>")` in scripts; treat [docs/ASSISTANT_MISTAKES.log](docs/ASSISTANT_MISTAKES.log) as the canonical “do not repeat” source.

## Known blockers / current limitations

- **Missing `data/source/mun_code_crosswalk.csv`:** Polygons have `mid = null`. Mid-based municipality outlines cannot be derived. Fallback: national outline plus mun_code outlines for inspection only; inspector shows “No municipality outlines (mun_code_crosswalk.csv missing)”.
