# Identity Migration Summary

## Task Completed: Recode Factions to Political Entities

Successfully migrated faction system from army-based IDs (ARBiH, VRS, HVO) to political entity IDs (RBiH, RS, HRHB) while preserving army visibility as formation-level force labels.

## Summary of Touched Files

### Core Identity System
- **src/state/identity.ts** (NEW) - Canonical definitions for political sides and army labels

### State Schema
- **src/state/game_state.ts** - Added `force_label?: ArmyLabel` to `FormationState`
- **src/state/schema.ts** - Added `force_label?: ArmyLabel` to `FormationState`

### Migration & Serialization
- **src/state/serialize.ts** - Added canonicalization logic:
  - Canonicalizes faction IDs in `factions[*].id`
  - Canonicalizes `formations[*].faction` and preserves army labels as `force_label`
  - Canonicalizes `militia_pools[*].faction`
  - Canonicalizes `negotiation_ledger[*].faction_id`
  - Canonicalizes `front_posture` and `front_posture_regions` keys

### Validation
- **src/validate/factions.ts** - Enforces political sides only (RBiH, RS, HRHB)
- **src/validate/formations.ts** - Validates political sides for faction, validates `force_label` if present
- **src/validate/militia_pools.ts** - Enforces political sides for militia pool factions
- **src/validate/validate.ts** - Added call to `validateFactions()` in `validateState()`

### CLI Commands (All Updated to Canonicalize Inputs)
- **src/cli/sim_formations.ts** - Canonicalizes `--faction`, includes `force_label` in list output
- **src/cli/sim_militia.ts** - Canonicalizes `--faction`
- **src/cli/sim_set_posture.ts** - Canonicalizes `--faction`
- **src/cli/sim_set_posture_region.ts** - Canonicalizes `--faction`
- **src/cli/sim_generate_formations.ts** - Canonicalizes `--faction`
- **src/cli/sim_negcap.ts** - Canonicalizes `--faction` (spend command)
- **src/cli/sim_phase5_check.ts** - Canonicalizes `--faction`
- **src/cli/sim_scenario.ts** - Added `by_force_label` counts to scenario summaries

### Tests
- **tests/identity_migration.test.ts** (NEW) - Migration and validation tests
- **tests/state.test.ts** - Updated to use RBiH instead of 'blue'
- **tests/formations_validate.test.ts** - Updated to use RBiH/RS instead of A/B
- **tests/militia_pools.test.ts** - Updated to use RBiH instead of ARBiH
- **tests/formations_deterministic.test.ts** - Updated to use RBiH/RS instead of A/B
- **tests/generate_formations.test.ts** - Updated to use RBiH/RS instead of ARBiH/VRS

### Documentation
- **docs/handoff_map_pipeline.md** - Added identity glossary, updated formation/militia docs, updated CLI notes
- **ARCHITECTURE_SUMMARY.md** - Added identity system section, updated FormationState docs, updated serialization notes

## CLI Help Excerpt Showing Canonicalization Behavior

### Example: sim:formations add command

```bash
npm run sim:formations <save.json> add --faction <faction_id> --name "<name>"
```

**Canonicalization behavior:**
- Accepts political side IDs: `RBiH`, `RS`, `HRHB` (used as-is)
- Accepts legacy army labels: `ARBiH`, `VRS`, `HVO` (canonicalized to `RBiH`, `RS`, `HRHB` respectively)
- Rejects unknown faction IDs with error: `Invalid faction: "<id>" (canonicalized to "<canonical>"). Must be one of: RBiH, RS, HRHB`
- Automatically sets `force_label` to default army label for the faction (ARBiH for RBiH, VRS for RS, HVO for HRHB)

### Example: sim:militia set command

```bash
npm run sim:militia <save.json> set --mun <mun_id> --faction <faction_id> --available <int>
```

**Canonicalization behavior:**
- Same as formations: accepts political sides or army labels, canonicalizes to political sides
- `--faction-null` can be used to set faction to null (no canonicalization needed)

### Example: sim:negcap spend command

```bash
npm run sim:negcap <save.json> spend --faction <id> --amount <int> --reason <string>
```

**Canonicalization behavior:**
- Accepts political sides or army labels, canonicalizes to political sides before processing

## Example Formation List Output

### Human-readable output (sim:formations list):

```
formations for turn 1
  - RBiH force_label=ARBiH F_RBiH_0001 name="1st Division" status=active created_turn=1 assignment=unassigned
  - RS force_label=VRS F_RS_0001 name="2nd Corps" status=active created_turn=1 assignment=region=RS--RBiH::e1
  - HRHB force_label=HVO F_HRHB_0001 name="3rd Brigade" status=active created_turn=1 assignment=edge=a__b
```

### JSON output (sim:formations list --json):

```json
{
  "schema": 1,
  "turn": 1,
  "formations": [
    {
      "id": "F_RBiH_0001",
      "faction": "RBiH",
      "force_label": "ARBiH",
      "name": "1st Division",
      "created_turn": 1,
      "status": "active",
      "assignment": null
    },
    {
      "id": "F_RS_0001",
      "faction": "RS",
      "force_label": "VRS",
      "name": "2nd Corps",
      "created_turn": 1,
      "status": "active",
      "assignment": {
        "kind": "region",
        "region_id": "RS--RBiH::e1"
      }
    }
  ]
}
```

### Scenario Summary Output (sim:scenario --summary):

```json
{
  "schema": 1,
  "turns": [
    {
      "turn": 1,
      "formations": {
        "total": 3,
        "by_faction": [
          { "faction_id": "HRHB", "formations": 1 },
          { "faction_id": "RBiH", "formations": 1 },
          { "faction_id": "RS", "formations": 1 }
        ],
        "by_force_label": [
          { "force_label": "ARBiH", "formations": 1 },
          { "force_label": "HVO", "formations": 1 },
          { "force_label": "VRS", "formations": 1 }
        ],
        ...
      }
    }
  ]
}
```

## Migration Behavior

### Old Save with Army IDs as Factions

**Before migration:**
```json
{
  "factions": [
    { "id": "ARBiH", ... },
    { "id": "VRS", ... },
    { "id": "HVO", ... }
  ],
  "formations": {
    "F1": {
      "id": "F1",
      "faction": "ARBiH",
      "name": "Test",
      ...
    }
  }
}
```

**After migration:**
```json
{
  "factions": [
    { "id": "RBiH", ... },
    { "id": "RS", ... },
    { "id": "HRHB", ... }
  ],
  "formations": {
    "F1": {
      "id": "F1",
      "faction": "RBiH",
      "force_label": "ARBiH",
      "name": "Test",
      ...
    }
  }
}
```

### New Save with Political Sides

**Input:**
```json
{
  "factions": [
    { "id": "RBiH", ... }
  ],
  "formations": {
    "F1": {
      "id": "F1",
      "faction": "RBiH",
      "name": "Test",
      ...
    }
  }
}
```

**After migration (default force_label added):**
```json
{
  "factions": [
    { "id": "RBiH", ... }
  ],
  "formations": {
    "F1": {
      "id": "F1",
      "faction": "RBiH",
      "force_label": "ARBiH",
      "name": "Test",
      ...
    }
  }
}
```

## Validation Rules

1. **Faction IDs must be political sides**: Only `RBiH`, `RS`, `HRHB` are allowed
2. **Formation factions must be political sides**: Same restriction
3. **Militia pool factions must be political sides or null**: Same restriction
4. **Force labels must be army labels**: If present, must be one of `ARBiH`, `VRS`, `HVO`
5. **Consistency warning**: If `force_label` doesn't match default for faction, emits a warning (not error) for flexibility

## Test Results

- ✅ `npm run typecheck` passes
- ✅ `npm test` passes (115 tests, 0 failures)
- ✅ Migration tests verify canonicalization
- ✅ Validation tests verify political side enforcement
- ✅ All existing tests updated and passing

## Documentation Updates

- ✅ `docs/handoff_map_pipeline.md` - Added identity glossary, updated formation/militia documentation, updated CLI notes
- ✅ `ARCHITECTURE_SUMMARY.md` - Added identity system section, updated FormationState and serialization documentation
