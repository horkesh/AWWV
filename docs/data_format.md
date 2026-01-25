# Data format

This project uses simple JSON files under `data/` for map-related inputs. Formats are intentionally minimal and easy to validate.

## `data/settlements.json`

Supported shapes:

### Preferred (versioned wrapper)

```json
{
  "version": "0.2",
  "settlements": [
    { "id": "10014", "name": "Example" }
  ]
}
```

### Also accepted

- Array of objects: `[{ "id": "10014", "name": "Example" }]`
- Array of ids: `["10014", "10049"]`

Only `id` is required by the loader/validator right now.

## `data/edges.json`

Defines adjacency edges between settlements.

```json
{
  "version": "0.1",
  "allow_self_loops_default": false,
  "edges": [
    { "a": "10014", "b": "10049" },
    { "a": "10146", "b": "10189", "one_way": true },
    { "a": "10219", "b": "10219", "allow_self_loop": true }
  ]
}
```

Fields:
- `a`, `b` (**required**): settlement ids
- `one_way` (optional, default `false`): if `true`, reverse edge is not required
- `allow_self_loop` (optional, default `allow_self_loops_default`): if `true`, permits `a === b`

## Map validations (`sim:mapcheck`)

`npm run sim:mapcheck` loads `data/settlements.json` + `data/edges.json` and checks:

- Every edge endpoint references an existing settlement
- No self-loops unless explicitly allowed
- Edges are bidirectional unless marked `one_way`
- Orphan settlements (degree 0) are reported as warnings (sampled to avoid huge output)

