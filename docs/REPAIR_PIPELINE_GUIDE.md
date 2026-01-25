# Map Repair Pipeline - User Guide

This guide walks you through the complete workflow to diagnose, repair, validate, and visually verify the settlement polygon GeoJSON file.

---

## Prerequisites Checklist

### 1. Install Dependencies
- [ ] Open PowerShell or Command Prompt
- [ ] Navigate to the repository root directory
- [ ] Run: `npm install`
- [ ] Wait for installation to complete (only needed once, or after `package.json` changes)

---

## Step-by-Step Workflow

### 2. Export Suspects from UI

**Goal:** Generate a CSV file listing all problematic settlement polygons for the repair script to process.

- [ ] Start the development server:
  ```
  npm run dev:map
  ```
- [ ] Open your browser and navigate to:
  ```
  http://localhost:3000/dev_ui/ui0_map.html
  ```
- [ ] Wait for the map to load (you should see settlement outlines)
- [ ] In the right sidebar, scroll to the "Diagnostics" section
- [ ] Click the **"Download suspects.csv"** button (green button)
- [ ] Save the downloaded file to: `data/diagnostics/suspects.csv` (create the `data/diagnostics/` directory if it doesn't exist)
- [ ] **Stop the dev server** by pressing `Ctrl+C` in the terminal

**What to expect:** The CSV will contain columns: `sid`, `clusterLabel`, `scaleLabel`, `shapeLabel`, `locationLabel`, `centroidX`, `centroidY`, and bounds information. This identifies which settlements are in the stray cluster, have unusual scales/shapes, or are outside the main bounds.

**If no suspects are found:**
- The UI will offer to download `all_features.csv` instead
- You can use this file for the repair script - it contains all the coordinate data needed
- Save it to `data/diagnostics/suspects.csv` (the repair script will work with it)
- The repair script analyzes coordinate ranges to detect projection issues, so it doesn't strictly need the classification labels

---

### 3. Run Repair Script

**Goal:** Apply coordinate system transformations to fix mis-projected geometries.

- [ ] In the repository root, run:
  ```
  npm run map:repair
  ```
- [ ] **Read the terminal output carefully.** Look for:

  **Success indicators:**
  - `✓ Regime detected: [lon/lat or x/y]`
  - `✓ Transform applied: [transformation details]`
  - `✓ Wrote repaired file: data/derived/settlements_polygons.repaired.geojson`
  - Feature count statistics showing how many were transformed

  **Refusal indicators (important!):**
  - `⚠ lon/lat regime detected` (may indicate data is already in correct format)
  - `⚠ ambiguous regime, no safe transform`
  - `✗ Refused to apply transform: [reason]`

**What happens:**
- The script reads `data/diagnostics/suspects.csv`
- It analyzes the coordinate ranges to detect if geometries are in lon/lat vs x/y (projected) coordinates
- If a safe transform is identified, it applies it and writes `data/derived/settlements_polygons.repaired.geojson`
- If the regime is ambiguous or already correct, it refuses to transform (safety measure)

**If repair refuses:**
- **Do NOT proceed to validation yet**
- The script should have generated analysis reports in `data/diagnostics/`
- Look for files like `repair_analysis_report.json` or similar
- **Next step:** Run the repair script in analysis-only mode (if available) or attach the generated report files
- Share the "Regime detection" section from the terminal output
- **Do NOT suggest remapping everything** — the next step is to locate the upstream source of those geometries and correct the projection/join in the map build step

---

### 4. Run Validation

**Goal:** Verify the repaired file meets quality standards.

- [ ] Run the validator:
  ```
  npm run map:validate
  ```
  (This validates the original file by default)

- [ ] To validate the repaired file specifically:
  ```
  npm run map:validate -- --input data/derived/settlements_polygons.repaired.geojson
  ```

- [ ] **Interpret the output:**

  **Key metrics to check:**
  - **NaN/Infinity count:** Should be `0`
  - **Bounds sanity:** 
    - `minX`, `minY`, `maxX`, `maxY` should be reasonable (e.g., lon: -180 to 180, lat: -90 to 90 for geographic)
    - No extreme values like `1e10` or `-1e10`
  - **Stray cluster percentage:** Should be below threshold (e.g., < 5% of total features)
  - **Inside-main-bounds rate:** Should be high (e.g., > 95% of features inside expanded main bounds)

  **Pass criteria:**
  - ✅ No NaN/Infinity values
  - ✅ Bounds are within expected ranges
  - ✅ Stray cluster % is below threshold
  - ✅ High percentage of features inside main bounds

  **Fail indicators:**
  - ❌ NaN or Infinity detected in coordinates
  - ❌ Bounds are extreme or invalid
  - ❌ Stray cluster % is too high
  - ❌ Many features outside main bounds

**What to do if validation fails:**
- Review the specific failure metrics
- Check if the repair script actually applied a transform (see Step 3 output)
- If repair refused, follow the "If repair refuses" guidance above
- If repair applied but validation still fails, the transform may need adjustment or the issue is upstream

---

### 5. Visual QA in UI

**Goal:** Confirm the repaired file fixes the visual issues (stray cluster disappears, missing settlements appear).

- [ ] Restart the dev server:
  ```
  npm run dev:map
  ```
- [ ] Open the map viewer:
  ```
  http://localhost:3000/dev_ui/ui0_map.html
  ```
- [ ] **Load the repaired file** by adding `?repaired=1` to the URL:
  ```
  http://localhost:3000/dev_ui/ui0_map.html?repaired=1
  ```
- [ ] Wait for the map to load

**Visual checks:**

- [ ] **Stray cluster check:**
  - Look at the top-left corner of the map (or wherever the stray cluster was)
  - The stray cluster should be **gone or drastically reduced**
  - If you see a red error message: "No repaired file found, run npm run map:repair", go back to Step 3

- [ ] **Map silhouette check:**
  - The overall map shape should be **intact** (no major distortions)
  - Settlement outlines should form a recognizable geographic region
  - No features should be scattered in random locations

- [ ] **Missing settlements check:**
  - Use the search box (top bar) to search for SIDs that were previously "missing" (from the suspects list)
  - Type a SID and click "Go" or press Enter
  - The map should **pan to and highlight** the settlement
  - The settlement should appear **in-place** (where it geographically should be), not in the stray cluster location

- [ ] **Toggle comparison:**
  - Remove `?repaired=1` from the URL to see the original file
  - Add `?repaired=1` back to see the repaired file
  - Compare: the repaired version should show fewer stray features and more settlements in correct locations

**Success indicators:**
- ✅ No top-left junk block (or drastically reduced)
- ✅ Map silhouette intact
- ✅ Ability to search/jump to previously "missing" SIDs and see them in-place
- ✅ Stray cluster count in diagnostics is much lower (or zero)

---

## Success Criteria Summary

### Technical Validation
- [ ] `npm run map:repair` writes `data/derived/settlements_polygons.repaired.geojson` (unless it correctly refuses)
- [ ] `npm run map:validate` passes:
  - [ ] No NaN/Infinity values
  - [ ] Bounds are sane (within expected ranges)
  - [ ] Stray cluster % below threshold
  - [ ] Inside-main-bounds rate is high (> 95%)

### Visual Verification
- [ ] UI with `?repaired=1` shows:
  - [ ] No top-left junk block (or drastically reduced)
  - [ ] Map silhouette intact
  - [ ] Ability to search/jump to previously "missing" SIDs and see them in-place

---

## Troubleshooting

### "No repaired file found" error in UI
- **Cause:** The repair script hasn't run yet, or it refused to create a file
- **Solution:** 
  1. Go back to Step 3 and run `npm run map:repair`
  2. Check the terminal output to see if it created the file or refused
  3. If it refused, follow the "If repair refuses" guidance in Step 3

### Repair script refuses to transform
- **Cause:** The coordinate regime is ambiguous or already correct
- **Solution:**
  1. Check the terminal output for the "Regime detection" section
  2. Look for generated analysis files in `data/diagnostics/`
  3. Share the regime detection output (no need for raw GeoJSON)
  4. **Do NOT remap everything** — next step is to fix the upstream map build process

### Validation fails after repair
- **Cause:** The transform may not have been appropriate, or the issue is upstream
- **Solution:**
  1. Review which validation checks failed
  2. Check if the repair script actually applied a transform (see Step 3 output)
  3. If transform was applied, the transform parameters may need adjustment
  4. If transform was refused, the issue is in the map build pipeline

### Stray cluster still visible after repair
- **Cause:** The repair may not have addressed all issues, or some features are genuinely outliers
- **Solution:**
  1. Check the diagnostics panel in the UI — what's the stray cluster count?
  2. Compare original vs repaired: is it reduced?
  3. If still high, the transform may need refinement or there may be multiple coordinate system issues

---

## File Locations Reference

- **Original GeoJSON:** `data/derived/settlements_polygons.geojson`
- **Repaired GeoJSON:** `data/derived/settlements_polygons.repaired.geojson`
- **Suspects CSV:** `data/diagnostics/suspects.csv`
- **Analysis reports:** `data/diagnostics/` (various JSON/text files)

---

## Next Steps After Successful Repair

Once the repair pipeline is validated:

1. **Review the transform:** Understand what coordinate transformation was applied
2. **Fix upstream:** Identify where in the map build process the mis-projection occurred
3. **Update build pipeline:** Correct the projection/join in the map build step so future builds don't need repair
4. **Document:** Record the transform parameters and root cause for future reference

---

## Notes

- The repair pipeline is **read-only** on the engine — it only modifies the derived GeoJSON file
- The UI switch (`?repaired=1`) is **UI-only** — it doesn't affect the engine or any other systems
- Always validate both original and repaired files to understand the impact
- If repair refuses, **do not force it** — investigate the root cause in the map build process instead
