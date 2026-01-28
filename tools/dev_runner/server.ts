#!/usr/bin/env node

/**
 * Dev Runner: Minimal HTTP server exposing raw GameState
 * 
 * This is an engine adapter with no UI. It provides HTTP endpoints to:
 * - GET /state: return current GameState as JSON
 * - POST /step: advance exactly one turn via canonical turn pipeline
 * - POST /reset: restore initial scenario state
 * 
 * No game logic exists in this file. All mutations occur through the existing turn pipeline.
 * Determinism is preserved (no timestamps, no randomness).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { executeTurn } from '../../src/turn/pipeline.js';
import { GameState, CURRENT_SCHEMA_VERSION, PostureLevel } from '../../src/state/game_state.js';
import { serializeState } from '../../src/state/serialize.js';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard.js';
import { canonicalizePoliticalSideId } from '../../src/state/identity.js';

// Mistake guard: ensure dev runner does not contain game logic
const mistakes = loadMistakes();
assertNoRepeat("dev runner must not contain game logic and must expose raw GameState only");
assertNoRepeat("phase5a posture exposure must not introduce new mechanics or bypass command friction");

// Minimal initial GameState (matches src/index.ts pattern)
function createInitialState(): GameState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    meta: {
      turn: 0,
      seed: 'dev-runner-seed'
    },
    factions: [],
    formations: {},
    front_segments: {},
    front_posture: {},
    front_posture_regions: {},
    front_pressure: {},
    militia_pools: {}
  };
}

// In-memory state storage
let currentState: GameState = createInitialState();
const initialState: GameState = createInitialState();

// Request logging (optional, off by default - can be enabled via env var)
const ENABLE_LOGGING = process.env.DEV_RUNNER_LOG === 'true';

function log(message: string): void {
  if (ENABLE_LOGGING) {
    console.log(`[dev-runner] ${message}`);
  }
}

// HTTP request handler
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // CORS headers for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle GET and OPTIONS immediately (no body needed)
  if (method === 'GET' || method === 'OPTIONS') {
    handleRequestWithBody(req, res, method, url, '');
    return;
  }
  
  // Parse request body for POST requests
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    handleRequestWithBody(req, res, method, url, body);
  });
}

function handleRequestWithBody(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  body: string
): void {

  // Handle OPTIONS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Route handling
  if (method === 'GET' && url === '/state') {
    log(`GET /state (turn ${currentState.meta.turn})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(serializeState(currentState));
    return;
  }

  if (method === 'POST' && url === '/step') {
    log(`POST /step (turn ${currentState.meta.turn} -> ${currentState.meta.turn + 1})`);
    try {
      // Advance exactly one turn via canonical turn pipeline
      currentState = executeTurn(currentState, { seed: currentState.meta.seed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(serializeState(currentState));
    } catch (error) {
      log(`Error in /step: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (method === 'POST' && url === '/reset') {
    log(`POST /reset (restoring initial state)`);
    // Restore initial state by cloning (preserve determinism)
    currentState = JSON.parse(JSON.stringify(initialState)) as GameState;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(serializeState(currentState));
    return;
  }

  if (method === 'POST' && url === '/set_posture') {
    log(`POST /set_posture`);
    try {
      const payload = body ? JSON.parse(body) : {};
      const { faction_id, edge_id, posture, weight } = payload;
      
      // Validate required fields
      if (!faction_id || typeof faction_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid faction_id' }));
        return;
      }
      if (!edge_id || typeof edge_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid edge_id' }));
        return;
      }
      if (!posture || (posture !== 'hold' && posture !== 'probe' && posture !== 'push')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid posture (must be hold|probe|push)' }));
        return;
      }
      
      // Validate edge_id format (canonical a__b with a < b)
      const parts = edge_id.split('__');
      if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] >= parts[1]) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid edge_id format (expected a__b with a < b)' }));
        return;
      }
      
      // Canonicalize faction ID
      const canonicalFaction = canonicalizePoliticalSideId(faction_id);
      
      // Ensure front_posture structure exists
      if (!currentState.front_posture || typeof currentState.front_posture !== 'object') {
        currentState.front_posture = {};
      }
      if (!currentState.front_posture[canonicalFaction]) {
        currentState.front_posture[canonicalFaction] = { assignments: {} };
      }
      if (!currentState.front_posture[canonicalFaction].assignments) {
        currentState.front_posture[canonicalFaction].assignments = {};
      }
      
      // Set posture assignment (takes effect on next turn)
      const postureWeight = Number.isInteger(weight) && weight >= 0 ? weight : 0;
      currentState.front_posture[canonicalFaction].assignments[edge_id] = {
        edge_id,
        posture: posture as PostureLevel,
        weight: postureWeight
      };
      
      log(`Set posture: faction=${canonicalFaction} edge=${edge_id} posture=${posture} weight=${postureWeight}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(serializeState(currentState));
    } catch (error) {
      log(`Error in /set_posture: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (method === 'POST' && url === '/set_logistics_priority') {
    log(`POST /set_logistics_priority`);
    try {
      const payload = body ? JSON.parse(body) : {};
      const { faction_id, target_id, priority } = payload;
      
      // Validate required fields
      if (!faction_id || typeof faction_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid faction_id' }));
        return;
      }
      if (!target_id || typeof target_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid target_id' }));
        return;
      }
      if (typeof priority !== 'number' || priority <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid priority (must be > 0)' }));
        return;
      }
      
      // Canonicalize faction ID
      const canonicalFaction = canonicalizePoliticalSideId(faction_id);
      
      // Ensure logistics_priority structure exists
      if (!currentState.logistics_priority || typeof currentState.logistics_priority !== 'object') {
        currentState.logistics_priority = {};
      }
      if (!currentState.logistics_priority[canonicalFaction]) {
        currentState.logistics_priority[canonicalFaction] = {};
      }
      
      // Set logistics priority (takes effect on next turn)
      currentState.logistics_priority[canonicalFaction][target_id] = priority;
      
      log(`Set logistics priority: faction=${canonicalFaction} target=${target_id} priority=${priority}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(serializeState(currentState));
    } catch (error) {
      log(`Error in /set_logistics_priority: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

// Create and start server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Dev runner server listening on http://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /state                - Get current GameState`);
  console.log(`  POST /step                 - Advance one turn`);
  console.log(`  POST /reset                - Reset to initial state`);
  console.log(`  POST /set_posture          - Set posture for faction/edge (takes effect next turn)`);
  console.log(`  POST /set_logistics_priority - Set logistics priority for faction/target (takes effect next turn)`);
  console.log(`\nSet DEV_RUNNER_LOG=true to enable request logging`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down dev runner server...');
  server.close(() => {
    process.exit(0);
  });
});
