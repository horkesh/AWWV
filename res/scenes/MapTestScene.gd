extends Node2D
class_name MapTestScene

## Minimal test scene for map rendering
## Attach this script to a Node2D in your scene tree

@onready var map_layer: MapLayer = $MapLayer

var map_data: MapData
var settlement_polygons: SettlementPolygons

func _ready():
	print("MapTestScene: Initializing...")
	
	# Create map data loader
	map_data = MapData.new()
	if not map_data.load_data():
		push_error("Failed to load map data")
		return
	
	print("MapTestScene: Loaded %d municipalities, %d settlements" % [
		map_data.municipalities_meta.size(),
		map_data.settlements_meta.size()
	])
	
	# Create settlement polygons loader
	settlement_polygons = SettlementPolygons.new()
	if not settlement_polygons.load_polygons():
		push_error("Failed to load settlement polygons")
		return
	
	print("MapTestScene: Loaded %d settlement polygons" % settlement_polygons.polygons_by_sid.size())
	
	# Connect map layer if it exists
	if map_layer:
		map_layer.map_data = map_data
		map_layer.settlement_polygons = settlement_polygons
		map_layer.settlement_selected.connect(_on_settlement_selected)
		map_layer.settlement_hovered.connect(_on_settlement_hovered)
		print("MapTestScene: Map layer configured")
	else:
		push_warning("MapTestScene: MapLayer node not found. Add a MapLayer node as a child.")

func _on_settlement_selected(sid: String, mid: String):
	var settlement = map_data.get_settlement(sid)
	var municipality = map_data.get_municipality(mid)
	
	print("Selected settlement: %s (%s) in municipality: %s (%s)" % [
		settlement.get("name", "Unknown"),
		sid,
		municipality.get("name", "Unknown"),
		mid
	])

func _on_settlement_hovered(sid: String, mid: String):
	var settlement = map_data.get_settlement(sid)
	# Only log on first hover to avoid spam
	# print("Hovered: %s" % settlement.get("name", "Unknown"))
