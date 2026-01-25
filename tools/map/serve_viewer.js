#!/usr/bin/env node
/**
 * Simple HTTP server for map viewer
 * 
 * Usage:
 *   node tools/map/serve_viewer.js
 *   npm run map:view
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8000;
const BASE_DIR = resolve(__dirname, '../..');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.csv': 'text/csv',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  
  // Default to viewer.html
  if (pathname === '/') {
    pathname = '/tools/map/viewer.html';
  }
  
  // Remove leading slash and resolve
  const filePath = resolve(BASE_DIR, pathname.substring(1));
  
  // Security check: ensure file is within base directory
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Map viewer server running at http://localhost:${PORT}/tools/map/viewer.html`);
  console.log(`Press Ctrl+C to stop`);
});
