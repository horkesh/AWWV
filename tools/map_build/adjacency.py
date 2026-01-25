#!/usr/bin/env python3
"""
Generate settlement adjacency edges from GeoJSON polygons using spatial indexing.

Reads settlements_polygons.geojson and generates settlement_edges.json and adjacency_report.json.
Uses shapely STRtree for efficient spatial queries.

Calibration mode:
  python tools/map_build/adjacency.py --calibrate
  Generates adjacency_calibration.json with distance quantiles and suggested GAP_TOLERANCE.
"""

import hashlib
import json
import sys
import time
import argparse
import math
import subprocess
from pathlib import Path
from typing import Dict, List, Set, Tuple, Union, Optional

try:
    from shapely.geometry import Polygon, MultiPolygon, LineString, Point, box, MultiLineString
    from shapely.strtree import STRtree
    from shapely.ops import unary_union
    from shapely.prepared import prep
except ImportError:
    print("ERROR: shapely is required. Install with: pip install shapely", file=sys.stderr)
    sys.exit(1)


EPSILON = 0.001  # Threshold to ignore point-touches (in coordinate units)
GAP_TOLERANCE = 1.0  # Maximum distance between boundaries to consider adjacent (in map units)
SCRIPT_VERSION = "adjacency.py v2"  # Version identifier for self-identification


def get_git_commit() -> Optional[str]:
    """
    Get the current git commit hash if available.
    Returns None if git is not available or not in a git repository.
    """
    try:
        result = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=Path(__file__).parent.parent.parent
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
        pass
    return None


def load_polygons(geojson_path: Path) -> Tuple[Dict[str, Union[Polygon, MultiPolygon]], Dict[str, dict], int]:
    """
    Load polygons from GeoJSON and return sid->geometry mapping and properties.
    Supports both Polygon and MultiPolygon geometries.
    Returns (polygons_dict, properties_dict, invalid_geometry_count).
    """
    with open(geojson_path, 'r', encoding='utf-8') as f:
        geojson = json.load(f)
    
    polygons = {}
    properties = {}
    invalid_geometry_count = 0
    
    for feature in geojson.get('features', []):
        sid = feature.get('properties', {}).get('sid')
        if not sid:
            continue
        
        geom = feature.get('geometry')
        if not geom:
            invalid_geometry_count += 1
            print(f"WARNING: Skipping feature with no geometry for {sid}", file=sys.stderr)
            continue
        
        geom_type = geom.get('type')
        coords = geom.get('coordinates', [])
        
        if not coords:
            invalid_geometry_count += 1
            print(f"WARNING: Skipping feature with empty coordinates for {sid}", file=sys.stderr)
            continue
        
        try:
            geometry = None
            
            if geom_type == 'Polygon':
                # Convert GeoJSON Polygon to shapely Polygon
                # GeoJSON: [[[x,y], [x,y], ...]] (exterior ring)
                ring = coords[0]  # Exterior ring
                geometry = Polygon(ring)
                
            elif geom_type == 'MultiPolygon':
                # Convert GeoJSON MultiPolygon to shapely MultiPolygon
                # GeoJSON: [[[[x,y], [x,y], ...]], [[[x,y], [x,y], ...]], ...]
                # Each element is a Polygon coordinate array
                geometry = MultiPolygon([Polygon(poly_coords[0]) for poly_coords in coords])
                
            else:
                invalid_geometry_count += 1
                print(f"WARNING: Skipping unsupported geometry type '{geom_type}' for {sid}", file=sys.stderr)
                continue
            
            if geometry is None or not geometry.is_valid:
                # Try to fix invalid geometry
                if geometry is not None:
                    geometry = geometry.buffer(0)
                
                if geometry is None or not geometry.is_valid or geometry.is_empty:
                    invalid_geometry_count += 1
                    print(f"WARNING: Skipping invalid geometry for {sid}", file=sys.stderr)
                    continue
            
            polygons[sid] = geometry
            properties[sid] = feature.get('properties', {})
            
        except Exception as e:
            invalid_geometry_count += 1
            print(f"WARNING: Failed to create geometry for {sid}: {e}", file=sys.stderr)
            continue
    
    return polygons, properties, invalid_geometry_count


def get_boundary_segments(geometry: Union[Polygon, MultiPolygon]) -> List[LineString]:
    """
    Extract boundary line segments from a Polygon or MultiPolygon.
    For MultiPolygon, extracts segments from all constituent polygons.
    Returns all boundary segments deterministically.
    """
    segments = []
    
    if isinstance(geometry, Polygon):
        # Single polygon - extract exterior ring segments
        coords = list(geometry.exterior.coords)
        for i in range(len(coords) - 1):
            segment = LineString([coords[i], coords[i + 1]])
            segments.append(segment)
    
    elif isinstance(geometry, MultiPolygon):
        # MultiPolygon - extract segments from all constituent polygons
        # Iterate over each polygon part deterministically
        for poly in geometry.geoms:
            coords = list(poly.exterior.coords)
            for i in range(len(coords) - 1):
                segment = LineString([coords[i], coords[i + 1]])
                segments.append(segment)
    
    else:
        raise TypeError(f"Unsupported geometry type: {type(geometry)}")
    
    return segments


def segments_share_line(segments1: List[LineString], segments2: List[LineString], epsilon: float) -> bool:
    """
    Check if two sets of segments share a line segment longer than epsilon.
    Returns True if there's a shared segment (not just point-touch).
    """
    for seg1 in segments1:
        for seg2 in segments2:
            # Check if segments overlap (share a meaningful portion)
            if not seg1.intersects(seg2):
                continue
            
            # Get intersection
            intersection = seg1.intersection(seg2)
            
            if isinstance(intersection, LineString):
                # Shared line segment - check length
                length = intersection.length
                if length > epsilon:
                    return True
            elif isinstance(intersection, Point):
                # Point intersection - check if it's more than just endpoints
                # If intersection is at endpoints of both segments, it's point-touch
                seg1_coords = list(seg1.coords)
                seg2_coords = list(seg2.coords)
                
                # Check if intersection point is at endpoints
                intersection_point = intersection
                seg1_start = Point(seg1_coords[0])
                seg1_end = Point(seg1_coords[-1])
                seg2_start = Point(seg2_coords[0])
                seg2_end = Point(seg2_coords[-1])
                
                # Check distances to endpoints
                at_seg1_start = intersection_point.distance(seg1_start) < epsilon
                at_seg1_end = intersection_point.distance(seg1_end) < epsilon
                at_seg2_start = intersection_point.distance(seg2_start) < epsilon
                at_seg2_end = intersection_point.distance(seg2_end) < epsilon
                
                # If intersection is at endpoints of both segments, skip (point-touch)
                if (at_seg1_start or at_seg1_end) and (at_seg2_start or at_seg2_end):
                    continue
                
                # If intersection is interior to at least one segment, it's a shared segment
                # (This means the segments overlap, not just touch at endpoints)
                if not (at_seg1_start or at_seg1_end) or not (at_seg2_start or at_seg2_end):
                    return True
            elif hasattr(intersection, 'geoms'):
                # MultiPoint or GeometryCollection - check if any non-endpoint intersection
                for geom in intersection.geoms:
                    if isinstance(geom, LineString) and geom.length > epsilon:
                        return True
                    elif isinstance(geom, Point):
                        # Check if it's not just an endpoint
                        seg1_coords = list(seg1.coords)
                        seg2_coords = list(seg2.coords)
                        seg1_start = Point(seg1_coords[0])
                        seg1_end = Point(seg1_coords[-1])
                        seg2_start = Point(seg2_coords[0])
                        seg2_end = Point(seg2_coords[-1])
                        
                        at_seg1_endpoint = geom.distance(seg1_start) < epsilon or geom.distance(seg1_end) < epsilon
                        at_seg2_endpoint = geom.distance(seg2_start) < epsilon or geom.distance(seg2_end) < epsilon
                        
                        if not (at_seg1_endpoint and at_seg2_endpoint):
                            return True
    
    return False


def compute_shared_boundary_length(geom1: Union[Polygon, MultiPolygon], geom2: Union[Polygon, MultiPolygon], epsilon: float) -> float:
    """
    Compute the length of shared boundary between two geometries.
    Returns the total length of boundary intersection if > epsilon, else 0.
    """
    try:
        boundary1 = geom1.boundary
        boundary2 = geom2.boundary
        shared_boundary = boundary1.intersection(boundary2)
        
        if shared_boundary.is_empty:
            return 0.0
        
        length = 0.0
        if isinstance(shared_boundary, LineString):
            length = shared_boundary.length
        elif isinstance(shared_boundary, MultiLineString):
            length = sum(geom.length for geom in shared_boundary.geoms)
        elif hasattr(shared_boundary, 'geoms'):
            # GeometryCollection - sum lengths of LineString components
            for geom in shared_boundary.geoms:
                if isinstance(geom, LineString):
                    length += geom.length
                elif isinstance(geom, MultiLineString):
                    length += sum(g.length for g in geom.geoms)
        
        return length if length > epsilon else 0.0
    except Exception:
        # If computation fails, return 0 (not adjacent by this criterion)
        return 0.0


def compute_adjacency(polygons: Dict[str, Union[Polygon, MultiPolygon]], progress_interval: int = 200) -> Tuple[Set[Tuple[str, str]], Dict[Tuple[str, str], str]]:
    """
    Compute adjacency edges using spatial indexing with STRtree and prepared geometries.
    Supports both Polygon and MultiPolygon geometries.
    
    Two settlements are adjacent if ANY of the following holds:
    a) g_i.touches(g_j)
    b) g_i.intersects(g_j) AND shared boundary length > EPSILON
    c) g_i.distance(g_j) <= GAP_TOLERANCE
    
    Returns:
        - Set of (sid1, sid2) tuples with sid1 < sid2 (stable ordering)
        - Dict mapping (sid1, sid2) -> source method ('touch', 'line', 'distance')
    """
    print(f"Computing adjacency for {len(polygons)} geometries...")
    print(f"  EPSILON: {EPSILON}, GAP_TOLERANCE: {GAP_TOLERANCE}")
    
    # Build spatial index using STRtree
    print("Building spatial index...")
    sids = list(polygons.keys())
    geoms = [polygons[sid] for sid in sids]
    tree = STRtree(geoms)
    
    edges = set()
    edge_sources = {}  # Track which method found each edge
    edge_breakdown = {"touch": 0, "line": 0, "distance": 0}
    start_time = time.time()
    
    print("Finding adjacent pairs...")
    for i, sid1 in enumerate(sids):
        if i > 0 and i % progress_interval == 0:
            elapsed = time.time() - start_time
            print(f"  [{i}/{len(sids)}] {elapsed:.1f}s elapsed, {len(edges)} edges found, current: {sid1}")
        
        geom1 = polygons[sid1]
        
        # Prepare geometry for repeated checks
        prep_geom1 = prep(geom1)
        
        # Query STRtree for candidates using g_i.envelope buffered by GAP_TOLERANCE
        expanded_bbox = (
            geom1.bounds[0] - GAP_TOLERANCE,
            geom1.bounds[1] - GAP_TOLERANCE,
            geom1.bounds[2] + GAP_TOLERANCE,
            geom1.bounds[3] + GAP_TOLERANCE
        )
        expanded_geom = box(*expanded_bbox)
        candidates = tree.query(expanded_geom)
        
        for candidate_idx in candidates:
            sid2 = sids[candidate_idx]
            
            # Skip self and already processed pairs (stable ordering: sid1 < sid2)
            if sid1 >= sid2:
                continue
            
            geom2 = polygons[sid2]
            
            # Normalize edge ordering to (minSid, maxSid)
            edge = (sid1, sid2) if sid1 < sid2 else (sid2, sid1)
            
            # Skip if already found
            if edge in edges:
                continue
            
            # Check adjacency criteria in order:
            # 1. touches() - use prepared geometry for efficiency
            if prep_geom1.touches(geom2):
                edges.add(edge)
                edge_sources[edge] = 'touch'
                edge_breakdown['touch'] += 1
                continue
            
            # 2. intersects() AND shared boundary length > EPSILON
            if prep_geom1.intersects(geom2):
                shared_length = compute_shared_boundary_length(geom1, geom2, EPSILON)
                if shared_length > EPSILON:
                    edges.add(edge)
                    edge_sources[edge] = 'line'
                    edge_breakdown['line'] += 1
                    continue
            
            # 3. distance() <= GAP_TOLERANCE (only if not already adjacent)
            # Only compute distance if not already adjacent by touch/intersect
            # Quick bbox distance check first to avoid expensive geometry distance computation
            bbox1 = geom1.bounds
            bbox2 = geom2.bounds
            
            # Check if bboxes overlap or are close enough
            bboxes_overlap = not (bbox1[2] < bbox2[0] or bbox2[2] < bbox1[0] or
                                  bbox1[3] < bbox2[1] or bbox2[3] < bbox1[1])
            
            if bboxes_overlap:
                # Bboxes overlap - check geometry distance
                distance = geom1.distance(geom2)
                if distance <= GAP_TOLERANCE:
                    edges.add(edge)
                    edge_sources[edge] = 'distance'
                    edge_breakdown['distance'] += 1
            else:
                # Bboxes don't overlap - calculate minimum bbox-to-bbox distance
                h_dist = max(bbox2[0] - bbox1[2], bbox1[0] - bbox2[2])
                v_dist = max(bbox2[1] - bbox1[3], bbox1[1] - bbox2[3])
                min_bbox_dist = max(h_dist, v_dist)  # L-infinity norm
                
                # Only compute actual geometry distance if bbox distance is within tolerance
                if min_bbox_dist <= GAP_TOLERANCE:
                    distance = geom1.distance(geom2)
                    if distance <= GAP_TOLERANCE:
                        edges.add(edge)
                        edge_sources[edge] = 'distance'
                        edge_breakdown['distance'] += 1
    
    elapsed = time.time() - start_time
    print(f"  [{len(sids)}/{len(sids)}] Adjacency computation complete in {elapsed:.1f}s")
    print(f"  Total edges: {len(edges)}")
    print(f"  Edge breakdown: touch={edge_breakdown['touch']}, line={edge_breakdown['line']}, distance={edge_breakdown['distance']}")
    
    return edges, edge_sources


def generate_report(edges: Set[Tuple[str, str]], all_sids: Set[str], edge_sources: Dict[Tuple[str, str], str] = None, invalid_geometry_count: int = 0, edges_sha256: str = None, incomplete: bool = False) -> dict:
    """
    Generate adjacency report statistics.
    
    Args:
        edges: Set of adjacency edges
        all_sids: Set of all settlement IDs
        edge_sources: Dict mapping edges to their detection method
        invalid_geometry_count: Number of invalid geometries skipped
        edges_sha256: SHA256 hash of edges JSON
        incomplete: True if report is incomplete (e.g., due to timeout/exception)
    
    Returns:
        Dictionary with report data including self-identification fields
    """
    # Calculate degrees
    degree_map = {sid: 0 for sid in all_sids}
    for sid1, sid2 in edges:
        degree_map[sid1] += 1
        degree_map[sid2] += 1
    
    degrees = list(degree_map.values())
    total_degree = sum(degrees)
    avg_degree = total_degree / len(degrees) if degrees else 0
    orphan_count = sum(1 for d in degrees if d == 0)
    max_degree = max(degrees) if degrees else 0
    
    # Top degree sids
    top_degree_sids = sorted(
        [(sid, degree) for sid, degree in degree_map.items()],
        key=lambda x: x[1],
        reverse=True
    )[:10]
    
    # Count edges by source method - ALWAYS include edge_breakdown
    edge_breakdown = {
        "line": 0,
        "touch": 0,
        "distance": 0
    }
    if edge_sources:
        for edge in edges:
            source = edge_sources.get(edge, 'unknown')
            if source in edge_breakdown:
                edge_breakdown[source] += 1
    # edge_breakdown is always included with zeros if no edges found
    
    # Get git commit if available
    git_commit = get_git_commit()
    
    # Build report with self-identification fields
    report = {
        "version": "1.0.0",
        "script_version": SCRIPT_VERSION,
        "total_edges": len(edges),
        "avg_degree": round(avg_degree, 2),
        "orphan_count": orphan_count,
        "max_degree": max_degree,
        "top_degree_sids": [{"sid": sid, "degree": degree} for sid, degree in top_degree_sids],
        "invalid_geometry_count": invalid_geometry_count,
        "edge_breakdown": edge_breakdown
    }
    
    # Add optional fields
    if git_commit:
        report["git_commit"] = git_commit
    
    if edges_sha256:
        report["settlement_edges_sha256"] = edges_sha256
    
    if incomplete:
        report["incomplete"] = True
    
    return report


def get_orphans(edges: Set[Tuple[str, str]], all_sids: Set[str]) -> List[str]:
    """Get list of orphan settlement IDs (degree 0)."""
    degree_map = {sid: 0 for sid in all_sids}
    for sid1, sid2 in edges:
        degree_map[sid1] += 1
        degree_map[sid2] += 1
    
    return sorted([sid for sid, degree in degree_map.items() if degree == 0])


def calibrate_gap_tolerance(polygons: Dict[str, Union[Polygon, MultiPolygon]], sample_size: int = 500) -> dict:
    """
    Calibrate GAP_TOLERANCE by analyzing distances between settlement boundaries.
    
    For each sampled settlement, finds the nearest other settlement boundary
    and computes distance quantiles to suggest an appropriate GAP_TOLERANCE.
    
    Args:
        polygons: Dictionary of settlement ID -> geometry
        sample_size: Maximum number of settlements to sample (or all if smaller)
    
    Returns:
        Dictionary with quantiles and suggested_gap_tolerance
    """
    print(f"Calibrating GAP_TOLERANCE using up to {sample_size} samples...")
    
    sids = list(polygons.keys())
    if len(sids) == 0:
        print("ERROR: No geometries available for calibration", file=sys.stderr)
        return {}
    
    # Sample up to sample_size settlements (or all if fewer)
    actual_sample_size = min(sample_size, len(sids))
    if actual_sample_size < len(sids):
        # Simple sampling: take every Nth settlement
        step = len(sids) / actual_sample_size
        sample_indices = [int(i * step) for i in range(actual_sample_size)]
        sample_sids = [sids[i] for i in sample_indices]
    else:
        sample_sids = sids
    
    print(f"Sampling {len(sample_sids)} settlements from {len(sids)} total...")
    
    # Build spatial index
    print("Building spatial index...")
    all_geoms = [polygons[sid] for sid in sids]
    tree = STRtree(all_geoms)
    
    distances = []
    start_time = time.time()
    progress_interval = max(1, len(sample_sids) // 20)
    
    print("Computing minimum distances to nearest neighbors...")
    for i, sid1 in enumerate(sample_sids):
        if i > 0 and i % progress_interval == 0:
            elapsed = time.time() - start_time
            rate = i / elapsed if elapsed > 0 else 0
            print(f"  [{i}/{len(sample_sids)}] {elapsed:.1f}s elapsed, ~{rate:.1f} samples/s")
        
        geom1 = polygons[sid1]
        
        # Find nearest neighbor by progressively expanding search radius
        # Start with a small bbox expansion and increase if needed
        min_distance = float('inf')
        search_radius = 100.0  # Start with a reasonable search radius
        max_search_radius = 10000.0  # Maximum search radius
        
        # Progressive bbox expansion strategy
        for radius_multiplier in [0.5, 1.0, 2.0, 5.0, 10.0, 20.0]:
            search_bbox = (
                geom1.bounds[0] - search_radius * radius_multiplier,
                geom1.bounds[1] - search_radius * radius_multiplier,
                geom1.bounds[2] + search_radius * radius_multiplier,
                geom1.bounds[3] + search_radius * radius_multiplier
            )
            expanded_geom = box(*search_bbox)
            candidates = tree.query(expanded_geom)
            
            # Check distance to all candidates (excluding self)
            found_candidate = False
            for candidate_idx in candidates:
                sid2 = sids[candidate_idx]
                if sid1 == sid2:
                    continue
                
                geom2 = polygons[sid2]
                distance = geom1.distance(geom2)
                if distance < min_distance:
                    min_distance = distance
                    found_candidate = True
            
            # If we found candidates and min_distance is within search radius, we're done
            if found_candidate and min_distance <= search_radius * radius_multiplier * 0.5:
                break
            
            # Avoid infinite loop
            if search_radius * radius_multiplier > max_search_radius:
                break
        
        # If we didn't find any neighbors, try a direct nearest neighbor query
        # by checking a few more candidates or use a fallback
        if min_distance == float('inf'):
            # Fallback: use a large search radius
            fallback_bbox = (
                geom1.bounds[0] - max_search_radius,
                geom1.bounds[1] - max_search_radius,
                geom1.bounds[2] + max_search_radius,
                geom1.bounds[3] + max_search_radius
            )
            fallback_geom = box(*fallback_bbox)
            candidates = tree.query(fallback_geom)
            
            for candidate_idx in candidates:
                sid2 = sids[candidate_idx]
                if sid1 == sid2:
                    continue
                geom2 = polygons[sid2]
                distance = geom1.distance(geom2)
                if distance < min_distance:
                    min_distance = distance
        
        if min_distance != float('inf'):
            distances.append(min_distance)
    
    if not distances:
        print("WARNING: No distances found during calibration", file=sys.stderr)
        return {
            "sample_size": len(sample_sids),
            "distances_found": 0,
            "error": "No valid distances computed"
        }
    
    # Calculate quantiles
    distances_sorted = sorted(distances)
    n = len(distances_sorted)
    
    def quantile(p: float) -> float:
        """Calculate p-th quantile (0.0 to 1.0)."""
        index = p * (n - 1)
        lower = int(math.floor(index))
        upper = int(math.ceil(index))
        if lower == upper:
            return distances_sorted[lower]
        weight = index - lower
        return distances_sorted[lower] * (1 - weight) + distances_sorted[upper] * weight
    
    quantiles = {
        "min": distances_sorted[0],
        "p10": quantile(0.10),
        "p25": quantile(0.25),
        "p50": quantile(0.50),
        "p75": quantile(0.75),
        "p90": quantile(0.90),
        "p95": quantile(0.95),
        "p99": quantile(0.99),
        "max": distances_sorted[-1]
    }
    
    # Suggest gap tolerance as p95, rounded to a sensible value
    p95_value = quantiles["p95"]
    # Round to 2 significant figures
    if p95_value > 0:
        magnitude = 10 ** math.floor(math.log10(abs(p95_value)))
        suggested_gap_tolerance = round(p95_value / magnitude) * magnitude
    else:
        suggested_gap_tolerance = p95_value
    
    # Alternative: also suggest p90
    p90_value = quantiles["p90"]
    if p90_value > 0:
        magnitude = 10 ** math.floor(math.log10(abs(p90_value)))
        suggested_gap_tolerance_p90 = round(p90_value / magnitude) * magnitude
    else:
        suggested_gap_tolerance_p90 = p90_value
    
    elapsed = time.time() - start_time
    print(f"Calibration complete in {elapsed:.1f}s")
    print(f"  Found {len(distances)} valid distances")
    print(f"  Distance range: {quantiles['min']:.4f} to {quantiles['max']:.4f}")
    print(f"  p95: {quantiles['p95']:.4f}")
    print(f"  Suggested GAP_TOLERANCE (p95): {suggested_gap_tolerance:.4f}")
    print(f"  Suggested GAP_TOLERANCE (p90): {suggested_gap_tolerance_p90:.4f}")
    
    return {
        "sample_size": len(sample_sids),
        "distances_found": len(distances),
        "quantiles": quantiles,
        "suggested_gap_tolerance": suggested_gap_tolerance,
        "suggested_gap_tolerance_p90": suggested_gap_tolerance_p90,
        "current_gap_tolerance": GAP_TOLERANCE,
        "calibration_complete": True
    }


def main() -> Path:
    """
    Main entry point.
    Returns the report_path for exception handling.
    """
    parser = argparse.ArgumentParser(description="Generate settlement adjacency edges or calibrate GAP_TOLERANCE")
    parser.add_argument(
        "--calibrate",
        action="store_true",
        help="Run calibration mode to suggest GAP_TOLERANCE"
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=500,
        help="Number of settlements to sample for calibration (default: 500)"
    )
    parser.add_argument(
        "derived_dir",
        nargs="?",
        help="Path to data/derived directory (optional)"
    )
    
    args = parser.parse_args()
    
    if args.derived_dir:
        derived_dir = Path(args.derived_dir)
    else:
        # Resolve path relative to script location
        script_dir = Path(__file__).resolve().parent
        derived_dir = script_dir.parent.parent / "data" / "derived"
    
    polygons_path = derived_dir / "settlements_polygons.geojson"
    edges_path = derived_dir / "settlement_edges.json"
    report_path = derived_dir / "adjacency_report.json"
    orphans_path = derived_dir / "orphans.json"
    whitelist_path = derived_dir / "orphan_whitelist.json"
    calibration_path = derived_dir / "adjacency_calibration.json"
    
    if not polygons_path.exists():
        print(f"ERROR: {polygons_path} not found", file=sys.stderr)
        sys.exit(1)
    
    print(f"Loading geometries from {polygons_path}...")
    polygons, properties, invalid_geometry_count = load_polygons(polygons_path)
    
    if not polygons:
        print("ERROR: No valid geometries found", file=sys.stderr)
        sys.exit(1)
    
    print(f"Loaded {len(polygons)} geometries")
    if invalid_geometry_count > 0:
        print(f"WARNING: Skipped {invalid_geometry_count} invalid geometry feature(s)", file=sys.stderr)
    
    # Handle calibration mode
    if args.calibrate:
        calibration_data = calibrate_gap_tolerance(polygons, args.sample_size)
        calibration_json = {
            "version": "1.0.0",
            **calibration_data
        }
        
        print(f"Writing calibration data to {calibration_path}...")
        with open(calibration_path, 'w', encoding='utf-8') as f:
            json.dump(calibration_json, f, indent=2, ensure_ascii=False)
        
        print("\nCalibration complete!")
        if calibration_data.get("calibration_complete"):
            suggested = calibration_data.get("suggested_gap_tolerance", GAP_TOLERANCE)
            current = calibration_data.get("current_gap_tolerance", GAP_TOLERANCE)
            if suggested > current * 2:
                print(f"\nWARNING: Suggested GAP_TOLERANCE ({suggested:.4f}) is much larger than current ({current:.4f})", file=sys.stderr)
                print(f"  Consider reviewing the current GAP_TOLERANCE setting", file=sys.stderr)
        
        return report_path
    
    # Check for calibration data and warn if GAP_TOLERANCE might be suboptimal
    calibration_warning_shown = False
    if calibration_path.exists():
        try:
            with open(calibration_path, 'r', encoding='utf-8') as f:
                calibration_data = json.load(f)
                if calibration_data.get("calibration_complete"):
                    suggested = calibration_data.get("suggested_gap_tolerance", None)
                    if suggested is not None and suggested > GAP_TOLERANCE * 2:
                        print(f"\nWARNING: Calibration suggests GAP_TOLERANCE={suggested:.4f}, but current is {GAP_TOLERANCE:.4f}", file=sys.stderr)
                        print(f"  Current value may be too low. Consider running --calibrate to update.", file=sys.stderr)
                        calibration_warning_shown = True
        except Exception as e:
            # Ignore calibration file errors during normal run
            pass
    
    # Compute adjacency
    edges, edge_sources = compute_adjacency(polygons, progress_interval=200)
    
    # Normalize edges to (minSid, maxSid) and sort lexicographically
    # (edges are already normalized in compute_adjacency, but ensure sorted order)
    edges_list = [{"a": sid1, "b": sid2} for sid1, sid2 in sorted(edges)]
    edges_json = {
        "version": "1.0.0",
        "allow_self_loops_default": False,
        "edges": edges_list
    }
    
    # Write edges file and calculate SHA256 checksum
    print(f"Writing {len(edges_list)} edges to {edges_path}...")
    edges_json_str = json.dumps(edges_json, indent=2, ensure_ascii=False, sort_keys=True)
    edges_sha256 = hashlib.sha256(edges_json_str.encode('utf-8')).hexdigest()
    
    with open(edges_path, 'w', encoding='utf-8') as f:
        f.write(edges_json_str)
    
    # Generate report with checksum and invalid geometry count
    # edge_sources should always be provided, but ensure edge_breakdown is always present
    report = generate_report(edges, set(polygons.keys()), edge_sources, invalid_geometry_count, edges_sha256)
    
    # Ensure edge_breakdown is always present (should already be, but double-check)
    if "edge_breakdown" not in report:
        report["edge_breakdown"] = {"line": 0, "touch": 0, "distance": 0}
    
    # Get orphans list
    orphans = get_orphans(edges, set(polygons.keys()))
    
    # Write orphans.json if any exist
    if orphans:
        # Build orphans list with mun_code and mun from properties
        orphans_with_metadata = []
        for sid in orphans:
            orphan_props = properties.get(sid, {})
            orphan_entry = {
                "sid": sid,
                "mun_code": orphan_props.get("mun_code", ""),
                "mun": orphan_props.get("mun", "")
            }
            orphans_with_metadata.append(orphan_entry)
        
        orphans_json = {
            "version": "1.0.0",
            "orphan_count": len(orphans),
            "orphans": orphans_with_metadata
        }
        print(f"Writing {len(orphans)} orphans to {orphans_path}...")
        with open(orphans_path, 'w', encoding='utf-8') as f:
            json.dump(orphans_json, f, indent=2, ensure_ascii=False)
    else:
        # Remove orphans.json if it exists and there are no orphans
        if orphans_path.exists():
            orphans_path.unlink()
    
    # Write adjacency report
    print(f"Writing adjacency report to {report_path}...")
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    
    # Print self-identification confirmation
    total_edges = report['total_edges']
    orphan_count = report['orphan_count']
    print(f"WROTE adjacency_report.json at {report_path}, total_edges={total_edges}, orphan_count={orphan_count}")
    
    print(f"\nAdjacency generation complete:")
    print(f"  Total edges: {len(edges_list)}")
    print(f"  Average degree: {report['avg_degree']:.2f}")
    print(f"  Orphan settlements: {report['orphan_count']}")
    print(f"  Max degree: {report['max_degree']}")
    if 'edge_breakdown' in report:
        breakdown = report['edge_breakdown']
        print(f"  Edge breakdown:")
        print(f"    Line segments: {breakdown['line']}")
        print(f"    Touches: {breakdown['touch']}")
        print(f"    Distance-based: {breakdown['distance']}")
    
    # Quality gates
    exit_code = 0
    
    # Gate 1: total_edges == 0 must fail
    if report['total_edges'] == 0:
        print("\nERROR: Quality gate failed - total_edges == 0", file=sys.stderr)
        exit_code = 1
    
    # Gate 2: orphan_count > 0 must fail unless all are whitelisted
    if report['orphan_count'] > 0:
        whitelisted_sids = set()
        if whitelist_path.exists():
            try:
                with open(whitelist_path, 'r', encoding='utf-8') as f:
                    whitelist_data = json.load(f)
                    # Support multiple formats:
                    # - Array format: ["sid1", "sid2"]
                    # - Object with "orphans" key: {"orphans": ["sid1", "sid2"]}
                    # - Object with "sids" key: {"sids": ["sid1", "sid2"]}
                    if isinstance(whitelist_data, list):
                        whitelisted_sids = set(whitelist_data)
                    elif isinstance(whitelist_data, dict):
                        # Try "orphans" first (preferred), then "sids" (alternative)
                        whitelisted_sids = set(whitelist_data.get('orphans', whitelist_data.get('sids', [])))
                    else:
                        print(f"WARNING: Invalid orphan whitelist format (expected array or object)", file=sys.stderr)
            except Exception as e:
                print(f"WARNING: Failed to load orphan whitelist: {e}", file=sys.stderr)
        
        non_whitelisted_orphans = [sid for sid in orphans if sid not in whitelisted_sids]
        if non_whitelisted_orphans:
            print(f"\nERROR: Quality gate failed - {len(non_whitelisted_orphans)} orphan settlement(s) not whitelisted", file=sys.stderr)
            print(f"  Non-whitelisted orphans: {', '.join(non_whitelisted_orphans[:10])}", file=sys.stderr)
            if len(non_whitelisted_orphans) > 10:
                print(f"  ... and {len(non_whitelisted_orphans) - 10} more", file=sys.stderr)
            exit_code = 1
    
    # Gate 3: invalid_geometry_count > 0 must fail unless whitelisted
    # (matching current quality gates approach for other counts)
    if report['invalid_geometry_count'] > 0:
        print(f"\nERROR: Quality gate failed - {report['invalid_geometry_count']} invalid geometry feature(s) skipped", file=sys.stderr)
        exit_code = 1
    
    if exit_code != 0:
        sys.exit(exit_code)
    
    return report_path


if __name__ == "__main__":
    report_path = None
    
    try:
        # Run main function - it returns report_path
        report_path = main()
        
    except KeyboardInterrupt:
        print("\nERROR: Interrupted by user", file=sys.stderr)
        if report_path and report_path.exists():
            # Mark existing report as incomplete if it exists
            try:
                with open(report_path, 'r', encoding='utf-8') as f:
                    report = json.load(f)
                report['incomplete'] = True
                report['script_version'] = SCRIPT_VERSION
                # Ensure edge_breakdown exists
                if 'edge_breakdown' not in report:
                    report['edge_breakdown'] = {"line": 0, "touch": 0, "distance": 0}
                with open(report_path, 'w', encoding='utf-8') as f:
                    json.dump(report, f, indent=2, ensure_ascii=False)
            except Exception:
                pass
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        
        # If report was partially written, mark it as incomplete
        if report_path and report_path.exists():
            try:
                with open(report_path, 'r', encoding='utf-8') as f:
                    report = json.load(f)
                # Only mark as incomplete if it doesn't already have incomplete flag
                if not report.get('incomplete', False):
                    report['incomplete'] = True
                    report['script_version'] = SCRIPT_VERSION
                    # Ensure edge_breakdown exists
                    if 'edge_breakdown' not in report:
                        report['edge_breakdown'] = {"line": 0, "touch": 0, "distance": 0}
                    with open(report_path, 'w', encoding='utf-8') as f:
                        json.dump(report, f, indent=2, ensure_ascii=False)
            except Exception:
                pass
        
        # If no report was written and we're not in calibrate mode, don't write one
        # (per requirement: "do NOT write adjacency_report.json unless it is clearly marked incomplete")
        sys.exit(1)
