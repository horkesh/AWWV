#!/usr/bin/env node
/**
 * Simple HTTP server for settlement + municipality border viewer
 * 
 * Usage:
 *   tsx tools/map/serve_simple_map_viewer.ts
 *   npm run map:view-map
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Add a simple HTML map viewer and a single command that regenerates derived artifacts then serves the viewer");

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT || '5185', 10);
const BASE_DIR = resolve(__dirname, '../..');

const SETTLEMENTS_PATH = resolve(BASE_DIR, 'data/source/geography_settlements.geojson');
const MUNI_BORDERS_PATH = resolve(BASE_DIR, 'data/derived/municipality_borders_from_settlements.geojson');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.css': 'text/css'
};

const server = createServer(async (req, res) => {
  let pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  
  // Route handling
  if (pathname === '/') {
    pathname = '/tools/map/view_simple_map/index.html';
  } else if (pathname === '/viewer.js') {
    pathname = '/tools/map/view_simple_map/viewer.js';
  } else if (pathname === '/settlements') {
    if (!existsSync(SETTLEMENTS_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Settlement GeoJSON file not found at: ' + SETTLEMENTS_PATH);
      console.warn('WARNING: Settlement file not found:', SETTLEMENTS_PATH);
      return;
    }
    try {
      const content = await readFile(SETTLEMENTS_PATH, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading settlement GeoJSON file');
      console.warn('WARNING: Error reading settlement file:', err);
    }
    return;
  } else if (pathname === '/muni') {
    if (!existsSync(MUNI_BORDERS_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Municipality borders GeoJSON file not found at: ' + MUNI_BORDERS_PATH + '\n\nRun: npm run map:derive-muni-borders');
      console.warn('WARNING: Municipality borders file not found:', MUNI_BORDERS_PATH);
      return;
    }
    try {
      const content = await readFile(MUNI_BORDERS_PATH, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading municipality borders GeoJSON file');
      console.warn('WARNING: Error reading municipality borders file:', err);
    }
    return;
  } else {
    // Try to serve static file
    const filePath = resolve(BASE_DIR, pathname.substring(1));
    
    // Security check: ensure file is within base directory
    if (!filePath.startsWith(BASE_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found: ' + pathname + '\nResolved to: ' + filePath);
      console.warn('WARNING: File not found:', pathname, '->', filePath);
      return;
    }
    
    try {
      const content = await readFile(filePath, 'utf8');
      const ext = extname(filePath);
      const mimeType = MIME_TYPES[ext] || 'text/plain';
      res.writeHead(200, { 
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading file: ' + (err instanceof Error ? err.message : String(err)));
      console.warn('WARNING: Error reading file:', filePath, err);
    }
    return;
  }
});

// Try to listen on PORT, or next available port if in use
function tryListen(port: number, maxAttempts: number = 5): void {
  if (maxAttempts <= 0) {
    console.error(`\nError: Could not find available port starting from ${PORT}`);
    console.error('Please stop the existing server or use: PORT=<port> npm run map:view-map');
    process.exitCode = 1;
    return;
  }

  server.listen(port, () => {
    if (port !== PORT) {
      console.log(`Note: Port ${PORT} was in use, using port ${port} instead`);
    }
    console.log(`Open: http://localhost:${port}/`);
  }).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Try next port
      tryListen(port + 1, maxAttempts - 1);
    } else {
      console.error('Server error:', err);
      process.exitCode = 1;
    }
  });
}

tryListen(PORT);
