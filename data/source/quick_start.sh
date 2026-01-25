#!/bin/bash
# Quick Start Script for Municipality Border Generation

echo "=================================================="
echo "AWWV Municipality Border Generation - Quick Start"
echo "=================================================="
echo ""

# Check if input file exists
if [ ! -f "$1" ]; then
    echo "Usage: ./quick_start.sh <your_settlements.geojson>"
    echo ""
    echo "Example:"
    echo "  ./quick_start.sh data/settlements_1991.geojson"
    echo ""
    echo "This will:"
    echo "  1. Generate municipality borders"
    echo "  2. Save to data/municipalities_1991.geojson"
    echo "  3. Open visualization in browser"
    exit 1
fi

SETTLEMENTS_FILE="$1"
OUTPUT_FILE="${SETTLEMENTS_FILE%.*}_municipalities.geojson"

echo "📍 Input:  $SETTLEMENTS_FILE"
echo "📐 Output: $OUTPUT_FILE"
echo ""

# Step 1: Generate borders
echo "Step 1/3: Generating municipality borders..."
python3 simple_municipality_borders.py "$SETTLEMENTS_FILE" "$OUTPUT_FILE" 0.015

if [ $? -ne 0 ]; then
    echo "❌ Error generating borders. Check that shapely is installed:"
    echo "   pip install shapely"
    exit 1
fi

echo ""
echo "✓ Municipality borders generated!"
echo ""

# Step 2: Start local server
echo "Step 2/3: Starting local server for visualization..."
echo "(Press Ctrl+C to stop the server when done)"
echo ""

python3 -m http.server 8000 &
SERVER_PID=$!

sleep 2

# Step 3: Open browser
echo "Step 3/3: Opening visualization in browser..."
if command -v xdg-open > /dev/null; then
    xdg-open "http://localhost:8000/visualize_municipality_borders.html"
elif command -v open > /dev/null; then
    open "http://localhost:8000/visualize_municipality_borders.html"
else
    echo "Please open this URL in your browser:"
    echo "  http://localhost:8000/visualize_municipality_borders.html"
fi

echo ""
echo "=================================================="
echo "✓ Done! Check your browser to see the results."
echo ""
echo "In the browser:"
echo "  1. Click 'Settlement Points' → Select: $SETTLEMENTS_FILE"
echo "  2. Click 'Municipality Borders' → Select: $OUTPUT_FILE"
echo "  3. Toggle layers and verify borders look correct"
echo ""
echo "Press Ctrl+C to stop the server when finished."
echo "=================================================="

# Wait for Ctrl+C
wait $SERVER_PID
