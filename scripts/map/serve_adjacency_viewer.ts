/**
 * Serve Settlement Adjacency Viewer
 *
 * Simple HTTP server to serve the adjacency viewer HTML and data files.
 * Required because browsers block fetch() from file:// URLs due to CORS.
 *
 * Usage:
 *   npm run map:serve:adjacency
 *   or: tsx scripts/map/serve_adjacency_viewer.ts
 *
 * Then open http://localhost:5190 in a browser.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const PORT = parseInt(process.env.PORT || '5190', 10);
const viewerDir = resolve('data/derived/adjacency_viewer');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

const server = createServer((req, res) => {
  let filePath: string;

  if (req.url === '/' || req.url === '/index.html') {
    filePath = resolve(viewerDir, 'index.html');
  } else if (req.url === '/data.json') {
    filePath = resolve(viewerDir, 'data.json');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`File not found: ${filePath}\nRun 'npm run map:viewer:adjacency' first to generate the viewer.`);
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error reading file: ${err}`);
  }
});

server.listen(PORT, () => {
  console.log(`Adjacency Viewer server running at http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop.`);
});
