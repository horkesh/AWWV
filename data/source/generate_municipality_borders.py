#!/usr/bin/env python3
"""
Generate Municipality Borders from Settlement Points

This script takes settlement GeoJSON data (points) and generates
municipality boundary polygons using concave hull (alpha shapes).
"""

import json
import sys
from collections import defaultdict
from shapely.geometry import Point, MultiPoint, shape, mapping
from shapely.ops import unary_union
import alphashape

def load_settlements(geojson_file):
    """Load settlement GeoJSON and group by municipality"""
    with open(geojson_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    settlements_by_muni = defaultdict(list)
    
    for feature in data['features']:
        props = feature['properties']
        geom = shape(feature['geometry'])
        
        # Adjust these field names to match your GeoJSON structure
        municipality_name = props.get('municipality') or props.get('municipalityName')
        
        if municipality_name and geom.geom_type == 'Point':
            settlements_by_muni[municipality_name].append(geom)
    
    return settlements_by_muni

def create_municipality_polygons(settlements_by_muni, alpha=0.0):
    """
    Create municipality boundary polygons using concave hull
    
    Args:
        settlements_by_muni: Dict mapping municipality names to list of Point geometries
        alpha: Alpha parameter for concave hull (0 = convex hull, higher = more concave)
               Recommended: start with 0.05 and adjust
    
    Returns:
        Dict mapping municipality names to Polygon/MultiPolygon geometries
    """
    municipality_polygons = {}
    
    for muni_name, points in settlements_by_muni.items():
        if len(points) < 3:
            print(f"Warning: {muni_name} has only {len(points)} settlement(s), skipping")
            continue
        
        # Create MultiPoint from all settlement points
        multi_point = MultiPoint(points)
        
        # Generate concave hull using alpha shapes
        # alpha=0 gives convex hull, higher values give more concave boundaries
        try:
            if alpha == 0:
                # Use convex hull for simple case
                polygon = multi_point.convex_hull
            else:
                # Use alpha shape for concave hull
                polygon = alphashape.alphashape(points, alpha)
            
            municipality_polygons[muni_name] = polygon
            print(f"✓ Created polygon for {muni_name} ({len(points)} settlements)")
        
        except Exception as e:
            print(f"✗ Error creating polygon for {muni_name}: {e}")
            # Fallback to convex hull
            polygon = multi_point.convex_hull
            municipality_polygons[muni_name] = polygon
            print(f"  → Using convex hull as fallback")
    
    return municipality_polygons

def save_municipality_borders(municipality_polygons, output_file):
    """Save municipality polygons as GeoJSON"""
    features = []
    
    for muni_name, polygon in municipality_polygons.items():
        feature = {
            'type': 'Feature',
            'properties': {
                'name': muni_name,
                'municipality': muni_name
            },
            'geometry': mapping(polygon)
        }
        features.append(feature)
    
    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)
    
    print(f"\n✓ Saved {len(features)} municipality borders to {output_file}")

def main():
    """Main execution"""
    if len(sys.argv) < 3:
        print("Usage: python generate_municipality_borders.py <settlements.geojson> <output.geojson> [alpha]")
        print("\nAlpha parameter (optional):")
        print("  0.0  = Convex hull (straight lines, simpler)")
        print("  0.05 = Moderately concave (recommended start)")
        print("  0.1  = More concave (follows settlement clusters closely)")
        print("  0.2  = Very concave (may create holes)")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    alpha = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05
    
    print(f"Loading settlements from {input_file}...")
    settlements_by_muni = load_settlements(input_file)
    print(f"Found {len(settlements_by_muni)} municipalities")
    
    print(f"\nGenerating municipality borders (alpha={alpha})...")
    municipality_polygons = create_municipality_polygons(settlements_by_muni, alpha)
    
    print(f"\nSaving to {output_file}...")
    save_municipality_borders(municipality_polygons, output_file)
    
    print("\n✓ Done!")
    print(f"\nGenerated borders for {len(municipality_polygons)} municipalities")

if __name__ == '__main__':
    main()
