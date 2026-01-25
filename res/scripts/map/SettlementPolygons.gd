extends RefCounted
class_name SettlementPolygons

## Loads settlement polygons from GeoJSON and provides lookup by sid and mid

var polygons_by_sid: Dictionary = {}  # sid -> PackedVector2Array
var settlements_by_mid: Dictionary = {}  # mid -> Array[sid]

## Load polygons from GeoJSON file
func load_polygons() -> bool:
	var file_path = "res://data/derived/settlements_polygons.geojson"
	var file = FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		push_error("Failed to open settlements_polygons.geojson")
		return false
	
	var json = JSON.new()
	var parse_result = json.parse(file.get_as_text())
	file.close()
	
	if parse_result != OK:
		push_error("Failed to parse settlements_polygons.geojson: " + json.get_error_message())
		return false
	
	var data = json.data
	if not data is Dictionary or data.get("type") != "FeatureCollection":
		push_error("settlements_polygons.geojson is not a FeatureCollection")
		return false
	
	var features = data.get("features", [])
	if not features is Array:
		push_error("Features is not an array")
		return false
	
	# Process each feature
	for feature in features:
		if not feature is Dictionary:
			continue
		
		var properties = feature.get("properties", {})
		var geometry = feature.get("geometry", {})
		
		if not properties is Dictionary or not geometry is Dictionary:
			continue
		
		var sid = properties.get("sid", "")
		var mid = properties.get("mid", "")
		
		if sid.is_empty() or mid.is_empty():
			continue
		
		# Extract polygon coordinates
		var coords = geometry.get("coordinates", [])
		if not coords is Array or coords.is_empty():
			continue
		
		# GeoJSON Polygon: [[[x,y], [x,y], ...]] - first ring is exterior
		var ring = coords[0]
		if not ring is Array or ring.size() < 3:
			continue
		
		# Convert to PackedVector2Array
		var points = PackedVector2Array()
		for point in ring:
			if point is Array and point.size() >= 2:
				points.append(Vector2(point[0], point[1]))
		
		if points.size() < 3:
			continue
		
		# Store polygon
		polygons_by_sid[sid] = points
		
		# Add to municipality index
		if not settlements_by_mid.has(mid):
			settlements_by_mid[mid] = []
		settlements_by_mid[mid].append(sid)
	
	return true

## Get polygon for a settlement ID
func get_polygon(sid: String) -> PackedVector2Array:
	return polygons_by_sid.get(sid, PackedVector2Array())

## Get all settlement IDs in a municipality
func get_settlement_ids(mid: String) -> Array:
	return settlements_by_mid.get(mid, [])

## Check if settlement has geometry
func has_polygon(sid: String) -> bool:
	return polygons_by_sid.has(sid)
