extends RefCounted
class_name MapData

## Loads and provides access to map metadata files
## Loads: municipalities_meta.json, settlements_meta.json, map_bounds.json

var municipalities_meta: Array[Dictionary] = []
var settlements_meta: Array[Dictionary] = []
var map_bounds: Dictionary = {}

var municipality_by_id: Dictionary = {}
var settlement_by_id: Dictionary = {}

## Load all map metadata files
func load_data() -> bool:
	var base_path = "res://data/derived/"
	
	# Load municipalities metadata
	var muni_file = FileAccess.open(base_path + "municipalities_meta.json", FileAccess.READ)
	if muni_file == null:
		push_error("Failed to open municipalities_meta.json")
		return false
	
	var muni_json = JSON.new()
	var parse_result = muni_json.parse(muni_file.get_as_text())
	muni_file.close()
	
	if parse_result != OK:
		push_error("Failed to parse municipalities_meta.json: " + muni_json.get_error_message())
		return false
	
	municipalities_meta = muni_json.data
	if not municipalities_meta is Array:
		push_error("municipalities_meta.json does not contain an array")
		return false
	
	# Build municipality lookup
	for muni in municipalities_meta:
		municipality_by_id[muni.mid] = muni
	
	# Load settlements metadata
	var settle_file = FileAccess.open(base_path + "settlements_meta.json", FileAccess.READ)
	if settle_file == null:
		push_error("Failed to open settlements_meta.json")
		return false
	
	var settle_json = JSON.new()
	parse_result = settle_json.parse(settle_file.get_as_text())
	settle_file.close()
	
	if parse_result != OK:
		push_error("Failed to parse settlements_meta.json: " + settle_json.get_error_message())
		return false
	
	settlements_meta = settle_json.data
	if not settlements_meta is Array:
		push_error("settlements_meta.json does not contain an array")
		return false
	
	# Build settlement lookup
	for settlement in settlements_meta:
		settlement_by_id[settlement.sid] = settlement
	
	# Load map bounds
	var bounds_file = FileAccess.open(base_path + "map_bounds.json", FileAccess.READ)
	if bounds_file == null:
		push_error("Failed to open map_bounds.json")
		return false
	
	var bounds_json = JSON.new()
	parse_result = bounds_json.parse(bounds_file.get_as_text())
	bounds_file.close()
	
	if parse_result != OK:
		push_error("Failed to parse map_bounds.json: " + bounds_json.get_error_message())
		return false
	
	map_bounds = bounds_json.data
	if not map_bounds is Dictionary:
		push_error("map_bounds.json does not contain a dictionary")
		return false
	
	return true

## Get municipality by ID
func get_municipality(mid: String) -> Dictionary:
	return municipality_by_id.get(mid, {})

## Get settlement by ID
func get_settlement(sid: String) -> Dictionary:
	return settlement_by_id.get(sid, {})

## Get all settlements in a municipality
func get_settlements_in_municipality(mid: String) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for settlement in settlements_meta:
		if settlement.mid == mid:
			result.append(settlement)
	return result
