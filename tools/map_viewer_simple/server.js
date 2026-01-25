#!/usr/bin/env node

/**
 * Minimal static file server for settlement outlines viewer
 * Serves files from tools/map_viewer_simple/ directory
 */

import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const PORT = 5177;
const ROOT_DIR = __dirname;

// Content type mapping
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.geojson': 'application/geo+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function getContentType(path) {
    const ext = extname(path).toLowerCase();
    return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function serveFile(filePath, res) {
    try {
        const stats = statSync(filePath);
        if (!stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }
        
        const content = readFileSync(filePath);
        const contentType = getContentType(filePath);
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
    }
}

const server = createServer((req, res) => {
    // Parse URL
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = url.pathname;
    
    // Default to index.html for root
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    // Remove leading slash and resolve path
    const filePath = resolve(ROOT_DIR, pathname.slice(1));
    
    // Security: ensure file is within ROOT_DIR
    if (!filePath.startsWith(ROOT_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Forbidden');
        return;
    }
    
    serveFile(filePath, res);
});

server.listen(PORT, () => {
    console.log(`Settlement Outlines Viewer server running at:`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`\nPress Ctrl+C to stop.`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nError: Port ${PORT} is already in use.`);
        console.error(`Another server instance may be running.`);
        console.error(`\nTo fix this:`);
        console.error(`  1. Find and stop the existing server (Ctrl+C in its terminal)`);
        console.error(`  2. Or kill the process using port ${PORT}:`);
        console.error(`     Windows: netstat -ano | findstr :${PORT}`);
        console.error(`     Then: taskkill /PID <pid> /F`);
        process.exit(1);
    } else {
        console.error('Server error:', err);
        process.exit(1);
    }
});
