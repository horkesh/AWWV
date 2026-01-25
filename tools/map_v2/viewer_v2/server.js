/**
 * Simple HTTP server for viewer_v2
 * Serves on port 5178
 * 
 * Mistake-log discipline: HTML viewer rendering: per-polygon beginPath/moveTo/closePath
 */

// Mistake-log discipline
console.log('Server initialized: HTML viewer rendering: transform bounds must be frozen and never updated during draw');
console.log('RULE: Transform bounds must be computed once per render and never mutated. Diagnostics must be tracked in separate variables that do not feed into tx/ty.');

import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 5178;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.css': 'text/css'
};

async function serveFile(filePath) {
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    return { content, contentType, status: 200 };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { content: '404 Not Found', contentType: 'text/plain', status: 404 };
    }
    return { content: `500 Internal Server Error: ${err.message}`, contentType: 'text/plain', status: 500 };
  }
}

const server = http.createServer(async (req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  
  // Security: ensure file is within ROOT
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  const { content, contentType, status } = await serveFile(filePath);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(content);
});

server.listen(PORT, () => {
  console.log(`Map v2 Viewer running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});
