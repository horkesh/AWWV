# MapKit Regeneration Report

## Inputs
- ZIP: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\source\settlements_pack.zip`
- XLSX: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\source\master_settlements.xlsx`

## Outputs
- GeoJSON: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen.geojson`
- Summary: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen_summary.json`
- Conflicts: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen_conflicts.json`

## Key Counts
- Total features: 5994
- Municipalities: 142
- Missing XLSX joins: 0

## XLSX Allowlist Filtering
- Total skipped (not in allowlist): 144
- Summary IDs excluded from allowlists: 142
- Missing XLSX sheets: 0

**Rationale:** The XLSX master file defines the authoritative list of settlements per municipality. Any JS path records whose `munID` is not in the XLSX allowlist (excluding the municipality summary row where `settlementId == munCode`) are excluded.

### Top Files with Skipped Records:
- `Ribnik_20508.js`: 2 skipped
- `Banovici_10014.js`: 1 skipped
- `Banja Luka_20010.js`: 1 skipped
- `Berkovici_20028.js`: 1 skipped
- `Bihac_10049.js`: 1 skipped
- `Bijeljina_20036.js`: 1 skipped
- `Bileca_20044.js`: 1 skipped
- `Bosanska Dubica_20265.js`: 1 skipped
- `Bosanska Gradiska_20125.js`: 1 skipped
- `Bosanska Krupa_11428.js`: 1 skipped
- `Bosanski Novi_20397.js`: 1 skipped
- `Bosanski Petrovac_11436.js`: 1 skipped
- `Bosansko Grahovo_10146.js`: 1 skipped
- `Bratunac_20052.js`: 1 skipped
- `Brcko_30163.js`: 1 skipped
- `Breza_10189.js`: 1 skipped
- `Brod_20079.js`: 1 skipped
- `Bugojno_10197.js`: 1 skipped
- `Busovaca_10219.js`: 1 skipped
- `Buzim_11240.js`: 1 skipped

### Sample Examples:
- `Banovici_10014.js`: munCode=10014, munID=100013
- `Banja Luka_20010.js`: munCode=20010, munID=200018
- `Berkovici_20028.js`: munCode=20028, munID=200603
- `Bihac_10049.js`: munCode=10049, munID=100811
- `Bijeljina_20036.js`: munCode=20036, munID=200832
- `Bileca_20044.js`: munCode=20044, munID=201502
- `Bosanska Dubica_20265.js`: munCode=20265, munID=210706
- `Bosanska Gradiska_20125.js`: munCode=20125, munID=206113
- `Bosanska Krupa_11428.js`: munCode=11428, munID=169552
- `Bosanski Novi_20397.js`: munCode=20397, munID=215066
- `Bosanski Petrovac_11436.js`: munCode=11436, munID=105520
- `Bosansko Grahovo_10146.js`: munCode=10146, munID=106151
- `Bratunac_20052.js`: munCode=20052, munID=202185
- `Brcko_30163.js`: munCode=30163, munID=300101
- `Breza_10189.js`: munCode=10189, munID=107735
- `Brod_20079.js`: munCode=20079, munID=202746
- `Bugojno_10197.js`: munCode=10197, munID=108049
- `Busovaca_10219.js`: munCode=10219, munID=108901
- `Buzim_11240.js`: munCode=11240, munID=104108
- `Cajnice_20630.js`: munCode=20630, munID=228311


## Deduplication
- Exact duplicates dropped: 20
- Conflicts resolved: 9

### Top Conflicts (kept vs dropped):
- **10499:164984**: kept `Kladanj_10499.js` (score: undefined) vs dropped `Kladanj_10499.js` (score: undefined)
- **10499:166138**: kept `Kladanj_10499.js` (score: undefined) vs dropped `Kladanj_10499.js` (score: undefined)
- **10499:170046**: kept `Kladanj_10499.js` (score: undefined) vs dropped `Kladanj_10499.js` (score: undefined)
- **10588:130478**: kept `Livno_10588.js` (score: undefined) vs dropped `Livno_10588.js` (score: undefined)
- **10774:138487**: kept `Novi Travnik_10774.js` (score: undefined) vs dropped `Novi Travnik_10774.js` (score: undefined)
- **11533:135950**: kept `Orasje_11533.js` (score: undefined) vs dropped `Orasje_11533.js` (score: undefined)
- **20044:201634**: kept `Bileca_20044.js` (score: undefined) vs dropped `Bileca_20044.js` (score: undefined)
- **20508:219371**: kept `Ribnik_20508.js` (score: undefined) vs dropped `Ribnik_20508.js` (score: undefined)
- **20583:225665**: kept `Trebinje_20583.js` (score: undefined) vs dropped `Trebinje_20583.js` (score: undefined)

See `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen_conflicts.json` for full conflict list.

## Geometry Types
- Polygon: 5959
- MultiPolygon: 35

## Global Bounds
- minX: 1.000000
- minY: -9.521430
- maxX: 940.963800
- maxY: 910.090330

## Cluster Diagnostic
- Cluster A size: 2280
- Cluster B size: 3714
- Stray cluster: A (38.04%)
- Cluster A bounds: {"minX":8.708379590926754,"minY":0.11604048556961774,"maxX":732.3379504494379,"maxY":568.3773407649136}
- Cluster B bounds: {"minX":327.9602255699003,"minY":121.68494532520324,"maxX":936.7456764044937,"maxY":901.6897392929291}

**Note:** Stray cluster persists after dedupe; likely genuine coordinate-regime split in source JS pack.
Inspect conflicts + run UI diagnostics on regen output.

## Missing XLSX Joins
All settlements have XLSX data.

## Coordinate Regime Diagnosis

- Files STRAY: 63 / 142 (44.4%)
- Features STRAY: 2219 / 5994 (37.02%)

### Top 20 STRAY Files (by feature count):
- **Travnik_11061.js**: 89 features, dx=177.3, dy=122.4, kx=1.517, ky=1.181 (likelyScale+Offset)
- **Doboj_20141.js**: 82 features, dx=79.5, dy=300.2, kx=0.749, ky=0.813 (likelyScale+Offset)
- **Bugojno_10197.js**: 77 features, dx=222.4, dy=63.8, kx=1.273, ky=1.419 (likelyScale+Offset)
- **Prijedor_20486.js**: 70 features, dx=402.5, dy=365.6, kx=0.702, ky=0.699 (likelyScale+Offset)
- **Bosanska Gradiska_20125.js**: 67 features, dx=278.2, dy=404.6, kx=0.766, ky=0.814 (likelyScale+Offset)
- **Donji Vakuf_10294.js**: 67 features, dx=241.4, dy=95.9, kx=1.339, ky=1.220 (likelyScale+Offset)
- **Sanski Most_11541.js**: 66 features, dx=436.6, dy=306.1, kx=0.846, ky=0.764 (likelyScale+Offset)
- **Prnjavor_20494.js**: 62 features, dx=187.4, dy=337.5, kx=0.850, ky=0.782 (likelyScale+Offset)
- **Bosanska Dubica_20265.js**: 60 features, dx=392.9, dy=427.4, kx=0.946, ky=0.823 (likelyScale+Offset)
- **Bihac_10049.js**: 58 features, dx=587.1, dy=303.1, kx=0.668, ky=0.642 (likelyScale+Offset)
- **Brcko_30163.js**: 58 features, dx=-78.0, dy=318.7, kx=0.847, ky=0.751 (likelyScale+Offset)
- **Jajce_11487.js**: 57 features, dx=267.0, dy=158.1, kx=0.944, ky=1.031 (likelyScale+Offset)
- **Livno_10588.js**: 57 features, dx=358.2, dy=-18.3, kx=0.484, ky=0.532 (likelyScale+Offset)
- **Derventa_20133.js**: 56 features, dx=113.8, dy=362.9, kx=0.788, ky=0.849 (likelyScale+Offset)
- **Teslic_20575.js**: 56 features, dx=135.2, dy=237.7, kx=0.813, ky=0.686 (likelyScale+Offset)
- **Glamoc_10359.js**: 54 features, dx=373.6, dy=64.3, kx=0.601, ky=0.663 (likelyScale+Offset)
- **Banja Luka_20010.js**: 53 features, dx=319.3, dy=301.5, kx=0.574, ky=0.520 (likelyScale+Offset)
- **Cazin_10227.js**: 53 features, dx=601.9, dy=384.3, kx=1.001, ky=0.939 (likelyScale+Offset)
- **Novi Travnik_10774.js**: 50 features, dx=183.5, dy=90.6, kx=1.218, ky=1.258 (likelyScale+Offset)
- **Srebrenik_10987.js**: 48 features, dx=-22.8, dy=274.7, kx=1.123, ky=1.182 (likelyScale+Offset)

**Diagnosis artifact:** `data/derived/mapkit_regime_diagnosis.json`

**Note:** No transforms applied yet. Next step is deterministic normalization using this diagnosis.

## Coordinate Regime Normalization
- Transformed files: 17 / 63 STRAY files
- Unresolved files: 46
  - Unresolved: Banja Luka_20010.js, Bosanska Gradiska_20125.js, Bosanski Petrovac_11436.js, Bosansko Grahovo_10146.js, Brcko_30163.js, Brod_20079.js, Bugojno_10197.js, Celinac_20648.js, Derventa_20133.js, Doboj Istok_11258.js, Doboj Jug_11266.js, Doboj_20141.js, Dobretici_11274.js, Domaljevac-Samac_11282.js, Donji Vakuf_10294.js, Donji Zabar_20150.js, Drvar_11614.js, Glamoc_10359.js, Gracanica_11479.js, Istocni Drvar_20184.js, Knezevo_20257.js, Kotor Varos_20281.js, Kupres (RS)_20303.js, Kupres_11517.js, Laktasi_20311.js, Livno_10588.js, Modrica_20354.js, Mrkonjic Grad_20362.js, Novi Travnik_10774.js, Odzak_11525.js, Orasje_11533.js, Ostra Luka_20435.js, Petrovac_20460.js, Petrovo_20478.js, Prijedor_20486.js, Prnjavor_20494.js, Ribnik_20508.js, Samac_20656.js, Sipovo_20672.js, Srbac_20559.js, Srebrenik_10987.js, Tesanj_11045.js, Teslic_20575.js, Travnik_11061.js, Usora_11622.js, Vukosavlje_20109.js
- Transformed features: 625
- Stray cluster before: 37.02%
- Stray cluster after: 37.42%
### Safety Gates:
- Gate A (centroid distance reduction): All transformed files reduced distance to main regime by >= 90%
- Gate B (scale sanity): All transformed files have scale ratios within [0.5, 2.0]
- Gate C (in-bounds rate): All transformed files have >= 95% centroids within expanded main bounds
**Normalized GeoJSON:** `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen_norm.geojson`
**Summary:** `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.regen_norm_summary.json`

## Next Steps for Validation
1. Run validation: `npm run map:regen:validate`
2. Compare with original: `npm run map:validate`
3. View in UI: Open `dev_ui/ui0_map.html?regen=1`
4. Check for missing/misplaced settlements
