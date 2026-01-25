#!/usr/bin/env python3
"""
Simple Municipality Border Generator (Convex Hull Method)

Uses only shapely - no additional dependencies needed.
Creates convex hull boundaries around settlement clusters.
"""

import json
import sys
from collections import defaultdict
from shapely.geometry import Point, MultiPoint, shape, mapping, Polygon
from shapely.ops import unary_union

def load_settlements(geojson_file):
    """Load settlement GeoJSON and group by municipality"""
    with open(geojson_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    settlements_by_muni = defaultdict(list)
    
    for feature in data['features']:
        props = feature['properties']
        geom = shape(feature['geometry'])
        
        # Try different possible field names for municipality
        municipality_name = (
            props.get('municipality') or 
            props.get('municipalityName') or
            props.get('muni_name') or
            props.get('MUNICIPALITY')
        )
        
        if municipality_name and geom.geom_type == 'Point':
            coord = (geom.x, geom.y)
            settlements_by_muni[municipality_name].append(coord)
    
    return settlements_by_muni

def create_buffered_convex_hull(points, buffer_distance=0.01):
    """
    Create a convex hull with buffer for more natural boundaries
    
    Args:
        points: List of (x, y) tuples
        buffer_distance: Distance to buffer outward (in degrees, ~1.1km per 0.01°)
    """
    if len(points) < 3:
        return None
    
    # Create points
    shapely_points = [Point(x, y) for x, y in points]
    multi_point = MultiPoint(shapely_points)
    
    # Create convex hull
    hull = multi_point.convex_hull
    
    # Buffer it slightly to create more natural boundaries
    if buffer_distance > 0:
        hull = hull.buffer(buffer_distance)
    
    return hull

def create_voronoi_style_borders(settlements_by_muni, buffer_distance=0.015):
    """
    Create municipality borders using buffered convex hulls
    
    This creates reasonably natural-looking boundaries without complex dependencies
    """
    municipality_polygons = {}
    
    print(f"\nCreating borders (buffer={buffer_distance}°)...")
    
    for muni_name, points in settlements_by_muni.items():
        if len(points) < 3:
            print(f"⚠  {muni_name}: only {len(points)} settlement(s), need at least 3")
            continue
        
        polygon = create_buffered_convex_hull(points, buffer_distance)
        
        if polygon:
            municipality_polygons[muni_name] = polygon
            print(f"✓ {muni_name}: {len(points)} settlements → polygon created")
        else:
            print(f"✗ {muni_name}: failed to create polygon")
    
    return municipality_polygons

def save_geojson(municipality_polygons, output_file, include_stats=True):
    """Save municipality polygons as GeoJSON with optional statistics"""
    features = []
    
    for muni_name, polygon in municipality_polygons.items():
        props = {
            'name': muni_name,
            'municipality': muni_name
        }
        
        if include_stats:
            props['area_sq_km'] = polygon.area * 111 * 111  # Rough conversion to km²
            props['perimeter_km'] = polygon.length * 111     # Rough conversion to km
        
        feature = {
            'type': 'Feature',
            'properties': props,
            'geometry': mapping(polygon)
        }
        features.append(feature)
    
    # Sort features by name for consistency
    features.sort(key=lambda f: f['properties']['name'])
    
    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)
    
    print(f"\n✓ Saved {len(features)} municipality borders to {output_file}")

def create_validation_report(settlements_by_muni, municipality_polygons):
    """Print validation report"""
    print("\n" + "="*60)
    print("VALIDATION REPORT")
    print("="*60)
    
    total_municipalities = len(settlements_by_muni)
    successful = len(municipality_polygons)
    failed = total_municipalities - successful
    
    print(f"Total municipalities: {total_municipalities}")
    print(f"Successfully created: {successful}")
    print(f"Failed:               {failed}")
    
    if failed > 0:
        print("\nMunicipalities that failed (< 3 settlements):")
        for muni_name, points in settlements_by_muni.items():
            if muni_name not in municipality_polygons:
                print(f"  - {muni_name}: {len(points)} settlement(s)")
    
    print("="*60)

def main():
    if len(sys.argv) < 3:
        print("=" * 70)
        print("MUNICIPALITY BORDER GENERATOR (Simple Convex Hull Method)")
        print("=" * 70)
        print("\nUsage:")
        print("  python simple_municipality_borders.py <input.geojson> <output.geojson> [buffer]")
        print("\nArguments:")
        print("  input.geojson  : Settlement points GeoJSON file")
        print("  output.geojson : Output municipality borders GeoJSON file")
        print("  buffer         : Optional buffer distance in degrees (default: 0.015)")
        print("\nBuffer examples:")
        print("  0.00  = No buffer (tight hull)")
        print("  0.01  = ~1.1 km buffer")
        print("  0.015 = ~1.6 km buffer (recommended)")
        print("  0.02  = ~2.2 km buffer")
        print("=" * 70)
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    buffer_distance = float(sys.argv[3]) if len(sys.argv) > 3 else 0.015
    
    print(f"Loading settlements from: {input_file}")
    settlements_by_muni = load_settlements(input_file)
    print(f"Found {len(settlements_by_muni)} municipalities")
    
    # Count total settlements
    total_settlements = sum(len(points) for points in settlements_by_muni.values())
    print(f"Total settlements: {total_settlements}")
    
    municipality_polygons = create_voronoi_style_borders(settlements_by_muni, buffer_distance)
    
    save_geojson(municipality_polygons, output_file)
    create_validation_report(settlements_by_muni, municipality_polygons)
    
    print(f"\n✓ Done! Check {output_file}")

if __name__ == '__main__':
    main()
