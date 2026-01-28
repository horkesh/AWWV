/**
 * Dev Viewer: Read-only HTML viewer for raw GameState
 * 
 * This viewer consumes GameState from the dev runner and renders it.
 * It does NOT compute any game logic - it only displays raw values from state.
 * 
 * Mistake guard: dev viewer must never compute game logic and must render raw GameState only
 */

const API_BASE = 'http://localhost:3000';

// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const inspector = document.getElementById('inspector');
const inspectorTitle = document.getElementById('inspector-title');
const inspectorContent = document.getElementById('inspector-content');
const inspectorClose = document.getElementById('inspector-close');

// Resize canvas
function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  canvas.width = container.clientWidth - 2;
  canvas.height = Math.max(600, window.innerHeight - 200);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// State storage
let gameState = null;
let settlementPositions = new Map(); // sid -> {x, y}
let selectedSettlement = null;
let selectedEdge = null;

// Color palette for factions
const factionColors = new Map();
const colorPalette = [
  '#ff4444', '#4444ff', '#44ff44', '#ff44ff', '#ffff44', '#44ffff',
  '#ff8844', '#8844ff', '#44ff88', '#ff4488', '#88ff44', '#4488ff'
];
let colorIndex = 0;

function getFactionColor(factionId) {
  if (!factionColors.has(factionId)) {
    factionColors.set(factionId, colorPalette[colorIndex % colorPalette.length]);
    colorIndex++;
  }
  return factionColors.get(factionId);
}

// Extract settlements from GameState
function extractSettlements(state) {
  const settlements = new Set();
  if (state.factions && Array.isArray(state.factions)) {
    for (const faction of state.factions) {
      if (faction.areasOfResponsibility && Array.isArray(faction.areasOfResponsibility)) {
        for (const sid of faction.areasOfResponsibility) {
          settlements.add(sid);
        }
      }
    }
  }
  // Also check end_state snapshot if present
  if (state.end_state?.snapshot?.controllers) {
    for (const [sid] of state.end_state.snapshot.controllers) {
      settlements.add(String(sid));
    }
  }
  return Array.from(settlements).sort();
}

// Extract edges from front_segments
function extractEdges(state) {
  const edges = [];
  if (state.front_segments && typeof state.front_segments === 'object') {
    for (const edgeId of Object.keys(state.front_segments)) {
      // Parse edge_id format: "s1__s2" or similar
      const parts = edgeId.split('__');
      if (parts.length === 2) {
        edges.push({
          id: edgeId,
          a: parts[0],
          b: parts[1],
          segment: state.front_segments[edgeId]
        });
      }
    }
  }
  return edges;
}

// Simple force-directed layout
function computeLayout(settlements, edges) {
  const positions = new Map();
  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  
  // Initialize positions in a circle
  const angleStep = (2 * Math.PI) / settlements.length;
  settlements.forEach((sid, i) => {
    const angle = i * angleStep;
    const radius = Math.min(width, height) * 0.3;
    positions.set(sid, {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
    });
  });
  
  // Simple force-directed iterations
  for (let iter = 0; iter < 100; iter++) {
    const forces = new Map();
    settlements.forEach(sid => {
      forces.set(sid, { x: 0, y: 0 });
    });
    
    // Repulsion between all settlements
    for (let i = 0; i < settlements.length; i++) {
      for (let j = i + 1; j < settlements.length; j++) {
        const sid1 = settlements[i];
        const sid2 = settlements[j];
        const pos1 = positions.get(sid1);
        const pos2 = positions.get(sid2);
        const dx = pos1.x - pos2.x;
        const dy = pos1.y - pos2.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 1000 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(sid1).x += fx;
        forces.get(sid1).y += fy;
        forces.get(sid2).x -= fx;
        forces.get(sid2).y -= fy;
      }
    }
    
    // Attraction along edges
    edges.forEach(edge => {
      const posA = positions.get(edge.a);
      const posB = positions.get(edge.b);
      if (posA && posB) {
        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(edge.a).x += fx;
        forces.get(edge.a).y += fy;
        forces.get(edge.b).x -= fx;
        forces.get(edge.b).y -= fy;
      }
    });
    
    // Apply forces with damping
    settlements.forEach(sid => {
      const pos = positions.get(sid);
      const force = forces.get(sid);
      pos.x += force.x * 0.1;
      pos.y += force.y * 0.1;
      // Keep within bounds
      pos.x = Math.max(20, Math.min(width - 20, pos.x));
      pos.y = Math.max(20, Math.min(height - 20, pos.y));
    });
  }
  
  return positions;
}

// Get settlement controller from state
function getSettlementController(state, sid) {
  // Check control_overrides first
  if (state.control_overrides && state.control_overrides[sid]) {
    return state.control_overrides[sid].side || null;
  }
  // Check factions' AoR
  if (state.factions && Array.isArray(state.factions)) {
    for (const faction of state.factions) {
      if (faction.areasOfResponsibility && faction.areasOfResponsibility.includes(sid)) {
        return faction.id;
      }
    }
  }
  // Check end_state snapshot
  if (state.end_state?.snapshot?.controllers) {
    for (const [settlementId, controllerId] of state.end_state.snapshot.controllers) {
      if (String(settlementId) === String(sid)) {
        return controllerId;
      }
    }
  }
  return null;
}

// Render the state
function render() {
  if (!gameState) return;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const settlements = extractSettlements(gameState);
  const edges = extractEdges(gameState);
  
  // Compute layout
  settlementPositions = computeLayout(settlements, edges);
  
  // Draw edges first (so they're behind settlements)
  edges.forEach(edge => {
    const posA = settlementPositions.get(edge.a);
    const posB = settlementPositions.get(edge.b);
    if (!posA || !posB) return;
    
    const segment = edge.segment;
    const isActive = segment && segment.active === true;
    const pressure = gameState.front_pressure?.[edge.id];
    
    ctx.strokeStyle = isActive ? '#ff6666' : '#666666';
    ctx.lineWidth = isActive ? 3 : 1;
    ctx.beginPath();
    ctx.moveTo(posA.x, posA.y);
    ctx.lineTo(posB.x, posB.y);
    ctx.stroke();
    
    // Highlight selected edge
    if (selectedEdge === edge.id) {
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(posA.x, posA.y);
      ctx.lineTo(posB.x, posB.y);
      ctx.stroke();
    }
  });
  
  // Draw settlements
  settlements.forEach(sid => {
    const pos = settlementPositions.get(sid);
    if (!pos) return;
    
    const controller = getSettlementController(gameState, sid);
    const color = controller ? getFactionColor(controller) : '#888888';
    
    // Draw circle
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw border for selected settlement
    if (selectedSettlement === sid) {
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Draw label
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.fillText(sid, pos.x + 12, pos.y + 4);
  });
  
  // Update status
  document.getElementById('status').textContent = 
    `Turn ${gameState.meta?.turn || 0} | Settlements: ${settlements.length} | Edges: ${edges.length}`;
}

// Show inspector for settlement
function showSettlementInspector(sid) {
  selectedSettlement = sid;
  selectedEdge = null;
  inspector.style.display = 'block';
  inspectorTitle.textContent = `Settlement: ${sid}`;
  
  const controller = getSettlementController(gameState, sid);
  const faction = gameState.factions?.find(f => f.id === controller);
  
  let html = '';
  html += `<div class="field"><span class="label">Controller:</span><span class="value">${controller || 'none'}</span></div>`;
  
  if (faction) {
    html += `<div class="field"><span class="label">Faction Profile:</span></div>`;
    if (faction.profile) {
      html += `<div class="field" style="margin-left: 20px;">Authority: <span class="value">${faction.profile.authority}</span></div>`;
      html += `<div class="field" style="margin-left: 20px;">Legitimacy: <span class="value">${faction.profile.legitimacy}</span></div>`;
      html += `<div class="field" style="margin-left: 20px;">Control: <span class="value">${faction.profile.control}</span></div>`;
      html += `<div class="field" style="margin-left: 20px;">Logistics: <span class="value">${faction.profile.logistics}</span></div>`;
      html += `<div class="field" style="margin-left: 20px;">Exhaustion: <span class="value">${faction.profile.exhaustion}</span></div>`;
    }
    if (faction.negotiation) {
      html += `<div class="field"><span class="label">Negotiation Pressure:</span><span class="value">${faction.negotiation.pressure}</span></div>`;
      html += `<div class="field"><span class="label">Negotiation Capital:</span><span class="value">${faction.negotiation.capital || 0}</span></div>`;
    }
  }
  
  // Check for collapse eligibility (if present in state)
  if (gameState.collapse_eligibility && gameState.collapse_eligibility[controller]) {
    const collapse = gameState.collapse_eligibility[controller];
    html += `<div class="field"><span class="label">Collapse Eligibility:</span></div>`;
    html += `<div class="field" style="margin-left: 20px;">Authority: <span class="value">${collapse.eligible_authority}</span></div>`;
    html += `<div class="field" style="margin-left: 20px;">Cohesion: <span class="value">${collapse.eligible_cohesion}</span></div>`;
    html += `<div class="field" style="margin-left: 20px;">Spatial: <span class="value">${collapse.eligible_spatial}</span></div>`;
  }
  
  inspectorContent.innerHTML = html;
  render();
}

// Show inspector for edge
function showEdgeInspector(edgeId) {
  selectedEdge = edgeId;
  selectedSettlement = null;
  inspector.style.display = 'block';
  inspectorTitle.textContent = `Edge: ${edgeId}`;
  
  const segment = gameState.front_segments?.[edgeId];
  const pressure = gameState.front_pressure?.[edgeId];
  const parts = edgeId.split('__');
  const sideA = parts[0] ? getSettlementController(gameState, parts[0]) : null;
  const sideB = parts[1] ? getSettlementController(gameState, parts[1]) : null;
  
  let html = '';
  html += `<div class="field"><span class="label">Settlements:</span><span class="value">${parts[0]} ↔ ${parts[1]}</span></div>`;
  html += `<div class="field"><span class="label">Side A:</span><span class="value">${sideA || 'none'}</span></div>`;
  html += `<div class="field"><span class="label">Side B:</span><span class="value">${sideB || 'none'}</span></div>`;
  
  if (segment) {
    html += `<div class="field"><span class="label">Active:</span><span class="value">${segment.active ? 'yes' : 'no'}</span></div>`;
    html += `<div class="field"><span class="label">Active Streak:</span><span class="value">${segment.active_streak || 0}</span></div>`;
    html += `<div class="field"><span class="label">Friction:</span><span class="value">${segment.friction || 0}</span></div>`;
    html += `<div class="field"><span class="label">Created Turn:</span><span class="value">${segment.created_turn || 0}</span></div>`;
  }
  
  if (pressure) {
    html += `<div class="field"><span class="label">Pressure Value:</span><span class="value">${pressure.value || 0}</span></div>`;
    html += `<div class="field"><span class="label">Max Abs:</span><span class="value">${pressure.max_abs || 0}</span></div>`;
    html += `<div class="field"><span class="label">Last Updated:</span><span class="value">Turn ${pressure.last_updated_turn || 0}</span></div>`;
    
    // Show pressure direction
    if (pressure.value > 0) {
      html += `<div class="field"><span class="label">Net Pressure:</span><span class="value">${sideA || 'A'} → ${sideB || 'B'}</span></div>`;
    } else if (pressure.value < 0) {
      html += `<div class="field"><span class="label">Net Pressure:</span><span class="value">${sideB || 'B'} → ${sideA || 'A'}</span></div>`;
    } else {
      html += `<div class="field"><span class="label">Net Pressure:</span><span class="value">balanced</span></div>`;
    }
  }
  
  // Show current posture assignments for each faction
  html += `<div class="posture-control">`;
  html += `<div class="field"><span class="label">Posture Controls:</span></div>`;
  
  // Get all factions that have posture assignments for this edge
  const factionsWithPosture = [];
  if (gameState.front_posture && typeof gameState.front_posture === 'object') {
    for (const factionId of Object.keys(gameState.front_posture)) {
      const factionPosture = gameState.front_posture[factionId];
      if (factionPosture && factionPosture.assignments && factionPosture.assignments[edgeId]) {
        const assignment = factionPosture.assignments[edgeId];
        factionsWithPosture.push({
          factionId,
          posture: assignment.posture || 'hold',
          weight: assignment.weight || 0
        });
      }
    }
  }
  
  // Show posture for each faction, or allow setting if edge is active and has sides
  if (sideA && sideB && segment && segment.active) {
    // Show controls for both sides
    [sideA, sideB].forEach((factionId, idx) => {
      const sideLabel = idx === 0 ? 'A' : 'B';
      const currentPosture = factionsWithPosture.find(p => p.factionId === factionId);
      const currentPostureValue = currentPosture ? currentPosture.posture : 'hold';
      const currentWeight = currentPosture ? currentPosture.weight : 0;
      
      // Phase 5B: Get effective posture exposure data
      const exposure = gameState.effective_posture_exposure?.by_faction?.[factionId]?.by_edge?.[edgeId];
      
      html += `<div class="field" style="margin-top: 10px;">`;
      html += `<div class="label">Side ${sideLabel} (${factionId}):</div>`;
      html += `<div class="field" style="margin-left: 10px;">Current: <span class="value">${currentPostureValue}</span> (weight: ${currentWeight})</div>`;
      
      // Phase 5B: Display intended vs effective posture
      if (exposure) {
        html += `<div class="field" style="margin-left: 10px; margin-top: 8px; padding: 8px; background: #222; border-radius: 4px;">`;
        html += `<div class="label" style="font-weight: bold; margin-bottom: 4px;">Effective Posture (Phase 5B):</div>`;
        html += `<div class="field" style="margin-left: 10px;">Intended: <span class="value">${exposure.intended_posture}</span> (weight: ${exposure.intended_weight})</div>`;
        html += `<div class="field" style="margin-left: 10px;">Effective: <span class="value">${exposure.intended_posture}</span> (weight: ${exposure.effective_weight})</div>`;
        html += `<div class="field" style="margin-left: 10px; margin-top: 4px; font-size: 0.9em; color: #aaa;">Diagnostics:</div>`;
        html += `<div class="field" style="margin-left: 20px; font-size: 0.85em; color: #aaa;">Friction factor: ${exposure.friction_factor.toFixed(3)}</div>`;
        html += `<div class="field" style="margin-left: 20px; font-size: 0.85em; color: #aaa;">Commit points: ${exposure.commit_points}</div>`;
        if (exposure.global_factor !== undefined) {
          html += `<div class="field" style="margin-left: 20px; font-size: 0.85em; color: #aaa;">Global capacity factor: ${exposure.global_factor.toFixed(3)}</div>`;
        }
        html += `</div>`;
      }
      
      html += `<select id="posture-select-${factionId}" style="width: 100%;">`;
      html += `<option value="hold" ${currentPostureValue === 'hold' ? 'selected' : ''}>hold</option>`;
      html += `<option value="probe" ${currentPostureValue === 'probe' ? 'selected' : ''}>probe</option>`;
      html += `<option value="push" ${currentPostureValue === 'push' ? 'selected' : ''}>push</option>`;
      html += `</select>`;
      html += `<input type="number" id="posture-weight-${factionId}" value="${currentWeight}" min="0" placeholder="weight" style="width: 100%;">`;
      html += `<button onclick="setPosture('${factionId}', '${edgeId}')" style="width: 100%; margin-top: 4px;">Set Posture</button>`;
      
      // Phase 5C: Logistics priority control
      const currentPriority = gameState.logistics_priority?.[factionId]?.[edgeId] ?? 1.0;
      html += `<div class="field" style="margin-top: 10px;">`;
      html += `<div class="label">Logistics Priority:</div>`;
      html += `<div class="field" style="margin-left: 10px;">Current: <span class="value">${currentPriority.toFixed(2)}</span></div>`;
      html += `<input type="number" id="logistics-priority-${factionId}" value="${currentPriority}" min="0.01" step="0.1" placeholder="priority (default: 1.0)" style="width: 100%;">`;
      html += `<button onclick="setLogisticsPriority('${factionId}', '${edgeId}')" style="width: 100%; margin-top: 4px;">Set Logistics Priority</button>`;
      html += `</div>`;
      
      html += `</div>`;
    });
  } else {
    // Show read-only posture info
    if (factionsWithPosture.length > 0) {
      factionsWithPosture.forEach(p => {
        html += `<div class="field" style="margin-left: 10px;">${p.factionId}: <span class="value">${p.posture}</span> (weight: ${p.weight})</div>`;
        
        // Phase 5B: Show effective posture if available
        const exposure = gameState.effective_posture_exposure?.by_faction?.[p.factionId]?.by_edge?.[edgeId];
        if (exposure) {
          html += `<div class="field" style="margin-left: 20px; font-size: 0.9em; color: #aaa;">Effective weight: ${exposure.effective_weight} (friction: ${exposure.friction_factor.toFixed(3)})</div>`;
        }
      });
    } else {
      html += `<div class="field" style="margin-left: 10px; color: #888;">No posture assignments</div>`;
    }
  }
  
  html += `</div>`;
  
  inspectorContent.innerHTML = html;
  render();
}

// Set posture for a faction/edge
async function setPosture(factionId, edgeId) {
  const postureSelect = document.getElementById(`posture-select-${factionId}`);
  const weightInput = document.getElementById(`posture-weight-${factionId}`);
  
  if (!postureSelect || !weightInput) {
    console.error('Posture controls not found');
    return;
  }
  
  const posture = postureSelect.value;
  const weight = parseInt(weightInput.value, 10) || 0;
  
  try {
    const response = await fetch(`${API_BASE}/set_posture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        faction_id: factionId,
        edge_id: edgeId,
        posture: posture,
        weight: weight
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    gameState = await response.json();
    // Refresh the inspector to show updated posture
    showEdgeInspector(edgeId);
    render();
  } catch (error) {
    document.getElementById('status').textContent = `Error setting posture: ${error.message}`;
    console.error('Failed to set posture:', error);
  }
}

// Set logistics priority for a faction/target
async function setLogisticsPriority(factionId, targetId) {
  const priorityInput = document.getElementById(`logistics-priority-${factionId}`);
  
  if (!priorityInput) {
    console.error('Logistics priority input not found');
    return;
  }
  
  const priority = parseFloat(priorityInput.value);
  
  if (isNaN(priority) || priority <= 0) {
    document.getElementById('status').textContent = 'Error: Priority must be > 0';
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/set_logistics_priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        faction_id: factionId,
        target_id: targetId,
        priority: priority
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    gameState = await response.json();
    // Refresh the inspector to show updated priority
    if (selectedEdge) {
      showEdgeInspector(selectedEdge);
    }
    render();
  } catch (error) {
    document.getElementById('status').textContent = `Error setting logistics priority: ${error.message}`;
    console.error('Failed to set logistics priority:', error);
  }
}

// Make setPosture and setLogisticsPriority available globally for onclick handlers
window.setPosture = setPosture;
window.setLogisticsPriority = setLogisticsPriority;

// Click handler
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  // Check settlements first (they're on top)
  let clickedSettlement = null;
  let minDist = Infinity;
  settlementPositions.forEach((pos, sid) => {
    const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
    if (dist < 15 && dist < minDist) {
      minDist = dist;
      clickedSettlement = sid;
    }
  });
  
  if (clickedSettlement) {
    showSettlementInspector(clickedSettlement);
    return;
  }
  
  // Check edges
  const edges = extractEdges(gameState);
  let clickedEdge = null;
  minDist = Infinity;
  edges.forEach(edge => {
    const posA = settlementPositions.get(edge.a);
    const posB = settlementPositions.get(edge.b);
    if (!posA || !posB) return;
    
    // Distance from point to line segment
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return;
    
    const t = Math.max(0, Math.min(1, ((x - posA.x) * dx + (y - posA.y) * dy) / len2));
    const projX = posA.x + t * dx;
    const projY = posA.y + t * dy;
    const dist = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
    
    if (dist < 10 && dist < minDist) {
      minDist = dist;
      clickedEdge = edge.id;
    }
  });
  
  if (clickedEdge) {
    showEdgeInspector(clickedEdge);
    return;
  }
  
  // Clicked empty space - hide inspector
  inspector.style.display = 'none';
  selectedSettlement = null;
  selectedEdge = null;
  render();
});

inspectorClose.addEventListener('click', () => {
  inspector.style.display = 'none';
  selectedSettlement = null;
  selectedEdge = null;
  render();
});

// API functions
async function fetchState() {
  try {
    const response = await fetch(`${API_BASE}/state`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    gameState = await response.json();
    render();
  } catch (error) {
    document.getElementById('status').textContent = `Error: ${error.message}`;
    console.error('Failed to fetch state:', error);
  }
}

async function stepTurn() {
  try {
    const response = await fetch(`${API_BASE}/step`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    gameState = await response.json();
    render();
  } catch (error) {
    document.getElementById('status').textContent = `Error: ${error.message}`;
    console.error('Failed to step turn:', error);
  }
}

async function resetState() {
  try {
    const response = await fetch(`${API_BASE}/reset`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    gameState = await response.json();
    selectedSettlement = null;
    selectedEdge = null;
    inspector.style.display = 'none';
    render();
  } catch (error) {
    document.getElementById('status').textContent = `Error: ${error.message}`;
    console.error('Failed to reset state:', error);
  }
}

async function run5Turns() {
  const btn = document.getElementById('btn-run5');
  btn.disabled = true;
  try {
    for (let i = 0; i < 5; i++) {
      await stepTurn();
      // Small delay for visual feedback
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    btn.disabled = false;
  }
}

// Button handlers
document.getElementById('btn-next').addEventListener('click', stepTurn);
document.getElementById('btn-run5').addEventListener('click', run5Turns);
document.getElementById('btn-reset').addEventListener('click', resetState);
document.getElementById('btn-refresh').addEventListener('click', fetchState);

// Initial load
fetchState();
