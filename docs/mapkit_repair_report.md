## MapKit remediation report (deterministic)
### Inputs
- GeoJSON: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.geojson`
- Suspects CSV: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\diagnostics\suspects.csv` 
### Summary
- total_features_read: 6103
- total_features_valid: 6103
- invalid_or_unsupported_geometries_skipped: 0
- suspects_in_csv: 6103
- suspects_found_in_geojson: 6103
### Main reference bounds
- main_bounds_raw: {"minX":-179.97335999999996,"minY":-89.99999914622636,"maxX":940.9638,"maxY":910.09033}
- main_bounds_expanded(10%): {"minX":-292.06707599999993,"minY":-190.009032060849,"maxX":1053.057516,"maxY":1010.0993629146226}
### Pre-repair diagnostics
- percent_centroids_inside_main_bounds_expanded: 100.00%
- percent_suspect_centroids_inside_main_bounds_expanded: 100.00%
- stray_cluster_percent(two-means): 26.74% (stray=1632, main=4471)
### Regime decision
- decision: scale
- reason: Scale regime detected by span ratio (kx=1.000000, ky=1.000000), insideAfter 100.0%.
- params: {"kx":1,"ky":1}
### Repair output
- wrote: `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.repaired.geojson` and `C:\Users\User\OneDrive - United Nations Development Programme\Documents\Personal\Wargame\AWWV\data\derived\settlements_polygons.repaired_summary.json`
### Post-repair diagnostics
- percent_centroids_inside_main_bounds_expanded: 100.00%
- percent_suspect_centroids_inside_main_bounds_expanded: 100.00%
- stray_cluster_percent(two-means): 26.74% (stray=1632, main=4471)
### Next steps if decision is `lonlat` or `none`
- This script intentionally refuses to auto-fix ambiguous cases.
- If `lonlat`: locate authoritative projection step/parameters in MapKit source and reproject those geometries upstream.
- If `none`: investigate SID↔geometry join integrity (wrong geometry attached to SID) and/or multiple regimes.
