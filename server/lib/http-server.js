/**
 * HTTP Server
 * Serves static files for the web-based mining client
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

function createHttpServer() {
    const server = http.createServer((req, res) => {
        const urlPath = req.url.split('?')[0];
        const serverDir = path.join(__dirname, '..');
        
        // Determine which file to serve
        let filename;
        if (urlPath === '/') {
            // Try miner-client.html first, fall back to client-example.html
            const primaryFile = path.join(serverDir, 'miner-client.html');
            const fallbackFile = path.join(serverDir, 'client-example.html');
            filename = fs.existsSync(primaryFile) ? 'miner-client.html' : 'client-example.html';
        } else {
            filename = urlPath.substring(1);
        }
        
        let filePath = path.join(serverDir, filename);
        
        // Security: prevent directory traversal
        if (!filePath.startsWith(serverDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        
        // Check if file exists
        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }
            
            // Set content type based on file extension
            const ext = path.extname(filePath).toLowerCase();
            const contentTypes = {
                '.html': 'text/html',
                '.js': 'application/javascript',
                '.wasm': 'application/wasm',
                '.css': 'text/css',
                '.json': 'application/json'
            };
            
            res.writeHead(200, {
                'Content-Type': contentTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'no-cache'
            });
            
            const stream = fs.createReadStream(filePath);
            stream.pipe(res);
        });
    });

    return server;
}

function startServer(server) {
    return new Promise((resolve, reject) => {
        server.listen(config.wsPort, '0.0.0.0', () => {
            console.log(`HTTP server listening on http://localhost:${config.wsPort}`);
            resolve(server);
        });
        
        server.on('error', reject);
    });
}

module.exports = {
    createHttpServer,
    startServer
};
