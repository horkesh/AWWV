/**
 * Phase 12C.5: Negotiation Map Mode Dev UI
 * 
 * Lightweight local HTML/TS map viewer for building treaty packages visually.
 * No gameplay changes, no pipeline changes, no timestamps.
 * Deterministic exports only.
 */

import type { GameState, PoliticalSideId } from '../src/state/game_state.js';
import type { TreatyDraft, TreatyClause, TreatyScope } from '../src/state/treaty.js';
import { buildTreatyDraft, createClause } from '../src/state/treaty_builder.js';
import { evaluateTreatyAcceptance } from '../src/state/treaty_acceptance.js';
import { computeSettlementValues } from '../src/state/territorial_valuation.js';
import { getEffectiveSettlementSide } from '../src/state/control_effective.js';
import { computeFrontEdges } from '../src/map/front_edges.js';
import type { LoadedSettlementGraph, SettlementRecord, EdgeRecord } from '../src/map/settlements.js';
import type { TerritorialValuationReport } from '../src/state/territorial_valuation.js';
import type { TreatyAcceptanceReport } from '../src/state/treaty_acceptance.js';
import { isClauseDeprecated } from '../src/state/treaty_clause_library.js';
import { BRCKO_SIDS } from '../src/state/brcko.js';
import { ALL_COMPETENCES, type CompetenceId } from '../src/state/competences.js';
import { COMPETENCE_VALUATIONS, computeCompetenceUtility } from '../src/state/competence_valuations.js';
import { ACCEPTANCE_CONSTRAINTS } from '../src/state/acceptance_constraints.js';

// Phase 16: Competence allocation state
interface CompetenceAllocation {
  competence: CompetenceId;
  holder: PoliticalSideId;
}

// UI State
interface UIState {
  gameState: GameState | null;
  settlementsGraph: LoadedSettlementGraph | null;
  polygons: Map<string, GeoJSON.Feature>;
  demandSids: Set<string>;
  concedeSids: Set<string>;
  hasBrckoClause: boolean; // Phase 12D.2: Brčko special status clause toggle
  importedClauses: TreatyClause[]; // Phase 12D.2: Clauses from imported draft (may include deprecated)
  competenceAllocations: CompetenceAllocation[]; // Phase 16: Competence allocations
  proposerSide: PoliticalSideId;
  counterpartySide: PoliticalSideId;
  mode: 'demand' | 'concede';
  zoom: number;
  panX: number;
  panY: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const state: UIState = {
  gameState: null,
  settlementsGraph: null,
  polygons: new Map(),
  demandSids: new Set(),
  concedeSids: new Set(),
  hasBrckoClause: false,
  importedClauses: [],
  competenceAllocations: [], // Phase 16
  proposerSide: 'RBiH',
  counterpartySide: 'RS',
  mode: 'demand',
  zoom: 1,
  panX: 0,
  panY: 0,
  bounds: null
};

// Color mapping for sides
const SIDE_COLORS: Record<string, string> = {
  'RBiH': '#4a90e2',
  'RS': '#e24a4a',
  'HRHB': '#4ae24a',
  'null': '#cccccc'
};

// Get canvas and context
const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Initialize canvas size
function resizeCanvas() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Load GeoJSON polygons
async function loadPolygons(): Promise<Map<string, GeoJSON.Feature>> {
  const response = await fetch('./data/derived/settlements_polygons.geojson');
  const geojson: GeoJSON.FeatureCollection = await response.json();
  const map = new Map<string, GeoJSON.Feature>();
  
  for (const feature of geojson.features) {
    const sid = feature.properties?.sid;
    if (sid && typeof sid === 'string') {
      map.set(sid, feature);
    }
  }
  
  return map;
}

// Load settlements index
async function loadSettlementsIndex(): Promise<Map<string, SettlementRecord>> {
  const response = await fetch('./data/derived/settlements_index.json');
  const data = await response.json();
  const map = new Map<string, SettlementRecord>();
  
  if (Array.isArray(data)) {
    for (const record of data) {
      if (record.sid && typeof record.sid === 'string') {
        map.set(record.sid, record);
      }
    }
  }
  
  return map;
}

// Load settlement edges
async function loadSettlementEdges(): Promise<EdgeRecord[]> {
  const response = await fetch('./data/derived/settlement_edges.json');
  const data = await response.json();
  
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}

// Load save file
async function loadSave(file: File): Promise<GameState> {
  const text = await file.text();
  const json = JSON.parse(text);
  return json as GameState;
}

// Compute bounds from polygons
function computeBounds(polygons: Map<string, GeoJSON.Feature>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const feature of polygons.values()) {
    if (feature.geometry.type === 'Polygon') {
      for (const ring of feature.geometry.coordinates) {
        for (const [x, y] of ring) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
  }
  
  return { minX, minY, maxX, maxY };
}

// Project coordinates to screen
function project(x: number, y: number): [number, number] {
  if (!state.bounds) return [0, 0];
  
  const { minX, minY, maxX, maxY } = state.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  
  const scale = Math.min(canvas.width / width, canvas.height / height) * state.zoom;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  
  const screenX = (x - centerX) * scale + canvas.width / 2 + state.panX;
  const screenY = (y - centerY) * scale + canvas.height / 2 + state.panY;
  
  return [screenX, screenY];
}

// Unproject screen coordinates to world
function unproject(screenX: number, screenY: number): [number, number] {
  if (!state.bounds) return [0, 0];
  
  const { minX, minY, maxX, maxY } = state.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  
  const scale = Math.min(canvas.width / width, canvas.height / height) * state.zoom;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  
  const worldX = (screenX - canvas.width / 2 - state.panX) / scale + centerX;
  const worldY = (screenY - canvas.height / 2 - state.panY) / scale + centerY;
  
  return [worldX, worldY];
}

// Check if point is in polygon
function pointInPolygon(x: number, y: number, coordinates: number[][][]): boolean {
  for (const ring of coordinates) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

// Find settlement at point
function findSettlementAt(x: number, y: number): string | null {
  const [worldX, worldY] = unproject(x, y);
  
  for (const [sid, feature] of state.polygons.entries()) {
    if (feature.geometry.type === 'Polygon') {
      if (pointInPolygon(worldX, worldY, feature.geometry.coordinates)) {
        return sid;
      }
    }
  }
  
  return null;
}

// Render map
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  if (!state.bounds || state.polygons.size === 0) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#666';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Loading map data...', canvas.width / 2, canvas.height / 2);
    return;
  }
  
  // Render polygons
  for (const [sid, feature] of state.polygons.entries()) {
    if (feature.geometry.type !== 'Polygon') continue;
    
    // Get effective control side
    let controlSide: string | null = null;
    if (state.gameState) {
      controlSide = getEffectiveSettlementSide(state.gameState, sid);
    }
    
    // Determine color
    let color = SIDE_COLORS[controlSide || 'null'];
    if (state.demandSids.has(sid)) {
      color = '#ffd700'; // Gold for demands
    } else if (state.concedeSids.has(sid)) {
      color = '#ff6b6b'; // Red for concessions
    }
    
    // Draw polygon
    ctx.beginPath();
    for (const ring of feature.geometry.coordinates) {
      let first = true;
      for (const [x, y] of ring) {
        const [sx, sy] = project(x, y);
        if (first) {
          ctx.moveTo(sx, sy);
          first = false;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.closePath();
    }
    
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}

// Update UI lists
function updateLists() {
  const demandList = document.getElementById('demand-list')!;
  const concedeList = document.getElementById('concede-list')!;
  
  demandList.innerHTML = '';
  const sortedDemands = Array.from(state.demandSids).sort();
  for (const sid of sortedDemands) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.textContent = sid;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.onclick = () => {
      state.demandSids.delete(sid);
      updateLists();
      updateTreatyPreview();
      render();
    };
    div.appendChild(btn);
    demandList.appendChild(div);
  }
  
  concedeList.innerHTML = '';
  const sortedConcedes = Array.from(state.concedeSids).sort();
  for (const sid of sortedConcedes) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.textContent = sid;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.onclick = () => {
      state.concedeSids.delete(sid);
      updateLists();
      updateTreatyPreview();
      render();
    };
    div.appendChild(btn);
    concedeList.appendChild(div);
  }
  
  // Phase 12D.2: Update brcko toggle
  const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
  if (brckoToggle) {
    brckoToggle.checked = state.hasBrckoClause;
  }
  
  // Phase 12D.2: Update imported clauses list
  updateImportedClausesList();
  
  // Phase 16: Update competence allocations list
  updateCompetenceAllocationsList();
  
  // Phase 16: Update peace status and competence utility
  updatePeaceStatus();
  updateCompetenceUtility();
}

// Phase 16: Update competence allocations list
function updateCompetenceAllocationsList() {
  const list = document.getElementById('competence-allocations-list')!;
  list.innerHTML = '';
  
  // Sort allocations deterministically: by competence_id, then holder_id
  const sorted = [...state.competenceAllocations].sort((a, b) => {
    const compDiff = a.competence.localeCompare(b.competence);
    if (compDiff !== 0) return compDiff;
    return a.holder.localeCompare(b.holder);
  });
  
  for (const alloc of sorted) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.style.display = 'flex';
    div.style.gap = '8px';
    div.style.alignItems = 'center';
    
    const selectComp = document.createElement('select');
    selectComp.style.flex = '1';
    for (const comp of ALL_COMPETENCES) {
      const option = document.createElement('option');
      option.value = comp;
      option.textContent = comp;
      if (comp === alloc.competence) option.selected = true;
      selectComp.appendChild(option);
    }
    selectComp.addEventListener('change', () => {
      const newComp = selectComp.value as CompetenceId;
      const partner = getBundlePartner(newComp);
      
      // Phase 16: Bundle auto-completion
      if (partner) {
        const existingPartner = state.competenceAllocations.find(a => a.competence === partner);
        if (existingPartner) {
          // Partner exists: ensure same holder
          alloc.holder = existingPartner.holder;
          selectHolder.value = alloc.holder;
        } else {
          // Partner missing: auto-add with same holder
          state.competenceAllocations.push({ competence: partner, holder: alloc.holder });
        }
      }
      
      // Remove old allocation if competence changed
      const oldPartner = getBundlePartner(alloc.competence);
      if (oldPartner && oldPartner !== newComp) {
        const partnerAlloc = state.competenceAllocations.find(a => a.competence === oldPartner && a !== alloc);
        if (partnerAlloc) {
          // Check if partner is still needed by other allocations
          const otherNeedsPartner = state.competenceAllocations.some(a => 
            a !== partnerAlloc && getBundlePartner(a.competence) === oldPartner
          );
          if (!otherNeedsPartner) {
            state.competenceAllocations = state.competenceAllocations.filter(a => a !== partnerAlloc);
          }
        }
      }
      
      alloc.competence = newComp;
      updateCompetenceAllocationsList();
      updateTreatyPreview();
      updateCompetenceUtility();
    });
    
    const selectHolder = document.createElement('select');
    selectHolder.style.flex = '1';
    const holders: PoliticalSideId[] = ['RBiH', 'RS', 'HRHB'];
    for (const holder of holders) {
      const option = document.createElement('option');
      option.value = holder;
      option.textContent = holder;
      if (holder === alloc.holder) option.selected = true;
      selectHolder.appendChild(option);
    }
    selectHolder.addEventListener('change', () => {
      const newHolder = selectHolder.value as PoliticalSideId;
      alloc.holder = newHolder;
      
      // Phase 16: Bundle same-holder enforcement
      const partner = getBundlePartner(alloc.competence);
      if (partner) {
        const partnerAlloc = state.competenceAllocations.find(a => a.competence === partner);
        if (partnerAlloc) {
          partnerAlloc.holder = newHolder;
        } else {
          // Auto-add partner with same holder
          state.competenceAllocations.push({ competence: partner, holder: newHolder });
        }
      }
      
      updateCompetenceAllocationsList();
      updateTreatyPreview();
      updateCompetenceUtility();
    });
    
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.style.width = 'auto';
    btn.style.padding = '4px 8px';
    btn.style.margin = '0';
    btn.style.background = '#dc3545';
    btn.style.fontSize = '11px';
    btn.onclick = () => {
      // Phase 16: Remove bundle partner if needed
      const partner = getBundlePartner(alloc.competence);
      if (partner) {
        const partnerAlloc = state.competenceAllocations.find(a => a.competence === partner);
        if (partnerAlloc) {
          // Check if partner is still needed by other allocations
          const otherNeedsPartner = state.competenceAllocations.some(a => 
            a !== partnerAlloc && getBundlePartner(a.competence) === partner
          );
          if (!otherNeedsPartner) {
            state.competenceAllocations = state.competenceAllocations.filter(a => a !== partnerAlloc);
          }
        }
      }
      
      state.competenceAllocations = state.competenceAllocations.filter(a => a !== alloc);
      updateCompetenceAllocationsList();
      updateTreatyPreview();
      updateCompetenceUtility();
    };
    
    div.appendChild(selectComp);
    div.appendChild(selectHolder);
    div.appendChild(btn);
    list.appendChild(div);
  }
}

// Phase 16: Update peace status indicator
function updatePeaceStatus() {
  const statusDiv = document.getElementById('peace-status')!;
  const draft = buildDraft();
  
  if (!draft) {
    statusDiv.innerHTML = '<div class="info-box">No treaty draft</div>';
    return;
  }
  
  const wouldTrigger = wouldTriggerPeace(draft);
  const hasBrcko = hasBrckoResolution(draft);
  
  if (wouldTrigger) {
    if (hasBrcko) {
      statusDiv.innerHTML = '<div class="info-box" style="background: #d4edda; border-left-color: #28a745;"><strong>Peace-triggering treaty</strong><br>This treaty will trigger peace and end the war if accepted. Brčko resolution included.</div>';
    } else {
      statusDiv.innerHTML = '<div class="error-box"><strong>Peace-triggering treaty requires Brčko resolution</strong><br>This treaty will trigger peace, but it is missing brcko_special_status. It will be rejected (brcko_unresolved).<br><button id="add-brcko-btn" style="margin-top: 8px;">Add brcko_special_status</button></div>';
      
      // Add button handler
      const btn = document.getElementById('add-brcko-btn');
      if (btn) {
        btn.onclick = () => {
          state.hasBrckoClause = true;
          const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
          if (brckoToggle) brckoToggle.checked = true;
          updateLists();
          updateTreatyPreview();
        };
      }
    }
  } else {
    statusDiv.innerHTML = '<div class="info-box">This treaty does not trigger peace.</div>';
  }
}

// Phase 16: Update competence utility visualization
function updateCompetenceUtility() {
  const utilityDiv = document.getElementById('competence-utility')!;
  
  if (state.competenceAllocations.length === 0) {
    utilityDiv.innerHTML = '<div class="info-box">No competence allocations</div>';
    return;
  }
  
  const allocations = state.competenceAllocations.map(a => ({ competence: a.competence, holder: a.holder }));
  const factions: PoliticalSideId[] = ['RBiH', 'RS', 'HRHB'];
  
  let html = '<div class="info-box">';
  for (const faction of factions) {
    const utility = computeCompetenceUtility(allocations, faction as PoliticalSideId);
    html += `<strong>${faction}:</strong> ${utility >= 0 ? '+' : ''}${utility}<br>`;
  }
  html += '</div>';
  
  utilityDiv.innerHTML = html;
}

// Phase 17: Update treaty validation status
function updateTreatyValidation(evalReport: TreatyAcceptanceReport | null) {
  const validationDiv = document.getElementById('treaty-validation')!;
  
  if (!evalReport) {
    validationDiv.innerHTML = '<div class="info-box">No treaty draft to validate</div>';
    return;
  }
  
  if (evalReport.accepted_by_all_targets && !evalReport.rejection_reason) {
    validationDiv.innerHTML = '<div class="info-box" style="background: #d4edda; border-left-color: #28a745;"><strong>VALID</strong><br>No validation errors</div>';
    return;
  }
  
  // Invalid: show first rejection_reason
  const reason = evalReport.rejection_reason || 'unknown_rejection';
  validationDiv.innerHTML = `<div class="error-box"><strong>INVALID</strong><br>Rejection reason: ${reason}</div>`;
}

// Phase 17: Update acceptance breakdown
function updateAcceptanceBreakdown(evalReport: TreatyAcceptanceReport | null) {
  const breakdownDiv = document.getElementById('acceptance-breakdown')!;
  
  if (!evalReport) {
    breakdownDiv.innerHTML = '<div class="info-box">No treaty draft to evaluate</div>';
    return;
  }
  
  // Phase 17: Option 1 - if invalid, show message that acceptance not computed
  if (!evalReport.accepted_by_all_targets && evalReport.rejection_reason) {
    breakdownDiv.innerHTML = '<div class="info-box">Acceptance not computed (invalid treaty)</div>';
    return;
  }
  
  // Deterministic faction ordering: RBiH, RS, HRHB
  const factionOrder: PoliticalSideId[] = ['RBiH', 'RS', 'HRHB'];
  const sortedTargets = [...evalReport.per_target].sort((a, b) => {
    const aIdx = factionOrder.indexOf(a.faction_id as PoliticalSideId);
    const bIdx = factionOrder.indexOf(b.faction_id as PoliticalSideId);
    if (aIdx === -1 && bIdx === -1) return a.faction_id.localeCompare(b.faction_id);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });
  
  let html = '';
  
  // Deterministic breakdown field order
  const breakdownFieldOrder = [
    'total_score',
    'base_will',
    'pressure_factor',
    'reality_factor',
    'guarantee_factor',
    'cost_factor',
    'humiliation_factor',
    'warning_penalty',
    'heldness_factor',
    'trade_fairness_factor',
    'competence_factor'
  ] as const;
  
  for (const target of sortedTargets) {
    const acceptClass = target.accept ? 'info-box' : 'error-box';
    html += `<div class="${acceptClass}"><strong>${target.faction_id}</strong><br>`;
    
    // Render breakdown fields in deterministic order
    for (const field of breakdownFieldOrder) {
      const value = target.breakdown[field];
      if (value !== undefined) {
        const displayName = field === 'total_score' ? 'Total Score' :
          field === 'base_will' ? 'Base Will' :
          field === 'pressure_factor' ? 'Pressure Factor' :
          field === 'reality_factor' ? 'Reality Factor' :
          field === 'guarantee_factor' ? 'Guarantee Factor' :
          field === 'cost_factor' ? 'Cost Factor' :
          field === 'humiliation_factor' ? 'Humiliation Factor' :
          field === 'warning_penalty' ? 'Warning Penalty' :
          field === 'heldness_factor' ? 'Heldness Factor' :
          field === 'trade_fairness_factor' ? 'Trade Fairness Factor' :
          field === 'competence_factor' ? 'Competence Factor' : field;
        html += `${displayName}: ${value >= 0 ? '+' : ''}${value}<br>`;
      }
    }
    
    html += '</div>';
  }
  
  breakdownDiv.innerHTML = html || '<div class="info-box">No targets to evaluate</div>';
}

// Phase 18: Update treaty lint panel
function updateTreatyLint(evalReport: TreatyAcceptanceReport | null) {
  const lintDiv = document.getElementById('treaty-lint')!;
  
  if (!evalReport) {
    lintDiv.innerHTML = '<div class="info-box">No treaty draft to lint</div>';
    return;
  }
  
  const draft = buildDraft();
  if (!draft) {
    lintDiv.innerHTML = '<div class="info-box">No treaty draft to lint</div>';
    return;
  }
  
  const messages: string[] = [];
  
  // Lint rule 1: Peace will end the war warning
  const wouldTrigger = wouldTriggerPeace(draft);
  if (wouldTrigger) {
    messages.push('⚠️ Peace will end the war');
  }
  
  // Lint rule 2: Brčko required warning
  const hasBrcko = hasBrckoResolution(draft);
  if (wouldTrigger && !hasBrcko) {
    messages.push('⚠️ Brčko required (peace-triggering treaty must include brcko_special_status)');
  }
  
  // Lint rule 3: Bundle completion warning
  const allocations = state.competenceAllocations.map(a => ({ competence: a.competence, holder: a.holder }));
  const competenceMap = new Map<string, string>();
  for (const alloc of allocations) {
    competenceMap.set(alloc.competence, alloc.holder);
  }
  
  for (const constraint of ACCEPTANCE_CONSTRAINTS) {
    if (constraint.type === 'require_bundle') {
      const present = constraint.competences.filter(c => competenceMap.has(c));
      if (present.length > 0 && present.length < constraint.competences.length) {
        messages.push(`⚠️ Bundle completion: ${constraint.competences.join(', ')} must all be allocated together`);
      }
      if (present.length === constraint.competences.length) {
        const holders = new Set<string>();
        for (const comp of constraint.competences) {
          const holder = competenceMap.get(comp);
          if (holder) holders.add(holder);
        }
        if (holders.size > 1) {
          messages.push(`⚠️ Bundle split: ${constraint.competences.join(', ')} must be allocated to the same holder`);
        }
      }
    }
  }
  
  // Lint rule 4: Negative utility red flag (threshold: -10)
  const NEGATIVE_UTILITY_THRESHOLD = -10;
  const factions: PoliticalSideId[] = ['RBiH', 'RS', 'HRHB'];
  for (const faction of factions) {
    const utility = computeCompetenceUtility(allocations, faction as PoliticalSideId);
    if (utility <= NEGATIVE_UTILITY_THRESHOLD) {
      messages.push(`🔴 Red flag: competence utility strongly negative for ${faction} (${utility})`);
    }
  }
  
  // Lint rule 5: Acceptance weakness warning (only if valid and breakdown computed)
  // Note: We don't have a threshold constant in the engine, so we'll skip this rule
  // as per instructions: "If no threshold exists in engine, omit this lint rule"
  
  // Render messages in deterministic order
  if (messages.length === 0) {
    lintDiv.innerHTML = '<div class="info-box">No lint issues found</div>';
    return;
  }
  
  let html = '';
  for (const msg of messages) {
    html += `<div class="warning-box">${msg}</div>`;
  }
  lintDiv.innerHTML = html;
}

// Phase 12D.2: Update imported clauses display
function updateImportedClausesList() {
  const importedList = document.getElementById('imported-clauses-list')!;
  importedList.innerHTML = '';
  
  if (state.importedClauses.length === 0) {
    importedList.innerHTML = '<div class="info-box">No imported clauses</div>';
    return;
  }
  
  for (const clause of state.importedClauses) {
    const div = document.createElement('div');
    div.className = 'list-item';
    
    let text = `${clause.annex}:${clause.kind}`;
    if (clause.scope.kind === 'settlements' && clause.scope.sids.length > 0) {
      text += ` (${clause.scope.sids.length} settlements)`;
    }
    
    // Phase 12D.2: Show deprecated badge
    if (isClauseDeprecated(clause.kind)) {
      const badge = document.createElement('span');
      badge.className = 'deprecated-badge';
      badge.textContent = 'DEPRECATED';
      div.appendChild(document.createTextNode(text));
      div.appendChild(badge);
    } else {
      div.textContent = text;
    }
    
    // Phase 12D.2: Show invalid badge for non-canonical brcko clauses
    if (clause.kind === 'brcko_special_status') {
      const validation = validateBrckoSids(clause);
      if (!validation.valid) {
        const badge = document.createElement('span');
        badge.className = 'invalid-badge';
        badge.textContent = 'INVALID';
        badge.title = validation.error || 'Invalid Brčko clause';
        div.appendChild(badge);
      }
    }
    
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.onclick = () => {
      state.importedClauses = state.importedClauses.filter(c => c.id !== clause.id);
      updateImportedClausesList();
      updateTreatyPreview();
    };
    div.appendChild(btn);
    importedList.appendChild(div);
  }
}

// Phase 12D.2: Validate imported brcko clause sids
function validateBrckoSids(clause: TreatyClause): { valid: boolean; error?: string } {
  if (clause.kind !== 'brcko_special_status') {
    return { valid: true };
  }
  
  const expectedSids = BRCKO_SIDS.map(String).sort();
  
  if (clause.sids && Array.isArray(clause.sids)) {
    const clauseSids = clause.sids.map(String).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (clauseSids.length !== expectedSids.length || !clauseSids.every((sid, i) => sid === expectedSids[i])) {
      return { valid: false, error: `Brčko clause sids must match canonical set (${expectedSids.length} settlements) or be omitted` };
    }
  }
  
  return { valid: true };
}

// Phase 16: Get bundle partner for a competence
function getBundlePartner(competence: CompetenceId): CompetenceId | null {
  for (const constraint of ACCEPTANCE_CONSTRAINTS) {
    if (constraint.type === 'require_bundle' && constraint.competences.includes(competence)) {
      const partner = constraint.competences.find(c => c !== competence);
      return partner || null;
    }
  }
  return null;
}

// Phase 16: Check if treaty would trigger peace
function wouldTriggerPeace(draft: TreatyDraft | null): boolean {
  if (!draft) return false;
  const peaceTriggeringKinds = ['transfer_settlements', 'recognize_control_settlements', 'brcko_special_status'] as const;
  return draft.clauses.some(c => peaceTriggeringKinds.includes(c.kind as (typeof peaceTriggeringKinds)[number]));
}

// Phase 16: Check if treaty has brcko resolution
function hasBrckoResolution(draft: TreatyDraft | null): boolean {
  if (!draft) return false;
  return draft.clauses.some(c => c.kind === 'brcko_special_status');
}

// Build treaty draft from current state
function buildDraft(): TreatyDraft | null {
  if (!state.gameState || !state.settlementsGraph) return null;
  
  const clauses: TreatyClause[] = [];
  const turn = state.gameState.meta.turn;
  
  // Compute valuation if we have transfers
  let valuation: TerritorialValuationReport | undefined;
  if (state.demandSids.size > 0 || state.concedeSids.size > 0) {
    valuation = computeSettlementValues(state.gameState, state.settlementsGraph);
  }
  
  // Demand clauses (giver = counterparty, receiver = proposer)
  if (state.demandSids.size > 0) {
    const sids = Array.from(state.demandSids).sort();
    const scope: TreatyScope = { kind: 'settlements', sids };
    const clause = createClause(
      `CLAUSE_DEMAND_${sids.join('_')}`,
      'territorial',
      'transfer_settlements',
      state.proposerSide,
      [state.counterpartySide],
      scope,
      undefined,
      state.counterpartySide,
      state.proposerSide,
      undefined,
      valuation ? { valuation, giver_side: state.counterpartySide, receiver_side: state.proposerSide } : undefined
    );
    clauses.push(clause);
  }
  
  // Concede clauses (giver = proposer, receiver = counterparty)
  if (state.concedeSids.size > 0) {
    const sids = Array.from(state.concedeSids).sort();
    const scope: TreatyScope = { kind: 'settlements', sids };
    const clause = createClause(
      `CLAUSE_CONCEDE_${sids.join('_')}`,
      'territorial',
      'transfer_settlements',
      state.proposerSide,
      [state.counterpartySide],
      scope,
      undefined,
      state.proposerSide,
      state.counterpartySide,
      undefined,
      valuation ? { valuation, giver_side: state.proposerSide, receiver_side: state.counterpartySide } : undefined
    );
    clauses.push(clause);
  }
  
  // Phase 12D.2: Brčko special status clause
  if (state.hasBrckoClause) {
    const scope: TreatyScope = { kind: 'settlements', sids: BRCKO_SIDS.map(String) };
    const clause = createClause(
      'CLAUSE_BRCKO_SPECIAL_STATUS',
      'territorial',
      'brcko_special_status',
      state.proposerSide,
      [state.counterpartySide],
      scope,
      undefined,
      undefined,
      undefined,
      undefined
    );
    // Phase 12D.2: Prefer exporting without sids field (canonical) - sids in scope is fine, but clause.sids should be undefined
    // The scope contains the sids for the clause library to compute costs, but we don't set clause.sids
    clauses.push(clause);
  }
  
  // Phase 16: Competence allocation clauses
  for (const alloc of state.competenceAllocations) {
    const scope: TreatyScope = { kind: 'global' };
    const clause = createClause(
      `CLAUSE_COMPETENCE_${alloc.competence}`,
      'institutional',
      'allocate_competence',
      state.proposerSide,
      [state.counterpartySide],
      scope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alloc.competence,
      alloc.holder
    );
    clauses.push(clause);
  }
  
  // Phase 12D.2: Include imported clauses (excluding deprecated ones that user removed)
  // Note: We'll filter deprecated clauses in the UI display, but keep them in importedClauses
  // for viewing. They won't be included in new exports.
  
  if (clauses.length === 0 && state.importedClauses.length === 0) return null;
  
  return buildTreatyDraft(turn, state.proposerSide, clauses);
}

// Update treaty preview
function updateTreatyPreview() {
  const preview = document.getElementById('treaty-preview')!;
  preview.innerHTML = '';
  
  if (!state.gameState || !state.settlementsGraph) {
    preview.innerHTML = '<div class="info-box">Load a save file to see treaty preview</div>';
    return;
  }
  
  // Phase 12D.2: Validate imported clauses
  const validationErrors: string[] = [];
  for (const clause of state.importedClauses) {
    if (clause.kind === 'brcko_special_status') {
      const validation = validateBrckoSids(clause);
      if (!validation.valid && validation.error) {
        validationErrors.push(`Invalid Brčko clause (${clause.id}): ${validation.error}`);
      }
    }
  }
  
  // Phase 16: Validate Brčko completeness for peace-triggering treaties
  const draft = buildDraft();
  if (draft) {
    const wouldTrigger = wouldTriggerPeace(draft);
    const hasBrcko = hasBrckoResolution(draft);
    if (wouldTrigger && !hasBrcko) {
      validationErrors.push('Peace-triggering treaty requires brcko_special_status. Otherwise it will be rejected (brcko_unresolved).');
    }
  }
  
  // Phase 16: Validate competence bundles
  const allocations = state.competenceAllocations.map(a => ({ competence: a.competence, holder: a.holder }));
  const competenceMap = new Map<string, string>();
  for (const alloc of allocations) {
    competenceMap.set(alloc.competence, alloc.holder);
  }
  
  for (const constraint of ACCEPTANCE_CONSTRAINTS) {
    if (constraint.type === 'require_bundle') {
      const present = constraint.competences.filter(c => competenceMap.has(c));
      if (present.length > 0 && present.length < constraint.competences.length) {
        validationErrors.push(`Competence bundle incomplete: ${constraint.competences.join(', ')} must all be allocated together.`);
      }
      if (present.length === constraint.competences.length) {
        const holders = new Set<string>();
        for (const comp of constraint.competences) {
          const holder = competenceMap.get(comp);
          if (holder) holders.add(holder);
        }
        if (holders.size > 1) {
          validationErrors.push(`Competence bundle split across holders: ${constraint.competences.join(', ')} must be allocated to the same holder.`);
        }
      }
    }
  }
  
  if (validationErrors.length > 0) {
    preview.innerHTML = '<div class="error-box"><strong>Export Blocked:</strong><br>' + 
      validationErrors.join('<br>') + 
      '<br><br>Please fix these issues before exporting.</div>';
    // Phase 17: Still try to compute eval report for validation/breakdown display
    const draft = buildDraft();
    if (draft && state.gameState && state.settlementsGraph) {
      const frontEdges = computeFrontEdges(state.gameState, state.settlementsGraph.edges);
      const evalReport = evaluateTreatyAcceptance(
        state.gameState,
        draft,
        frontEdges,
        undefined,
        state.settlementsGraph
      );
      updateTreatyValidation(evalReport);
      updateAcceptanceBreakdown(evalReport);
    } else {
      updateTreatyValidation(null);
      updateAcceptanceBreakdown(null);
      updateTreatyLint(null);
    }
    return;
  }

  if (!draft) {
    preview.innerHTML = '<div class="info-box">Add settlements to demand or concede lists, enable special clauses, or add competence allocations</div>';
    // Phase 17: Update validation and breakdown even when no draft
    updateTreatyValidation(null);
    updateAcceptanceBreakdown(null);
    updateTreatyLint(null);
    return;
  }
  
  // Compute acceptance
  const frontEdges = computeFrontEdges(state.gameState, state.settlementsGraph.edges);
  const evalReport = evaluateTreatyAcceptance(
    state.gameState,
    draft,
    frontEdges,
    undefined, // formation fatigue report
    state.settlementsGraph
  );
  
  // Show cost and capital
  const proposerFaction = state.gameState.factions.find(f => f.id === state.proposerSide);
  const capital = proposerFaction?.negotiation?.capital ?? 0;
  const cost = draft.totals.cost_total;
  const capitalAfter = capital - cost;
  
  let html = `<div class="info-box">
    <strong>Cost Total:</strong> ${cost}<br>
    <strong>Proposer Capital:</strong> ${capital}<br>
    <strong>Capital After Spend:</strong> ${capitalAfter}
  </div>`;
  
  if (capitalAfter < 0) {
    html += `<div class="error-box">Insufficient capital! Need ${cost}, have ${capital}</div>`;
  }
  
  // Phase 12D.2: Show deprecated clause warning
  const deprecatedClauses = draft.clauses.filter(c => isClauseDeprecated(c.kind));
  if (deprecatedClauses.length > 0) {
    html += `<div class="warning-box"><strong>Note:</strong> This draft contains ${deprecatedClauses.length} deprecated clause(s). They will be excluded from export.</div>`;
  }
  
  // Show acceptance preview
  html += '<h3>Acceptance Preview</h3>';
  for (const target of evalReport.per_target) {
    const acceptClass = target.accept ? 'info-box' : 'error-box';
    html += `<div class="${acceptClass}">
      <strong>${target.faction_id}:</strong> ${target.accept ? 'ACCEPTS' : 'REJECTS'}<br>
      Score: ${target.breakdown.total_score}<br>
      Breakdown: BaseWill=${target.breakdown.base_will}, 
      Pressure=${target.breakdown.pressure_factor}, 
      Reality=${target.breakdown.reality_factor}, 
      Guarantee=${target.breakdown.guarantee_factor}, 
      Cost=${target.breakdown.cost_factor}, 
      Humiliation=${target.breakdown.humiliation_factor}, 
      Warning=${target.breakdown.warning_penalty}, 
      Heldness=${target.breakdown.heldness_factor}, 
      TradeFairness=${target.breakdown.trade_fairness_factor},
      Competence=${target.breakdown.competence_factor || 0}
    </div>`;
  }
  
  // Show warnings
  if (draft.package_warnings.length > 0) {
    html += '<h3>Package Warnings</h3>';
    for (const warning of draft.package_warnings) {
      html += `<div class="warning-box">${warning}</div>`;
    }
  }
  
  preview.innerHTML = html;
  
  // Phase 16: Update peace status and competence utility after preview update
  updatePeaceStatus();
  updateCompetenceUtility();
  
  // Phase 17: Update validation and acceptance breakdown
  updateTreatyValidation(evalReport);
  updateAcceptanceBreakdown(evalReport);
  
  // Phase 18: Update treaty lint
  updateTreatyLint(evalReport);
}

// Phase 12D.2: Deterministic clause sorting for export
function sortClausesForExport(clauses: TreatyClause[]): TreatyClause[] {
  return [...clauses].sort((a, b) => {
    // Primary: clause type string
    const kindDiff = a.kind.localeCompare(b.kind);
    if (kindDiff !== 0) return kindDiff;
    
    // Secondary: if clause includes sids, compare by joined sorted sids string
    if (a.scope.kind === 'settlements' && b.scope.kind === 'settlements') {
      const aSids = [...a.scope.sids].sort().join('|');
      const bSids = [...b.scope.sids].sort().join('|');
      const sidsDiff = aSids.localeCompare(bSids);
      if (sidsDiff !== 0) return sidsDiff;
    }
    
    // Tertiary: annex
    const annexDiff = a.annex.localeCompare(b.annex);
    if (annexDiff !== 0) return annexDiff;
    
    // Final: id
    return a.id.localeCompare(b.id);
  });
}

// Export clause specs
function exportClauseSpecs(): string {
  const draft = buildDraft();
  if (!draft) return '';
  
  const specs: string[] = [];
  // Phase 12D.2: Sort clauses deterministically
  const sortedClauses = sortClausesForExport(draft.clauses);
  
  for (const clause of sortedClauses) {
    // Phase 12D.2: Skip deprecated clauses in export
    if (isClauseDeprecated(clause.kind)) {
      continue;
    }
    
    let spec = `${clause.annex}:${clause.kind}:${clause.target_faction_ids.join('|')}:`;
    
    if (clause.scope.kind === 'settlements') {
      // Phase 12D.2: For brcko_special_status, if clause.sids is undefined (canonical), export empty sids list
      // Otherwise export the scope.sids (which should match BRCKO_SIDS)
      if (clause.kind === 'brcko_special_status' && !clause.sids) {
        spec += 'settlements:'; // Empty sids list (canonical - scope.sids is used by engine)
      } else {
        // Phase 12D.2: Ensure sids are sorted and unique
        const sortedSids = Array.from(new Set(clause.scope.sids)).sort();
        spec += `settlements:${sortedSids.join('|')}`;
      }
    } else if (clause.scope.kind === 'global') {
      spec += 'global:';
    } else if (clause.scope.kind === 'region') {
      spec += `region:${clause.scope.region_id}`;
    } else if (clause.scope.kind === 'edges') {
      // Phase 12D.2: Ensure edge_ids are sorted and unique
      const sortedEdgeIds = Array.from(new Set(clause.scope.edge_ids)).sort();
      spec += `edges:${sortedEdgeIds.join('|')}`;
    } else if (clause.scope.kind === 'municipalities') {
      // Phase 12D.2: Ensure mun_ids are sorted and unique
      const sortedMunIds = Array.from(new Set(clause.scope.mun_ids)).sort();
      spec += `municipalities:${sortedMunIds.join('|')}`;
    }
    
    if (clause.giver_side) {
      spec += `:giver=${clause.giver_side}`;
    }
    if (clause.receiver_side) {
      spec += `:receiver=${clause.receiver_side}`;
    }
    if (clause.beneficiary) {
      spec += `:beneficiary=${clause.beneficiary}`;
    }
    // Phase 16: Add competence and holder for allocate_competence clauses
    if (clause.competence) {
      spec += `:competence=${clause.competence}`;
    }
    if (clause.holder) {
      spec += `:holder=${clause.holder}`;
    }
    
    specs.push(spec);
  }
  
  // Sort deterministically
  specs.sort();
  return specs.join('\n');
}

// Phase 12D.2: Normalize clause for export (remove sids from brcko if canonical)
function normalizeClauseForExport(clause: TreatyClause): TreatyClause {
  if (clause.kind === 'brcko_special_status') {
    // Prefer exporting without sids field (canonical)
    // The scope.sids contains the settlement list, but clause.sids should be undefined for canonical export
    const normalized = { ...clause };
    if (normalized.sids) {
      const expectedSids = BRCKO_SIDS.map(String).sort();
      const clauseSids = normalized.sids.map(String).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      if (clauseSids.length === expectedSids.length && clauseSids.every((sid, i) => sid === expectedSids[i])) {
        // Matches canonical set, remove sids field (scope.sids remains)
        delete (normalized as any).sids;
      }
    }
    return normalized;
  }
  return clause;
}

// Export treaty draft JSON
function exportTreatyDraft(): string {
  const draft = buildDraft();
  if (!draft) return '{}';
  
  // Phase 12D.2: Filter out deprecated clauses and normalize brcko clauses
  const exportClauses = draft.clauses
    .filter(c => !isClauseDeprecated(c.kind))
    .map(normalizeClauseForExport);
  
  // Phase 12D.2: Sort clauses deterministically
  const sortedClauses = sortClausesForExport(exportClauses);
  
  // Phase 12D.2: Rebuild draft with filtered and sorted clauses
  const exportDraft: TreatyDraft = {
    ...draft,
    clauses: sortedClauses
  };
  
  return JSON.stringify(exportDraft, null, 2);
}

// Event handlers
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  const sid = findSettlementAt(x, y);
  if (!sid) return;
  
  if (state.mode === 'demand') {
    state.demandSids.add(sid);
    state.concedeSids.delete(sid);
  } else {
    state.concedeSids.add(sid);
    state.demandSids.delete(sid);
  }
  
  updateLists();
  updateTreatyPreview();
  render();
});

// Zoom and pan
let isDragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});

canvas.addEventListener('mousemove', (e) => {
  if (isDragging) {
    state.panX += e.clientX - lastX;
    state.panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  isDragging = false;
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  state.zoom *= delta;
  state.zoom = Math.max(0.1, Math.min(10, state.zoom));
  render();
});

// UI controls
document.getElementById('proposer-side')!.addEventListener('change', (e) => {
  state.proposerSide = (e.target as HTMLSelectElement).value as PoliticalSideId;
  updateTreatyPreview();
});

document.getElementById('counterparty-side')!.addEventListener('change', (e) => {
  state.counterpartySide = (e.target as HTMLSelectElement).value as PoliticalSideId;
  updateTreatyPreview();
});

document.getElementById('mode')!.addEventListener('change', (e) => {
  state.mode = (e.target as HTMLSelectElement).value as 'demand' | 'concede';
});

document.getElementById('file-input')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  
  try {
    state.gameState = await loadSave(file);
    document.getElementById('save-status')!.textContent = `Loaded: Turn ${state.gameState.meta.turn}`;
    
    // Rebuild settlements graph with loaded state
    const settlements = await loadSettlementsIndex();
    const edges = await loadSettlementEdges();
    state.settlementsGraph = { settlements, edges };
    
    updateTreatyPreview();
  } catch (err) {
    document.getElementById('save-status')!.textContent = `Error: ${err}`;
  }
});

// Phase 12D.2: Load treaty draft
document.getElementById('draft-input')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const draft: TreatyDraft = JSON.parse(text);
    
    if (draft.schema !== 1) {
      throw new Error(`Unsupported treaty draft schema: ${draft.schema}`);
    }
    
    // Phase 12D.2: Extract clauses from draft
    state.importedClauses = draft.clauses;
    
    // Phase 12D.2: Check if draft has brcko clause
    const brckoClause = draft.clauses.find(c => c.kind === 'brcko_special_status');
    state.hasBrckoClause = !!brckoClause;
    
    // Phase 12D.2: Update proposer/counterparty from draft if available
    if (draft.proposer_faction_id) {
      state.proposerSide = draft.proposer_faction_id as PoliticalSideId;
      const proposerSelect = document.getElementById('proposer-side') as HTMLSelectElement;
      if (proposerSelect) proposerSelect.value = state.proposerSide;
    }
    
    updateLists();
    updateTreatyPreview();
  } catch (err) {
    alert(`Error loading draft: ${err}`);
  }
});

// Phase 12D.2: Brčko toggle handler
document.getElementById('brcko-toggle')!.addEventListener('change', (e) => {
  state.hasBrckoClause = (e.target as HTMLInputElement).checked;
  updateTreatyPreview();
});

document.getElementById('copy-clauses')!.addEventListener('click', () => {
  // Phase 16: Check for validation errors before export
  const validationErrors: string[] = [];
  for (const clause of state.importedClauses) {
    if (clause.kind === 'brcko_special_status') {
      const validation = validateBrckoSids(clause);
      if (!validation.valid && validation.error) {
        validationErrors.push(validation.error);
      }
    }
  }
  
  // Phase 16: Check Brčko completeness
  const draft = buildDraft();
  if (draft) {
    const wouldTrigger = wouldTriggerPeace(draft);
    const hasBrcko = hasBrckoResolution(draft);
    if (wouldTrigger && !hasBrcko) {
      validationErrors.push('Peace-triggering treaty requires brcko_special_status.');
    }
  }
  
  if (validationErrors.length > 0) {
    alert('Cannot export: ' + validationErrors.join(' '));
    return;
  }
  
  const specs = exportClauseSpecs();
  if (!specs) {
    alert('No clauses to export. Add clauses first.');
    return;
  }
  navigator.clipboard.writeText(specs);
  alert('Clause specs copied to clipboard!');
});

document.getElementById('save-draft')!.addEventListener('click', () => {
  // Phase 16: Check for validation errors before export
  const validationErrors: string[] = [];
  for (const clause of state.importedClauses) {
    if (clause.kind === 'brcko_special_status') {
      const validation = validateBrckoSids(clause);
      if (!validation.valid && validation.error) {
        validationErrors.push(validation.error);
      }
    }
  }
  
  // Phase 16: Check Brčko completeness
  const draft = buildDraft();
  if (draft) {
    const wouldTrigger = wouldTriggerPeace(draft);
    const hasBrcko = hasBrckoResolution(draft);
    if (wouldTrigger && !hasBrcko) {
      validationErrors.push('Peace-triggering treaty requires brcko_special_status.');
    }
  }
  
  if (validationErrors.length > 0) {
    alert('Cannot export: ' + validationErrors.join(' '));
    return;
  }
  
  const json = exportTreatyDraft();
  if (json === '{}') {
    alert('No clauses to export. Add clauses first.');
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'treaty_draft.json';
  a.click();
  URL.revokeObjectURL(url);
});

// Phase 16: Add competence button handler
document.getElementById('add-competence')!.addEventListener('click', () => {
  // Add first available competence with default holder
  const usedCompetences = new Set(state.competenceAllocations.map(a => a.competence));
  const available = ALL_COMPETENCES.find(c => !usedCompetences.has(c));
  if (available) {
    state.competenceAllocations.push({
      competence: available,
      holder: state.proposerSide
    });
    
    // Phase 16: Auto-add bundle partner if needed
    const partner = getBundlePartner(available);
    if (partner && !usedCompetences.has(partner)) {
      state.competenceAllocations.push({
        competence: partner,
        holder: state.proposerSide
      });
    }
    
    updateCompetenceAllocationsList();
    updateTreatyPreview();
    updateCompetenceUtility();
  }
});

// Phase 18: Get preset target holder from UI
function getPresetHolder(): PoliticalSideId {
  const select = document.getElementById('preset-holder') as HTMLSelectElement;
  return (select?.value as PoliticalSideId) || 'RBiH';
}

// Phase 18: Preset 1: Blank (reset)
function applyPresetBlank() {
  state.demandSids.clear();
  state.concedeSids.clear();
  state.hasBrckoClause = false;
  state.competenceAllocations = [];
  state.importedClauses = [];
  
  const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
  if (brckoToggle) brckoToggle.checked = false;
  
  updateLists();
  updateTreatyPreview();
  render();
}

// Phase 18: Preset 2: Minimal peace (territory + Brčko)
function applyPresetMinimalPeace() {
  // Clear existing
  state.demandSids.clear();
  state.concedeSids.clear();
  state.competenceAllocations = [];
  
  // Add a minimal recognize_control_settlements clause
  // Use empty list (rely on recognize_control_settlements semantics if allowed)
  // OR use smallest deterministic set from current draft if available
  // For now, we'll use an empty recognize clause (which may be invalid, but that's OK for a skeleton)
  // Actually, let's use a small deterministic set: if gameState exists, pick first 3 controlled settlements by proposer
  if (state.gameState && state.settlementsGraph) {
    const proposerFaction = state.gameState.factions.find(f => f.id === state.proposerSide);
    if (proposerFaction && proposerFaction.areasOfResponsibility.length > 0) {
      // Use first 3 settlements from proposer's AoR (deterministic)
      const sids = proposerFaction.areasOfResponsibility.slice(0, 3).sort();
      for (const sid of sids) {
        state.demandSids.add(sid);
      }
    }
  }
  
  // MUST include brcko_special_status
  state.hasBrckoClause = true;
  const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
  if (brckoToggle) brckoToggle.checked = true;
  
  updateLists();
  updateTreatyPreview();
  render();
}

// Phase 18: Preset 3: Competences-only (no peace)
function applyPresetCompetencesOnly() {
  // Clear territorial clauses
  state.demandSids.clear();
  state.concedeSids.clear();
  state.hasBrckoClause = false;
  
  const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
  if (brckoToggle) brckoToggle.checked = false;
  
  // Add canonical competence bundles
  const holder = getPresetHolder();
  state.competenceAllocations = [];
  
  // Customs bundle
  state.competenceAllocations.push({ competence: 'customs', holder });
  state.competenceAllocations.push({ competence: 'indirect_taxation', holder });
  
  // Defence bundle
  state.competenceAllocations.push({ competence: 'defence_policy', holder });
  state.competenceAllocations.push({ competence: 'armed_forces_command', holder });
  
  // Sort allocations deterministically
  state.competenceAllocations.sort((a, b) => {
    const compDiff = a.competence.localeCompare(b.competence);
    if (compDiff !== 0) return compDiff;
    return a.holder.localeCompare(b.holder);
  });
  
  updateLists();
  updateTreatyPreview();
  render();
}

// Phase 18: Preset 4: Balanced offer (peace + competences)
function applyPresetBalanced() {
  // Apply minimal peace first
  applyPresetMinimalPeace();
  
  // Then add competences
  const holder = getPresetHolder();
  
  // Add bundles if not already present
  const hasCustoms = state.competenceAllocations.some(a => a.competence === 'customs');
  const hasIndirectTax = state.competenceAllocations.some(a => a.competence === 'indirect_taxation');
  const hasDefencePolicy = state.competenceAllocations.some(a => a.competence === 'defence_policy');
  const hasArmedForces = state.competenceAllocations.some(a => a.competence === 'armed_forces_command');
  
  if (!hasCustoms) {
    state.competenceAllocations.push({ competence: 'customs', holder });
  }
  if (!hasIndirectTax) {
    state.competenceAllocations.push({ competence: 'indirect_taxation', holder });
  }
  if (!hasDefencePolicy) {
    state.competenceAllocations.push({ competence: 'defence_policy', holder });
  }
  if (!hasArmedForces) {
    state.competenceAllocations.push({ competence: 'armed_forces_command', holder });
  }
  
  // Ensure bundle partners have same holder
  for (const alloc of state.competenceAllocations) {
    const partner = getBundlePartner(alloc.competence);
    if (partner) {
      const partnerAlloc = state.competenceAllocations.find(a => a.competence === partner);
      if (partnerAlloc) {
        partnerAlloc.holder = alloc.holder;
      } else {
        state.competenceAllocations.push({ competence: partner, holder: alloc.holder });
      }
    }
  }
  
  // Sort allocations deterministically
  state.competenceAllocations.sort((a, b) => {
    const compDiff = a.competence.localeCompare(b.competence);
    if (compDiff !== 0) return compDiff;
    return a.holder.localeCompare(b.holder);
  });
  
  updateLists();
  updateTreatyPreview();
  render();
}

// Phase 18: Preset 5: Status quo / recognize control (peace)
function applyPresetStatusQuo() {
  // Clear existing
  state.demandSids.clear();
  state.concedeSids.clear();
  state.competenceAllocations = [];
  
  // Create recognize_control_settlements for all currently controlled settlements
  // Note: UI uses demand/concede lists for transfer_settlements, but for status quo
  // we want recognize_control_settlements. We'll add settlements to demand list as a starting point,
  // and user can manually change clause type if needed via imported clauses.
  if (state.gameState && state.settlementsGraph) {
    // Get all settlements controlled by proposer (AoR) - deterministic
    const proposerFaction = state.gameState.factions.find(f => f.id === state.proposerSide);
    if (proposerFaction && proposerFaction.areasOfResponsibility.length > 0) {
      // Use first 10 settlements from proposer's AoR (deterministic, capped for reasonable size)
      const sids = proposerFaction.areasOfResponsibility.slice(0, 10).sort();
      for (const sid of sids) {
        state.demandSids.add(sid);
      }
    }
  }
  
  // MUST include brcko_special_status
  state.hasBrckoClause = true;
  const brckoToggle = document.getElementById('brcko-toggle') as HTMLInputElement;
  if (brckoToggle) brckoToggle.checked = true;
  
  updateLists();
  updateTreatyPreview();
  render();
}

// Phase 18: Preset button handlers
document.getElementById('preset-blank')!.addEventListener('click', applyPresetBlank);
document.getElementById('preset-minimal-peace')!.addEventListener('click', applyPresetMinimalPeace);
document.getElementById('preset-competences-only')!.addEventListener('click', applyPresetCompetencesOnly);
document.getElementById('preset-balanced')!.addEventListener('click', applyPresetBalanced);
document.getElementById('preset-status-quo')!.addEventListener('click', applyPresetStatusQuo);

// Initialize
async function init() {
  state.polygons = await loadPolygons();
  state.bounds = computeBounds(state.polygons);
  
  // Try to load settlements graph (for valuation)
  try {
    const settlements = await loadSettlementsIndex();
    const edges = await loadSettlementEdges();
    state.settlementsGraph = { settlements, edges };
  } catch (err) {
    console.warn('Could not load settlements graph:', err);
  }
  
  render();
  updateLists();
  updateTreatyPreview();
}

init();
