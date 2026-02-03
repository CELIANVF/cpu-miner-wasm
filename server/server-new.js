#!/usr/bin/env node
/**
 * Verus Miner WebSocket Server
 * 
 * Bridges mining pool (Stratum protocol) and web miners (WebSocket)
 * 
 * Usage:
 *   node server.js --pool stratum+tcp://pool.verus.io:9999 --user WALLET_ADDRESS.name --pass x --port 8080
 */

const { config } = require('./lib/config');
const StratumClient = require('./lib/stratum-client');
const WebSocketServer = require('./lib/websocket-server');
const { createHttpServer, startServer } = require('./lib/http-server');

// Main initialization
async function main() {
    console.log('Verus Miner WebSocket Server');
    console.log(`Pool: ${config.poolUrl}`);
    console.log(`User: ${config.poolUser}`);
    console.log(`WebSocket Port: ${config.wsPort}`);
    console.log('');

    try {
        // Create HTTP server
        const httpServer = createHttpServer();
        await startServer(httpServer);

        // Initialize Stratum client and WebSocket server
        const stratumClient = new StratumClient();
        const wss = new WebSocketServer(httpServer);

        // Connect the Stratum client callbacks to WebSocket server
        stratumClient.setWorkCallback((work) => {
            wss.broadcastWork(work);
        });
        
        stratumClient.setInterruptCallback((jobId) => {
            wss.broadcastInterrupt(jobId);
        });

        // Connect the WebSocket server's share callback to Stratum client
        wss.setShareCallback((work, nonce, extra, worker, resultCallback) => {
            return stratumClient.submitShare(work, nonce, extra, worker, resultCallback);
        });

        // Connect to pool
        stratumClient.connect();

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nShutting down...');
            if (stratumClient.socket) {
                stratumClient.socket.destroy();
            }
            wss.wss.close();
            httpServer.close();
            process.exit(0);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

main();
