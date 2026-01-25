extends Node2D
class_name MapLayer

## Renders settlement polygons on the map
## Supports hover highlight and click selection

signal settlement_selected(sid: String, mid: String)
signal settlement_hovered(sid: String, mid: String)

@export var map_data: MapData
@export var settlement_polygons: SettlementPolygons
@export var show_municipality_outlines: bool = false

var settlement_colors: Dictionary = {}  # sid -> Color
var hovered_sid: String = ""
var selected_sid: String = ""

var default_color: Color = Color(0.7, 0.7, 0.8, 0.5)
var hover_color: Color = Color(1.0, 0.8, 0.0, 0.7)
var selected_color: Color = Color(0.2, 0.6, 1.0, 0.8)
var outline_color: Color = Color(0.3, 0.3, 0.4, 0.9)

var map_scale: float = 1.0
var map_origin: Vector2 = Vector2.ZERO
var world_center: Vector2 = Vector2.ZERO

# Debug overlay
var debug_overlay_enabled: bool = false
var polygons_drawn: int = 0
var polygons_skipped_triangulation: int = 0
var debug_summary_timer: float = 0.0

func _ready():
	if map_data == null:
		push_error("MapData not assigned to MapLayer")
		return
	
	if settlement_polygons == null:
		push_error("SettlementPolygons not assigned to MapLayer")
		return
	
	# Calculate coordinate transform from map_bounds
	_calculate_transform()

func _calculate_transform():
	if map_data.map_bounds.is_empty():
		return
	
	var bounds = map_data.map_bounds
	var map_width = bounds.get("width", 1000.0)
	var map_height = bounds.get("height", 1000.0)
	var min_x = bounds.get("min_x", 0.0)
	var min_y = bounds.get("min_y", 0.0)
	var max_x = bounds.get("max_x", 1000.0)
	var max_y = bounds.get("max_y", 1000.0)
	
	# Calculate world center
	world_center = Vector2((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)
	
	# Get viewport size
	var viewport = get_viewport()
	if viewport == null:
		return
	
	var viewport_size = viewport.get_visible_rect().size
	var viewport_center = viewport_size / 2.0
	
	# Calculate scale to fit with 5% margin
	var scale_x = (viewport_size.x * 0.95) / map_width
	var scale_y = (viewport_size.y * 0.95) / map_height
	map_scale = min(scale_x, scale_y)
	
	# Calculate origin: screen_pos = (world_pos - world_center) * scale + viewport_center
	# So: map_origin = viewport_center - world_center * map_scale
	map_origin = viewport_center - world_center * map_scale

func _draw():
	if settlement_polygons == null:
		return
	
	# Reset stats for this frame
	polygons_drawn = 0
	polygons_skipped_triangulation = 0
	
	# Draw all settlement polygons
	for sid in settlement_polygons.polygons_by_sid.keys():
		var points = settlement_polygons.get_polygon(sid)
		if points.is_empty():
			continue
		
		# Transform points to screen coordinates (fresh array per polygon)
		var screen_points = PackedVector2Array()
		for point in points:
			screen_points.append(_map_to_screen(point))
		
		# Determine color
		var color = default_color
		if sid == selected_sid:
			color = selected_color
		elif sid == hovered_sid:
			color = hover_color
		else:
			color = settlement_colors.get(sid, default_color)
		
		# Triangulate and draw (independent per polygon)
		var triangles = Geometry2D.triangulate_polygon(screen_points)
		if triangles.size() >= 3:
			# Draw filled polygon (each polygon gets its own draw calls)
			for i in range(0, triangles.size(), 3):
				if i + 2 < triangles.size():
					# Create fresh triangle array for each triangle
					var triangle = PackedVector2Array([
						screen_points[triangles[i]],
						screen_points[triangles[i + 1]],
						screen_points[triangles[i + 2]]
					])
					draw_colored_polygon(triangle, color)
			
			# Draw outline (independent per polygon)
			draw_polyline(screen_points, outline_color, 1.0, true)
			polygons_drawn += 1
		else:
			# Triangulation failed - skip this polygon, don't spam logs
			polygons_skipped_triangulation += 1
	
	# Draw municipality outlines if enabled
	if show_municipality_outlines:
		_draw_municipality_outlines()
	
	# Draw debug overlay if enabled
	if debug_overlay_enabled:
		_draw_debug_overlay()

func _draw_municipality_outlines():
	# Draw municipality outlines from settlements
	if map_data == null or settlement_polygons == null:
		return
	
	for muni in map_data.municipalities_meta:
		var mid = muni.get("mid", "")
		if mid.is_empty():
			continue
		
		var settlement_ids = settlement_polygons.get_settlement_ids(mid)
		if settlement_ids.is_empty():
			continue
		
		# Collect all points from settlements in this municipality
		var all_points = PackedVector2Array()
		for sid in settlement_ids:
			var points = settlement_polygons.get_polygon(sid)
			for point in points:
				var screen_point = _map_to_screen(point)
				all_points.append(screen_point)
		
		# Draw outline (simplified - just draw all points as a polyline)
		if all_points.size() > 2:
			draw_polyline(all_points, Color(0.5, 0.5, 0.6, 0.8), 2.0, false)

func _draw_debug_overlay():
	# Draw municipality outlines with coverage information
	if map_data == null or settlement_polygons == null:
		return
	
	var font = ThemeDB.fallback_font
	var font_size = 12
	
	for muni in map_data.municipalities_meta:
		var mid = muni.get("mid", "")
		var name = muni.get("name", "")
		if mid.is_empty():
			continue
		
		# Calculate coverage
		var total_settlements = muni.get("total_settlements", 0)
		var settlements_with_geometry = muni.get("settlements_with_geometry", 0)
		var coverage = 0.0
		if total_settlements > 0:
			coverage = float(settlements_with_geometry) / float(total_settlements)
		
		# Shade by coverage (deterministic grayscale)
		var shade = coverage  # 0.0 to 1.0
		var overlay_color = Color(shade, shade, shade, 0.3)
		
		# Draw municipality area (from settlements)
		var settlement_ids = settlement_polygons.get_settlement_ids(mid)
		if not settlement_ids.is_empty():
			# Collect all points
			var all_points = PackedVector2Array()
			for sid in settlement_ids:
				var points = settlement_polygons.get_polygon(sid)
				for point in points:
					all_points.append(_map_to_screen(point))
			
			# Draw filled overlay
			if all_points.size() > 2:
				var triangles = Geometry2D.triangulate_polygon(all_points)
				if triangles.size() >= 3:
					for i in range(0, triangles.size(), 3):
						if i + 2 < triangles.size():
							var triangle = PackedVector2Array([
								all_points[triangles[i]],
								all_points[triangles[i + 1]],
								all_points[triangles[i + 2]]
							])
							draw_colored_polygon(triangle, overlay_color)
			
			# Draw outline
			if all_points.size() > 2:
				draw_polyline(all_points, Color(0.2, 0.2, 0.3, 0.9), 1.5, false)
		
		# Calculate label position (centroid of settlements)
		if not settlement_ids.is_empty():
			var centroid = Vector2.ZERO
			var count = 0
			for sid in settlement_ids:
				var points = settlement_polygons.get_polygon(sid)
				for point in points:
					centroid += _map_to_screen(point)
					count += 1
			if count > 0:
				centroid /= count
				
				# Draw label
				var label_text = "%s\n%s\n%d/%d" % [mid, name, settlements_with_geometry, total_settlements]
				draw_string(font, centroid, label_text, HORIZONTAL_ALIGNMENT_CENTER, -1, font_size, Color(1.0, 1.0, 1.0, 1.0))

func _map_to_screen(map_point: Vector2) -> Vector2:
	# Transform: screen_pos = (world_pos - world_center) * scale + viewport_center
	# map_origin = viewport_center - world_center * map_scale
	# So: screen_pos = map_point * map_scale + map_origin
	return map_point * map_scale + map_origin

func _screen_to_map(screen_point: Vector2) -> Vector2:
	# Inverse transform
	return (screen_point - map_origin) / map_scale

func _input(event):
	# Toggle debug overlay with F1
	if event is InputEventKey and event.pressed:
		if event.keycode == KEY_F1:
			debug_overlay_enabled = not debug_overlay_enabled
			queue_redraw()
			return
	
	# Print debug summary on keypress (e.g., F2)
	if event is InputEventKey and event.pressed:
		if event.keycode == KEY_F2:
			_print_debug_summary()
			return
	
	if event is InputEventMouseButton:
		if event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
			var mouse_pos = get_global_mouse_position()
			var clicked_sid = _find_settlement_at(mouse_pos)
			if clicked_sid != "":
				selected_sid = clicked_sid
				var settlement = map_data.get_settlement(clicked_sid)
				var mid = settlement.get("mid", "")
				settlement_selected.emit(clicked_sid, mid)
				queue_redraw()
	
	elif event is InputEventMouseMotion:
		var mouse_pos = get_global_mouse_position()
		var hovered = _find_settlement_at(mouse_pos)
		if hovered != hovered_sid:
			hovered_sid = hovered
			if hovered != "":
				var settlement = map_data.get_settlement(hovered)
				var mid = settlement.get("mid", "")
				settlement_hovered.emit(hovered, mid)
			queue_redraw()

func _process(delta):
	# Print debug summary once per second
	debug_summary_timer += delta
	if debug_summary_timer >= 1.0:
		debug_summary_timer = 0.0
		if debug_overlay_enabled:
			_print_debug_summary()

func _print_debug_summary():
	print("MapLayer Debug Summary:")
	print("  polygons_drawn: %d" % polygons_drawn)
	print("  polygons_skipped_triangulation: %d" % polygons_skipped_triangulation)
	print("  current_scale: %.4f" % map_scale)
	print("  world_center: %s" % world_center)
	print("  map_origin: %s" % map_origin)

func _find_settlement_at(screen_point: Vector2) -> String:
	if settlement_polygons == null:
		return ""
	
	var map_point = _screen_to_map(screen_point)
	
	# Check each settlement polygon using point-in-polygon
	for sid in settlement_polygons.polygons_by_sid.keys():
		var points = settlement_polygons.get_polygon(sid)
		if points.is_empty():
			continue
		
		# Use Geometry2D for point-in polygon test with map coordinates
		if Geometry2D.is_point_in_polygon(map_point, points):
			return sid
	
	return ""

## Set color for a settlement
func set_settlement_color(sid: String, color: Color):
	settlement_colors[sid] = color
	queue_redraw()

## Clear selection
func clear_selection():
	selected_sid = ""
	queue_redraw()
