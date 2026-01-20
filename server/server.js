#!/usr/bin/env node
/**
 * Verus Miner WebSocket Server
 * 
 * Bridges mining pool (Stratum protocol) and web miners (WebSocket)
 * 
 * Usage:
 *   node server.js --pool stratum+tcp://pool.verus.io:9999 --user WALLET_ADDRESS.name --pass x --port 8080
 */

const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration - Parse command line arguments properly
function getArg(name) {
    const withEquals = process.argv.find(arg => arg.startsWith(`--${name}=`));
    if (withEquals) return withEquals.split('=')[1];
    
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && index + 1 < process.argv.length) {
        return process.argv[index + 1];
    }
    return null;
}

const config = {
    poolUrl: process.env.POOL_URL || getArg('pool') || 'stratum+tcp://pool.verus.io:9999',
    poolUser: process.env.POOL_USER || getArg('user') || '',
    poolPass: process.env.POOL_PASS || getArg('pass') || 'x',
    wsPort: parseInt(process.env.WS_PORT || getArg('port') || '8080'),
    debug: process.argv.includes('--debug') || process.env.DEBUG === '1'
};

// Parse pool URL
function parsePoolUrl(url) {
    const match = url.match(/stratum\+tcp:\/\/([^:]+):(\d+)/);
    if (!match) {
        throw new Error(`Invalid pool URL: ${url}`);
    }
    return { host: match[1], port: parseInt(match[2]) };
}

const poolInfo = parsePoolUrl(config.poolUrl);

// Stratum client state
class StratumClient {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.subscribed = false;
        this.authorized = false;
        this.sessionId = null;
        this.xnonce1 = null;
        this.xnonce1Size = 0;
        this.xnonce2Size = 0;
        this.xnonce2 = Buffer.alloc(4);
        this.xnonce2.fill(0);
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.currentJob = null;
        this.currentTarget = null;
        this.currentDifficulty = 1.0;
        this.isEquihash = false;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.lastNotifyParams = null; // Store last mining.notify parameters for rebuilding
        this.authorizedWorkers = new Set(); // Track which worker usernames we've authorized on this session
        this.acceptedShares = 0;
        this.rejectedShares = 0;
    }

    connect() {
        if (this.socket) {
            this.socket.destroy();
        }

        this.log(`Connecting to pool ${poolInfo.host}:${poolInfo.port}...`);
        this.socket = net.createConnection(poolInfo.port, poolInfo.host);

        this.socket.on('connect', () => {
            this.log('Connected to pool');
            this.connected = true;
            // Clear per-worker authorize cache on reconnect
            if (this.authorizedWorkers && this.authorizedWorkers.clear) this.authorizedWorkers.clear();
            this.subscribe();
        });

        this.socket.on('data', (data) => {
            this.handlePoolMessage(data.toString());
        });

        this.socket.on('error', (err) => {
            this.log(`Pool connection error: ${err.message}`);
            this.connected = false;
            this.scheduleReconnect();
        });

        this.socket.on('close', () => {
            this.log('Pool connection closed');
            this.connected = false;
            this.subscribed = false;
            this.authorized = false;
            this.scheduleReconnect();
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    send(message) {
        if (!this.socket || !this.connected) {
            console.error(`[ERROR] Cannot send to pool: socket=${!!this.socket}, connected=${this.connected}`);
            return false;
        }
        const json = JSON.stringify(message) + '\n';
        this.log(`→ Pool: ${json.trim()}`);
        const written = this.socket.write(json);
        if (!written) {
            console.error(`[ERROR] socket.write() returned false - message may not have been sent!`);
        }
        return written;
    }

    sendRequest(method, params, callback) {
        const id = ++this.messageId;
        const message = {
            id: id,
            method: method,
            params: params || []
        };
        this.pendingRequests.set(id, callback);
        
        if (method === 'mining.submit') {
            console.log(`[DEBUG] sendRequest called for mining.submit (id: ${id})`);
            console.log(`[DEBUG]   params:`, params.map(p => 
                typeof p === 'string' && p.length > 100 ? `${p.substring(0, 50)}... (${p.length} chars)` : p
            ));
        }
        
        const sent = this.send(message);
        
        if (method === 'mining.submit') {
            if (sent) {
                console.log(`[DEBUG] mining.submit request sent successfully to pool (id: ${id})`);
            } else {
                console.error(`[ERROR] mining.submit request FAILED to send! (id: ${id})`);
            }
        }
        
        return sent;
    }

    subscribe() {
        this.sendRequest('mining.subscribe', ['verus-miner-ws/1.0'], (error, result) => {
            if (error) {
                this.log(`Subscribe failed: ${error.message}`);
                return;
            }
            this.log('Subscribed to pool');
            this.subscribed = true;
            
            // Parse subscription response
            if (result && Array.isArray(result) && result.length >= 2) {
                this.sessionId = result[0];
                const extraNonce1 = result[1];
                this.xnonce1 = Buffer.from(extraNonce1, 'hex');
                this.xnonce1Size = this.xnonce1.length;
                this.xnonce2Size = result[2] || 4;
                this.log(`Session ID: ${this.sessionId}, xnonce1: ${extraNonce1}, xnonce2_size: ${this.xnonce2Size}`);
            }
            
            // Authorize
            this.authorize();
        });
    }

    authorize() {
        this.sendRequest('mining.authorize', [config.poolUser, config.poolPass], (error, result) => {
            if (error) {
                this.log(`Authorization failed: ${error.message}`);
                return;
            }
            if (result === true) {
                this.log(`Authorized as ${config.poolUser}`);
                this.authorized = true;
                this.startPingTimer();
            } else {
                this.log(`Authorization rejected: ${result}`);
            }
        });
    }

    startPingTimer() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            this.send({ id: null, method: 'mining.ping', params: [] });
        }, 30000); // Ping every 30 seconds
    }

    handlePoolMessage(data) {
        const lines = data.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            this.log(`← Pool: ${line}`);
            
            try {
                const message = JSON.parse(line);
                
                // Handle responses to our requests
                if (message.id !== undefined && message.id !== null) {
                    const callback = this.pendingRequests.get(message.id);
                    if (callback) {
                        this.pendingRequests.delete(message.id);
                        if (message.error) {
                            callback(new Error(message.error.message || 'Unknown error'), null);
                        } else {
                            callback(null, message.result);
                        }
                    }
                    continue;
                }
                
                // Handle notifications from pool
                if (message.method) {
                    this.handlePoolNotification(message);
                }
            } catch (err) {
                this.log(`Failed to parse pool message: ${err.message}`);
            }
        }
    }

    handlePoolNotification(message) {
        switch (message.method) {
            case 'mining.notify':
                this.handleMiningNotify(message.params);
                break;
            case 'mining.set_difficulty':
                this.handleSetDifficulty(message.params);
                break;
            case 'mining.set_target':
                this.handleSetTarget(message.params);
                break;
            case 'mining.pong':
                // Pool responded to ping
                break;
            case 'client.show_message':
                this.log(`Pool message: ${JSON.stringify(message.params)}`);
                break;
            default:
                this.log(`Unknown pool method: ${message.method}`);
        }
    }

    handleMiningNotify(params) {
        if (!params || params.length < 6) {
            this.log('Invalid mining.notify parameters');
            return;
        }

        // Verus Stratum parameter order
        const jobId = params[0];
        const version = params[1];
        const prevhash = params[2];
        const coinb1 = params[3];
        const coinb2 = params[4];
        const ntime = params[5]; // ntime from pool as hex string (e.g., "675a1f8c")
        
        if (config.debug) {
            // Validate ntime is reasonable
            // Note: Pool sends ntime as LE hex string (e.g., "cc666269" = bytes [0xcc, 0x66, 0x62, 0x69])
            // Read as LE uint32 to get the actual Unix timestamp
            if (ntime && ntime.length === 8) {
                const ntimeBuf = Buffer.from(ntime, 'hex');
                const ntimeValue = ntimeBuf.readUInt32LE(0);
                const timestamp = new Date(ntimeValue * 1000);
                this.log(`  ntime from pool: ${ntime} (timestamp: ${ntimeValue}, date: ${timestamp.toISOString()})`);
            } else {
                this.log(`  WARNING: Invalid ntime format: ${ntime}`);
            }
        }
        const nbits = params[6];
        const clean = params[7] || false;
        const solution = params[8] || null;
        const merkleBranches = []; // Verus doesn't use merkle branches

        this.log(`New job: ${jobId} (clean: ${clean})`);
        
        if (config.debug) {
            this.log(`  version: ${version}`);
            this.log(`  nbits: ${nbits}`);
            this.log(`  solution length: ${solution ? Buffer.from(solution, 'hex').length : 0}`);
            this.log(`  difficulty: ${this.currentDifficulty}`);
        }

        // Store parameters for potential rebuild when difficulty changes
        this.lastNotifyParams = {
            jobId: jobId,
            version: version,
            prevhash: prevhash,
            coinb1: coinb1,
            coinb2: coinb2,
            ntime: ntime,
            nbits: nbits,
            clean: clean,
            solution: solution
        };

        // Increment extranonce2 for new work
        this.incrementXnonce2();

        // Build work data (pass in correct order)
        const work = this.buildWork(jobId, version, prevhash, coinb1, coinb2, ntime, nbits, clean, solution);
        
        this.currentJob = {
            jobId: jobId,
            work: work,
            clean: clean,
            timestamp: Date.now()
        };

        // CRITICAL: If clean_jobs is true, immediately interrupt all workers
        // This ensures they stop working on the old job before starting the new one
        if (clean) {
            this.log(`clean_jobs=true: Interrupting all workers for new job ${jobId}`);
            wss.broadcastInterrupt(jobId);
            // Small delay to ensure interrupt is processed before new work
            setTimeout(() => {
                wss.broadcastWork(work);
            }, 100);
        } else {
            // Normal job update - just broadcast the work
            wss.broadcastWork(work);
        }
    }

    handleSetDifficulty(params) {
        if (params && params.length > 0) {
            const newDifficulty = parseFloat(params[0]);
            this.currentDifficulty = newDifficulty;
            this.log(`Difficulty set to: ${this.currentDifficulty}`);
            
            // CRITICAL: When difficulty changes, calculate target from difficulty
            // Note: mining.set_target takes precedence, but if not received, calculate from difficulty
            // Only calculate if we don't have a target from mining.set_target
            if (!this.currentTarget || this.currentTarget.length < 32) {
                const calculatedTarget = this.difficultyToTarget(newDifficulty);
                if (calculatedTarget) {
                    // Store as currentTarget so buildWork uses it
                    this.currentTarget = calculatedTarget;
                    this.log(`Target calculated from difficulty ${newDifficulty}: ${Buffer.from(calculatedTarget).toString('hex')}`);
                    
                    // Update and rebroadcast current job with new target if we have one
                    if (this.currentJob && this.lastNotifyParams) {
                        // Rebuild work using stored parameters from last mining.notify
                        const params = this.lastNotifyParams;
                        const updatedWork = this.buildWork(
                            params.jobId,
                            params.version,
                            params.prevhash,
                            params.coinb1,
                            params.coinb2,
                            params.ntime,
                            params.nbits,
                            params.clean,
                            params.solution
                        );
                        
                        // Update current job
                        this.currentJob.work = updatedWork;
                        
                        // Broadcast updated work with new target
                        this.log(`Broadcasting updated work with new difficulty ${newDifficulty}`);
                        wss.broadcastWork(updatedWork);
                    }
                }
            }
        }
    }

    // Convert difficulty to target for Verus/Equihash
    // Based on diff_to_target_equi from ccminer-equi/equi-stratum.cpp
    difficultyToTarget(difficulty) {
        if (!difficulty || difficulty <= 0) {
            return null;
        }

        const target = Buffer.alloc(32).fill(0);
        
        // "Diff 1" cible standard (utilisée par la plupart des pools Verus)
        // 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff
        const diff1 = Buffer.from("00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 'hex');
        
        // Calcul simplifié pour le Web :
        // On définit une cible où plus la difficulté est haute, plus le nombre est petit.
        let quotient = Math.floor(0xffff / difficulty);
        
        // On écrit la difficulté à la fin du buffer (poids fort pour l'algo)
        // Le mineur WASM lit target[7] comme la partie la plus significative
        target.writeUInt32LE(quotient, 28); 
        
        return target;
    }

    handleSetTarget(params) {
        if (params && params.length > 0) {
            const targetHex = params[0];
            this.currentTarget = Buffer.from(targetHex, 'hex');
            this.isEquihash = true;
            this.log(`Target set: ${targetHex}`);
            this.log(`Target buffer length: ${this.currentTarget.length} bytes`);
            
            // Update current job if exists
            if (this.currentJob && this.currentTarget.length >= 32) {
                // CRITICAL FIX: Reverse the entire 32-byte buffer first (like CPU miner does)
                const reversedTarget = Buffer.alloc(32);
                for (let i = 0; i < 32; i++) {
                    reversedTarget[31 - i] = this.currentTarget[i];
                }
                
                // Now read as little-endian uint32s
                for (let i = 0; i < 8; i++) {
                    this.currentJob.work.target[i] = reversedTarget.readUInt32LE(i * 4);
                }
                this.log(`Target array: ${this.currentJob.work.target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
                wss.broadcastWork(this.currentJob.work);
            }
        }
    }

    incrementXnonce2() {
        for (let i = 0; i < this.xnonce2.length; i++) {
            this.xnonce2[i]++;
            if (this.xnonce2[i] !== 0) break;
        }
    }

    buildWork(jobId, version, prevhash, coinb1, coinb2, ntime, nbits, clean, solution) {
        // Convert hex strings to buffers
        const prevhashBuf = Buffer.from(prevhash, 'hex');
        const coinb1Buf = Buffer.from(coinb1, 'hex');
        const coinb2Buf = Buffer.from(coinb2, 'hex');
        const versionBuf = Buffer.from(version, 'hex');
        const nbitsBuf = Buffer.from(nbits, 'hex');
        const ntimeBuf = Buffer.from(ntime, 'hex');
        
        // CRITICAL: For Verus, coinb1 and coinb2 ARE the merkle root and reserved field!
        // Don't calculate merkle root - use what the pool sends directly
        // See stratum.cpp line 1134: memcpy(&work->data[9], sctx->job.coinbase, 32+32);
        
        // Build block data (48 uint32 values)
        const data = new Array(48).fill(0);
        
        // Version (little-endian)
        data[0] = versionBuf.readUInt32LE(0);
        
        // Previous hash (8 uint32, little-endian)
        for (let i = 0; i < 8; i++) {
            data[1 + i] = prevhashBuf.readUInt32LE(i * 4);
        }
        
        // Merkle root (8 uint32, little-endian) - this is coinb1 from pool
        for (let i = 0; i < 8; i++) {
            data[9 + i] = coinb1Buf.readUInt32LE(i * 4);
        }
        
        // Reserved field (8 uint32, little-endian) - this is coinb2 from pool  
        for (let i = 0; i < 8; i++) {
            data[17 + i] = coinb2Buf.readUInt32LE(i * 4);
        }
        
        // ntime (little-endian)
        data[25] = ntimeBuf.readUInt32LE(0);
        
        // nbits (little-endian)
        data[26] = nbitsBuf.readUInt32LE(0);
        
        // xnonce1 (up to 8 bytes)
        const xnonce1Words = Math.min(8, Math.ceil(this.xnonce1Size / 4));
        for (let i = 0; i < xnonce1Words; i++) {
            data[27 + i] = this.xnonce1.readUInt32LE(i * 4);
        }
        
        // CRITICAL FIX: xnonce2 must go right after xnonce1 in pdata
        // (see stratum.cpp lines 1196-1199)
        const xnonce2Words = Math.min(8, Math.ceil(this.xnonce2Size / 4));
        const xnonce2Start = 27 + xnonce1Words;
        for (let i = 0; i < xnonce2Words; i++) {
            if (i * 4 < this.xnonce2.length) {
                data[xnonce2Start + i] = this.xnonce2.readUInt32LE(i * 4);
            }
        }
        
        // Padding
        data[35] = 0x80;
        
        // Solution (1347 bytes for submission: 3 byte header + 1344 bytes)
        // Allocate 1347 bytes to match what the CPU miner sends (work->extra)
        let solutionBuf;
        if (solution && typeof solution === 'string') {
            solutionBuf = Buffer.from(solution, 'hex');
        } else {
            solutionBuf = Buffer.alloc(1347); // Changed from 1344 to 1347
        }
        
        // Build target array - initialize with zeros first
        const target = new Array(8).fill(0);
        
        // Priority: mining.set_target from pool takes precedence
        // Then: target calculated from mining.set_difficulty
        // Finally: target from nbits
        if (this.currentTarget && this.currentTarget.length >= 32) {
            // Use mining.set_target if provided by pool
            // CRITICAL FIX: CPU miner reverses the entire 32-byte buffer first!
            // See stratum.cpp lines 956-969: target_be[31-i] = target_bin[i]
            const reversedTarget = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) {
                reversedTarget[31 - i] = this.currentTarget[i];
            }
            
            // Now read as little-endian uint32s
            for (let i = 0; i < 8; i++) {
                target[i] = reversedTarget.readUInt32LE(i * 4);
            }
            
            if (config.debug) {
                this.log(`Target from mining.set_target: ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
            }
        }
        else if (nbitsBuf && nbitsBuf.length === 4) {
            // Read nbits as little-endian uint32
            const nbitsValue = nbitsBuf.readUInt32LE(0);
            
            // Extract exponent and mantissa from compact format
            // nbits format: 0xAABBCCDD where AA is exponent, BBCCDD is mantissa
            const exponent = (nbitsValue >>> 24) & 0xFF;
            const mantissa = nbitsValue & 0x00FFFFFF;
            
            // Build 256-bit target from compact form
            // Target = mantissa * 256^(exponent - 3)
            const targetBytes = Buffer.alloc(32, 0);
            
            if (exponent <= 3) {
                // Shift mantissa right
                const shift = 3 - exponent;
                const value = mantissa >>> (shift * 8);
                if (value >= 0) {
                    targetBytes.writeUInt32BE(value, 28); // Write to lowest bytes
                }
            } else {
                // Normal case: place mantissa at position (exponent - 3)
                const offset = exponent - 3;
                if (offset <= 29) {
                    // Write mantissa as big-endian at calculated offset
                    targetBytes[32 - offset - 3] = (mantissa >>> 16) & 0xFF;
                    targetBytes[32 - offset - 2] = (mantissa >>> 8) & 0xFF;
                    targetBytes[32 - offset - 1] = mantissa & 0xFF;
                }
            }
            
            // Reverse entire buffer (big-endian to little-endian byte order)
            const reversedTarget = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) {
                reversedTarget[31 - i] = targetBytes[i];
            }
            
            // Read as little-endian uint32s
            for (let i = 0; i < 8; i++) {
                target[i] = reversedTarget.readUInt32LE(i * 4);
            }
            
            if (config.debug) {
                this.log(`Target from nbits 0x${nbitsValue.toString(16)}: ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
            }
        }
        else if (this.currentDifficulty && this.currentDifficulty > 0) {
            // Fallback: Calculate target from difficulty if no mining.set_target or nbits
            const calculatedTarget = this.difficultyToTarget(this.currentDifficulty);
            if (calculatedTarget && calculatedTarget.length >= 32) {
                // Reverse and read as little-endian uint32s (same as mining.set_target path)
                const reversedTarget = Buffer.alloc(32);
                for (let i = 0; i < 32; i++) {
                    reversedTarget[31 - i] = calculatedTarget[i];
                }
                
                for (let i = 0; i < 8; i++) {
                    target[i] = reversedTarget.readUInt32LE(i * 4);
                }
                
                if (config.debug) {
                    this.log(`Target from difficulty ${this.currentDifficulty}: ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
                }
            } else {
                // Fallback to default target
                target.fill(0xFFFFFFFF);
                target[7] = 0x7FFFFFFF;
                if (config.debug) {
                    this.log(`WARNING: Could not calculate target from difficulty, using default`);
                }
            }
        }
        else {
            // Default target (very easy for testing)
            target.fill(0xFFFFFFFF);
            target[7] = 0x7FFFFFFF;
            if (config.debug) {
                this.log(`WARNING: Using default target (difficulty: ${this.currentDifficulty}, nbits: ${nbitsBuf ? nbitsBuf.length : 'null'})`);
            }
        }

        // Build work object for WASM
        // Keep original solution from pool (don't pad yet)
        const solutionArrayOriginal = Array.from(solutionBuf);
        
        if (config.debug) {
            this.log(`Building work: solution from pool is ${solutionArrayOriginal.length} bytes`);
            this.log(`First 32 bytes of solution: ${Buffer.from(solutionArrayOriginal.slice(0, 32)).toString('hex')}`);
        }
        
        // CRITICAL FIX: Initialize extra with solution template (like verusscan_simple.cpp does)
        // sol_data = { 0xfd, 0x40, 0x05 } + work->solution (original size) = up to 1347 bytes
        const extraArray = new Array(1388).fill(0);
        extraArray[0] = 0xfd;  // Header byte 1
        extraArray[1] = 0x40;  // Header byte 2
        extraArray[2] = 0x05;  // Header byte 3
        // Copy solution template after header (DON'T pad with zeros first!)
        for (let i = 0; i < solutionArrayOriginal.length && i < 1344; i++) {
            extraArray[3 + i] = solutionArrayOriginal[i];
        }
        
        if (config.debug) {
            this.log(`Extra array initialized with ${solutionArrayOriginal.length} bytes of template`);
            this.log(`First 32 bytes of extra: ${Buffer.from(extraArray.slice(0, 32)).toString('hex')}`);
        }
        
        // CRITICAL: DON'T pad solution with zeros!
        // scanhash_verus reads work->solution (1344 bytes) to build sol_data
        // If we pad with zeros, sol_data will be full of zeros!
        // Instead, keep original size (229 bytes) and pad ONLY when passing to WASM memory
        const solutionArray = Array.from(solutionBuf);
        
        const work = {
            data: data,
            target: target,
            solution: solutionArray, // Solution template: ORIGINAL SIZE (229 bytes, not padded!)
            extra: extraArray,  // Extra data: 1388 bytes (will be built by scanhash_verus)
            start_nonce: 0,
            max_nonce: 0xFFFFFFFF,
            job_id: jobId,
            targetdiff: this.currentDifficulty,
            ntime: ntime  // Store ntime for share submission
        };

        return work;
    }

    calculateMerkleRoot(coinbase, merkleBranches) {
        // Calculate coinbase hash
        const hash1 = crypto.createHash('sha256');
        hash1.update(coinbase);
        let merkle = hash1.digest();
        
        // Apply merkle branches (if any)
        if (merkleBranches && Array.isArray(merkleBranches)) {
            for (const branch of merkleBranches) {
                const branchBuf = Buffer.from(branch, 'hex');
                // Combine and hash
                const combined = Buffer.concat([merkle, branchBuf]);
                const hash2 = crypto.createHash('sha256');
                hash2.update(combined);
                merkle = hash2.digest();
            }
        }
        
        // Double SHA256 (standard for Bitcoin-style merkle root)
        const hash3 = crypto.createHash('sha256');
        hash3.update(merkle);
        const hash4 = crypto.createHash('sha256');
        hash4.update(hash3.digest());
        return hash4.digest();
    }

    submitShare(work, nonce, extra, worker, resultCallback) {
        if (!this.authorized) {
            return false;
        }

        // Validate extra exists and has correct size (WASM fills this when share is found)
        if (!extra || extra.length < 1347) {
            this.log(`Warning: work.extra is empty or too small (${extra ? extra.length : 0} bytes, need 1347)`);
            return false;
        }

        // IMPORTANT: The 'extra' buffer from C++ contains the solution with fd4005 prefix.
        // ccminer INCLUDES the fd4005 prefix in the solution field (see ccminer-debug.log line 36).
        // The extra buffer has zeroed data at positions 8-71 (for version 7+ hashing), but we need
        // to RESTORE the original solution bytes from work.solution at those positions.
        // 
        // See cpu-miner-verus stratum.cpp lines 1216-1220:
        //   cbin2hex(solhex, (const char*)work->extra, 1347);
        //   cbin2hex(solHexRestore, (const char*)&work->solution[8], 64);
        //   memcpy(&solhex[6+16], solHexRestore, 128);  // Restore 64 bytes at hex position 22
        let rawExtra = Buffer.from(extra);
        
        // First, convert extra to hex (with fd4005 prefix - DO NOT strip it!)
        let solutionHex = rawExtra.slice(0, 1347).toString('hex'); // Total 1347 bytes (fd4005 prefix + 1344 solution)
        
        if (config.debug) {
            this.log(`[DEBUG] Solution with prefix: ${solutionHex.length / 2} bytes`);
            this.log(`[DEBUG] Solution starts with: ${solutionHex.substring(0, 16)}`);
        }
        
        // CRITICAL: Restore the original solution bytes that were zeroed for hashing
        // work.solution contains the original template from pool, need to restore bytes 8-71
        // In the hex string: position 6 (fd4005) + 16 (8 bytes * 2) = 22
        if (work.solution && Array.isArray(work.solution) && work.solution.length >= 72) {
            // Get bytes 8-71 from work.solution (64 bytes)
            const restoreBytes = Buffer.from(work.solution.slice(8, 72));
            const restoreHex = restoreBytes.toString('hex');
            
            // Replace in solutionHex at position 22 (after fd4005 + first 8 bytes of solution)
            // Position in hex string: 6 (fd4005) + 16 (8 bytes) = 22
            const hexPosition = 6 + 16; // = 22
            solutionHex = solutionHex.substring(0, hexPosition) + restoreHex + solutionHex.substring(hexPosition + 128);
            
            if (config.debug) {
                this.log(`[DEBUG] Restored 64 bytes from work.solution[8..72] at hex position ${hexPosition}`);
                this.log(`[DEBUG] Restored bytes: ${restoreHex.substring(0, 32)}...`);
            }
        } else {
            if (config.debug) {
                this.log(`[DEBUG] WARNING: work.solution not available for restoration (length: ${work.solution ? work.solution.length : 'null'})`);
            }
        }
        
        if (config.debug) {
            this.log(`[DEBUG] Final solution: ${solutionHex.substring(0, 32)}...`);
        }

        // 1. Prepare the Nonce
        // Verus Stratum expects a nonce field of (32 - xnonce1_size) bytes.
        // See cpu-miner-verus stratum.cpp lines 1204-1208:
        //   nonce_len = 32 - sctx->xnonce1_size;
        //   noncestr = bin2hex(&nonce[sctx->xnonce1_size], nonce_len);
        // This contains: xnonce2 + padding + actual_nonce + more_padding
        // 
        // Memory layout from work->data[27] onwards:
        //   data[27]: xnonce1 (4 bytes) - SKIPPED
        //   data[28]: xnonce2 (4 bytes)
        //   data[29]: zeros
        //   data[30]: actual nonce (4 bytes)
        //   data[31-34]: zeros/padding
        const nonceLen = 32 - this.xnonce1Size; // Should be 28 bytes for xnonce1 of 4 bytes
        const nonceBuf = Buffer.alloc(nonceLen, 0);
        
        // Copy xnonce2 at start (from work.data[28])
        if (work.data && work.data.length > 28 && this.xnonce2Size > 0) {
            const xnonce2Value = work.data[27 + Math.ceil(this.xnonce1Size / 4)]; // data[28] for 4-byte xnonce1
            if (xnonce2Value !== undefined) {
                nonceBuf.writeUInt32LE(xnonce2Value, 0);
            }
        }
        
        // Write the actual nonce at the correct offset
        // data[30] is at byte offset 12 from data[27+xnonce1Words]
        // For xnonce1_size=4 (1 word): data[30] is at offset (30-28)*4 = 8 bytes from start of nonceBuf
        const nonceOffset = (30 - 27 - Math.ceil(this.xnonce1Size / 4)) * 4; // Should be 8 for xnonce1=4
        nonceBuf.writeUInt32LE(nonce, nonceOffset);
        
        const nonceHex = nonceBuf.toString('hex');
        
        if (config.debug) {
            this.log(`[DEBUG] Built nonce field: ${nonceHex} (${nonceLen} bytes)`);
            this.log(`[DEBUG]   xnonce1Size: ${this.xnonce1Size}, xnonce2Size: ${this.xnonce2Size}`);
            this.log(`[DEBUG]   nonceOffset: ${nonceOffset}, actual nonce: 0x${nonce.toString(16)}`);
        }

        // 3. Prepare ntime - Use pool's ntime from work.data[25] (like ccminer and cpu-miner-verus do)
        // Reference: ccminer equi_stratum_submit line 301: sprintf(timehex, "%08x", swab32(work->data[25]));
        // Reference: cpu-miner-verus stratum.cpp lines 1224-1227: byte-swap work->data[25]
        // 
        // IMPORTANT: Each job has its own ntime. We MUST use the work's ntime (not current job's ntime)
        // because the pool validates that the ntime matches the job_id.
        let ntimeHex = null;
        
        // Read ntime from work.data[25] and byte-swap (like native miners)
        if (work.data && Array.isArray(work.data) && work.data.length > 25) {
            const ntimeValue = work.data[25]; // Little-endian uint32 from work.data[25]
            // Byte-swap: convert from little-endian (work.data format) to big-endian hex string
            // The pool sends ntime as LE bytes, we store as LE uint32, then swap back to LE hex for submission
            const ntimeSwapped = (((ntimeValue & 0x000000FF) << 24) | 
                                  ((ntimeValue & 0x0000FF00) << 8) | 
                                  ((ntimeValue & 0x00FF0000) >>> 8) | 
                                  ((ntimeValue & 0xFF000000) >>> 24)) >>> 0;
            ntimeHex = ntimeSwapped.toString(16).padStart(8, '0');
            
            if (config.debug) {
                // Note: ntimeSwapped is the original pool ntime hex parsed as BE, so for date we use ntimeValue (the actual timestamp)
                const timestamp = new Date(ntimeValue * 1000);
                this.log(`[DEBUG] Using ntime from work.data[25]: 0x${ntimeValue.toString(16)} (timestamp) -> hex: ${ntimeHex}`);
                this.log(`[DEBUG]   Decoded date: ${timestamp.toISOString()}`);
            }
        } else if (work.ntime && typeof work.ntime === 'string' && work.ntime.length === 8) {
            // Fallback: use work.ntime directly (already in hex format from pool)
            ntimeHex = work.ntime.toLowerCase();
            if (config.debug) {
                // Parse as LE to get actual timestamp
                const ntimeBuf = Buffer.from(ntimeHex, 'hex');
                const ntimeValue = ntimeBuf.readUInt32LE(0);
                const timestamp = new Date(ntimeValue * 1000);
                this.log(`[DEBUG] Using work.ntime directly: ${ntimeHex} (timestamp: ${ntimeValue}, date: ${timestamp.toISOString()})`);
            }
        }
        
        if (!ntimeHex || ntimeHex.length !== 8) {
            this.log(`ERROR: ntime is missing or invalid: ${ntimeHex}`);
            return false;
        }
        
        // Log the share submission
        if (config.debug) {
            const ntimeBuf = Buffer.from(ntimeHex, 'hex');
            const ntimeValue = ntimeBuf.readUInt32LE(0);
            const timestamp = new Date(ntimeValue * 1000);
            const currentTime = Math.floor(Date.now() / 1000);
            const timeDiff = ntimeValue - currentTime;
            this.log(`[Stratum] Submitting share for job ${work.job_id}...`);
            this.log(`[DEBUG] ntime: ${ntimeHex} (timestamp: ${ntimeValue}, date: ${timestamp.toISOString()})`);
            this.log(`[DEBUG]   Time difference from current: ${timeDiff > 0 ? '+' : ''}${timeDiff} seconds`);
            this.log(`[DEBUG] Nonce: ${nonceHex} (raw: 0x${nonce.toString(16)}), Solution length: ${solutionHex.length / 2} bytes`);
            this.log(`[DEBUG] Solution first 32 bytes: ${solutionHex.substring(0, 64)}`);
            this.log(`[DEBUG] Solution last 32 bytes: ${solutionHex.substring(solutionHex.length - 64)}`);
            this.log(`[DEBUG] Submit params: job_id=${work.job_id}, ntime=${ntimeHex}, nonce=${nonceHex}, solution_len=${solutionHex.length / 2}`);
        }

        // 3. Construct the Stratum Payload
        // Parameters for Verus: [worker_name, job_id, ntime, nonce, solution]
        // NOTE: Verus Stratum does NOT use extranonce2 in mining.submit!
        // See cpu-miner-verus stratum.cpp line 1229: [user, jobid, timehex, noncestr, solhex]
        // Allow per-share override of the worker by passing `worker` (device id / suffix).
        // If provided, append it to the base wallet (before any existing dot): base.workerSuffix
        let submitUser = config.poolUser;
        if (worker && typeof worker === 'string' && worker.length) {
            const base = config.poolUser ? String(config.poolUser).split('.')[0] : '';
            submitUser = base ? `${base}.${worker}` : worker;
        }

        const params = [
            submitUser,                 // worker: base wallet + optional device suffix
            work.job_id,                // job_id from mining.notify
            ntimeHex,                   // ntime (byte-swapped from work.data[25])
            nonceHex,                   // 4-byte nonce hex (Little-Endian)
            solutionHex                 // 1347-byte solution hex
        ];

        console.log(`[DEBUG] About to send mining.submit to pool with params:`, params.map(p => 
            typeof p === 'string' && p.length > 100 ? `${p.substring(0, 50)}... (${p.length} chars)` : p
        ));
        
        // Log what we're about to send
        console.log(`[DEBUG] submitShare calling sendRequest('mining.submit', ...)`);
        
        const doSubmit = () => {
            this.sendRequest('mining.submit', params, (error, result) => {
                let accepted = false;
                let reason = null;
                if (error) {
                    console.error(`[ERROR] Share submission error from pool:`, error);
                    this.log(`Share submission error: ${error.message || JSON.stringify(error)}`);
                    this.rejectedShares++;
                    reason = error.message || JSON.stringify(error);
                } else if (result === true) {
                    this.acceptedShares++;
                    accepted = true;
                    console.log(`[SUCCESS] Share accepted by pool! Nonce: 0x${nonce.toString(16)}`);
                    this.log(`✓ Share accepted! Nonce: 0x${nonce.toString(16)}`);
                } else {
                    this.rejectedShares++;
                    reason = JSON.stringify(result);
                    console.error(`[REJECTED] Share rejected by pool:`, result);
                    this.log(`✗ Share rejected: ${result}`);
                }

                console.log(`[STATS] Shares accepted: ${this.acceptedShares} / rejected: ${this.rejectedShares}`);

                // Notify caller (WebSocket server) about result so UI updates
                try {
                    if (typeof resultCallback === 'function') {
                        resultCallback({ accepted, reason });
                    }
                } catch (cbErr) {
                    console.error('[ERROR] resultCallback threw:', cbErr);
                }
            });
        };

        // If submitUser is different from the base authorized user, try authorizing it first
        // Some pools require mining.authorize per worker; avoid repeating by tracking authorizedWorkers
        if (submitUser && submitUser !== config.poolUser && !this.authorizedWorkers.has(submitUser)) {
            if (config.debug) this.log(`Authorizing worker before submit: ${submitUser}`);
            this.sendRequest('mining.authorize', [submitUser, config.poolPass], (err, res) => {
                if (err) {
                    console.error(`[WARN] Per-worker authorize failed for ${submitUser}:`, err.message || err);
                    // Proceed to submit anyway; pool may accept mining.submit without explicit authorize
                    doSubmit();
                    return;
                }
                if (res === true) {
                    this.authorizedWorkers.add(submitUser);
                    if (config.debug) this.log(`Per-worker authorize succeeded for ${submitUser}`);
                } else {
                    if (config.debug) this.log(`Per-worker authorize returned non-true for ${submitUser}: ${JSON.stringify(res)}`);
                }
                doSubmit();
            });
        } else {
            doSubmit();
        }

        console.log(`[DEBUG] submitShare returned - share submission initiated`);

        return true;
    }

    log(message) {
        if (config.debug) {
            console.log(`[Stratum] ${new Date().toISOString()} ${message}`);
        }
    }
}

// WebSocket server
class WebSocketServer {
    constructor(server) {
        this.wss = new WebSocket.Server({ server });
        this.clients = new Map();  // Changed to Map to track client info
        this.nextClientId = 0;
        this.currentWork = null;
        this.previousJobId = null;  // Track previous job to allow shares for it
        this.lastCleanJobId = null; // Track last clean job - jobs before this are invalid
        this.submittedShares = new Set(); // Track submitted shares for deduplication
        
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
    }
    
    // Calculate nonce range for a client based on total clients
    getNonceRange(clientId) {
        const clientCount = this.clients.size || 1;
        const totalNonceSpace = 0xFFFFFFFF;
        const rangeSize = Math.floor(totalNonceSpace / clientCount);
        const startNonce = clientId * rangeSize;
        const maxNonce = (clientId === clientCount - 1) ? totalNonceSpace : startNonce + rangeSize - 1;
        return { startNonce, maxNonce };
    }

    handleConnection(ws, req) {
        const clientAddr = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        const clientId = this.nextClientId++;
        
        // Store client with its numeric id and a persistent clientId string (defaults to c<id>)
        this.clients.set(ws, { id: clientId, addr: clientAddr, clientId: `c${clientId}` });
        console.log(`Web miner connected: ${clientAddr} (client ${`c${clientId}`}, total: ${this.clients.size})`);

        // Send current work with unique nonce range for this client
        if (this.currentWork) {
            this.sendWorkToClient(ws, clientId);
        }
        
        // Reassign nonce ranges to all clients when a new one joins
        this.redistributeWork();

        ws.on('message', (message) => {
            this.handleMessage(ws, message);
        });

        ws.on('close', () => {
            const clientInfo = this.clients.get(ws);
            console.log(`Web miner disconnected: ${clientAddr} (client ${clientInfo?.clientId || clientInfo?.id}, remaining: ${this.clients.size - 1})`);
            this.clients.delete(ws);
            // Reassign nonce ranges when a client leaves
            this.redistributeWork();
        });

        ws.on('error', (error) => {
            console.log(`WebSocket error: ${error.message}`);
        });
    }
    
    // Send work to a specific client with its unique nonce range
    sendWorkToClient(ws, clientId) {
        if (!this.currentWork) return;
        
        const clientCount = this.clients.size || 1;
        const totalNonceSpace = 0xFFFFFFFF;
        const rangeSize = Math.floor(totalNonceSpace / clientCount);
        
        // Assign sequential ranges: client 0 gets [0, rangeSize), client 1 gets [rangeSize, 2*rangeSize), etc.
        const clientArray = Array.from(this.clients.values());
        const clientIndex = clientArray.findIndex(c => c.id === clientId);
        const startNonce = clientIndex * rangeSize;
        const maxNonce = (clientIndex === clientCount - 1) ? totalNonceSpace : startNonce + rangeSize - 1;
        
        const workWithRange = {
            ...this.currentWork,
            start_nonce: startNonce,
            max_nonce: maxNonce
        };
        
        const clientInfo = clientArray[clientIndex];
        const clientLabel = clientInfo && clientInfo.clientId ? clientInfo.clientId : `#${clientId}`;
        console.log(`[NONCE] Client ${clientLabel} assigned range: 0x${startNonce.toString(16)} - 0x${maxNonce.toString(16)} (${((maxNonce - startNonce) / totalNonceSpace * 100).toFixed(1)}% of space)`);
        
        ws.send(JSON.stringify({
            type: 'work',
            work: workWithRange
        }));
    }
    
    // Redistribute nonce ranges to all connected clients
    redistributeWork() {
        if (!this.currentWork || this.clients.size === 0) return;
        
        console.log(`[NONCE] Redistributing work among ${this.clients.size} clients`);
        
        this.clients.forEach((clientInfo, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                this.sendWorkToClient(ws, clientInfo.id);
            }
        });
    }

    handleMessage(ws, message) {
        try {
            const messageStr = message.toString();
            console.log(`[DEBUG] ========== RECEIVED MESSAGE FROM MINER ==========`);
            console.log(`[DEBUG] Message length: ${messageStr.length} bytes`);
            console.log(`[DEBUG] Message preview (first 500 chars): ${messageStr.substring(0, 500)}`);
            
            let data = null;
            try {
                data = JSON.parse(messageStr);
                console.log(`[DEBUG] JSON parse successful. Message type: ${data.type}`);
            } catch (parseErr) {
                console.error(`[ERROR] JSON parse failed:`, parseErr);
                console.error(`[ERROR] Failed message content: ${messageStr.substring(0, 1000)}`);
                return;
            }
            
            switch (data.type) {
                case 'identify':
                    // Allow client to set a persistent `clientId` (string) to be used as worker suffix
                    if (data.clientId && typeof data.clientId === 'string') {
                        const info = this.clients.get(ws) || {};
                        info.clientId = data.clientId.replace(/\s+/g, '_');
                        this.clients.set(ws, info);
                        console.log(`[INFO] Client identified as ${info.clientId}`);
                        // Re-assign work so logs and worker suffix use new id
                        this.sendWork(ws, this.currentWork);
                    }
                    break;
                case 'share':
                    console.log(`[DEBUG] ========== PROCESSING SHARE MESSAGE ==========`);
                    console.log(`[DEBUG] Share message has work: ${!!data.work}`);
                    console.log(`[DEBUG] Share message has nonce: ${data.nonce !== undefined && data.nonce !== null}`);
                    console.log(`[DEBUG] Share message job_id: ${data.work ? data.work.job_id : 'missing'}`);
                    console.log(`[DEBUG] Share message nonce: 0x${data.nonce ? data.nonce.toString(16) : 'null'}`);
                    this.handleShare(ws, data);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                default:
                    console.log(`[WARNING] Unknown message type from miner: ${data.type}`);
                    console.log(`[WARNING] Message keys:`, Object.keys(data));
            }
        } catch (err) {
            console.error(`[ERROR] Exception in handleMessage:`, err);
            console.error(`[ERROR] Error message: ${err.message}`);
            console.error(`[ERROR] Error stack:`, err.stack);
            console.error(`[ERROR] Message content: ${message.toString().substring(0, 500)}`);
        }
    }

    handleShare(ws, data) {
        console.log(`[DEBUG] handleShare called with data:`, {
            hasWork: !!data.work,
            hasNonce: data.nonce !== undefined && data.nonce !== null,
            nonce: data.nonce,
            jobId: data.work ? data.work.job_id : 'missing',
            currentWorkJobId: this.currentWork ? this.currentWork.job_id : 'no current work'
        });
        
        if (!data.work || data.nonce === undefined || data.nonce === null) {
            console.error(`[REJECTED] Share rejected: missing work or nonce data`);
            console.error(`[REJECTED]   hasWork: ${!!data.work}, hasNonce: ${data.nonce !== undefined && data.nonce !== null}`);
            return;
        }

        const shareJobId = data.work.job_id;

        // Check against the current job the server is tracking from the pool
        if (!this.currentWork) {
            console.error(`[REJECTED] Share rejected: No current work set on server`);
            return;
        }
        
        // Share validation logic:
        // When clean=false: Only job ID is updated, miners continue mining, shares for previous job are still valid
        // When clean=true: Miners are stopped and restarted, all jobs BEFORE the clean job are invalidated
        // 
        // Strategy:
        // 1. Always accept shares for current job
        // 2. Accept shares for previous job IF they came after (or equal to) the last clean job
        // 3. Reject all other shares (too old or invalidated by clean job)
        
        const isCurrentJob = shareJobId === this.currentWork.job_id;
        const isPreviousJob = this.previousJobId && shareJobId === this.previousJobId;
        
        console.log(`[DEBUG] Share validation: shareJobId=${shareJobId}, currentJob=${this.currentWork.job_id}, previousJob=${this.previousJobId || 'none'}, lastCleanJob=${this.lastCleanJobId || 'none'}`);
        console.log(`[DEBUG]   isCurrentJob=${isCurrentJob}, isPreviousJob=${isPreviousJob}`);
        
        // Check if this job came after the last clean job (if a clean job exists)
        // If a clean job arrived (e.g., 70e34), only jobs >= that clean job are valid
        // So a share for 70df7 would be rejected because 70df7 < 70e34
        let isValidAfterClean = true;
        if (this.lastCleanJobId) {
            // Parse job IDs as hex numbers for comparison
            const shareJobNum = parseInt(shareJobId, 16);
            const cleanJobNum = parseInt(this.lastCleanJobId, 16);
            isValidAfterClean = !isNaN(shareJobNum) && !isNaN(cleanJobNum) && shareJobNum >= cleanJobNum;
            console.log(`[DEBUG]   Clean job check: ${shareJobId} (${shareJobNum}) >= ${this.lastCleanJobId} (${cleanJobNum}) = ${isValidAfterClean}`);
        } else {
            console.log(`[DEBUG]   No clean job recorded, all recent jobs are valid`);
        }
        
        // Allow shares for:
        // 1. Current job (always valid)
        // 2. Any job that came after (or equal to) the last clean job
        //    This allows shares for previous jobs and even older jobs, as long as they weren't invalidated
        //    by a clean job. When clean=false, multiple jobs can arrive, and shares for older jobs
        //    (that came after the last clean job) should still be valid.
        const isValidShare = isCurrentJob || isValidAfterClean;
        
        if (!isValidShare) {
            let reason = '';
            if (this.lastCleanJobId) {
                reason = `Share is for job ${shareJobId}, which came before the last clean job ${this.lastCleanJobId}. All jobs before a clean job are invalidated.`;
            } else {
                reason = `Share is for job ${shareJobId}, which is neither the current job (${this.currentWork.job_id}) nor a valid previous job.`;
            }
            
            // TESTING: Submit stale shares anyway to verify hash computation is correct
            // The pool will likely reject with "job not found" or similar, but if we get
            // "low difficulty" it means the hash is still wrong, and if we get accepted
            // or "stale" from pool, the hash is correct.
            console.warn(`[STALE] Share is stale but submitting anyway for testing: Job ${shareJobId}`);
            console.warn(`[STALE]   Current: ${this.currentWork.job_id}, Previous: ${this.previousJobId || 'none'}, LastClean: ${this.lastCleanJobId || 'none'}`);
            console.warn(`[STALE]   Reason: ${reason}`);
            // Continue to submit instead of returning
        }
        
        console.log(`[DEBUG] Share validation PASSED - share will be submitted to pool`);
        
        console.log(`[DEBUG] Share passed job_id validation (job: ${shareJobId}, current: ${this.currentWork.job_id}, previous: ${this.previousJobId || 'none'}). Proceeding with submission...`);

        const shareKey = `${data.work.job_id}:${data.nonce}`;
        
        // Deduplicate shares (like cpu-miner-verus prevents duplicate nonce submissions)
        if (this.submittedShares.has(shareKey)) {
            console.log(`Duplicate share ignored: nonce=0x${data.nonce.toString(16)}, job_id=${data.work.job_id}`);
            return;
        }
        
        this.submittedShares.add(shareKey);
        
        // Clean up old shares (keep only last 100)
        if (this.submittedShares.size > 100) {
            const keys = Array.from(this.submittedShares);
            this.submittedShares.delete(keys[0]);
        }

        console.log(`Share received: nonce=0x${data.nonce.toString(16)}, job_id=${data.work.job_id}`);
        
        if (config.debug) {
            console.log(`[Stratum] Received work.data[30] (nonce in block): 0x${data.work.data[30].toString(16)}`);
            console.log(`[Stratum] Passed nonce parameter: 0x${data.nonce.toString(16)}`);
            console.log(`[Stratum] Match: ${data.work.data[30] === data.nonce}`);
        }
        
        // Validate extra exists and has correct size (WASM fills this when share is found)
        // The extra comes as an Array from JSON, we need to convert it to a Buffer
        let extra = data.work.extra || data.extra;
        if (!extra) {
            console.error(`[REJECTED] Share rejected: no extra data provided`);
            console.error(`[REJECTED]   data.work.extra: ${!!data.work.extra}, data.extra: ${!!data.extra}`);
            return;
        }
        
        // Convert array to Buffer if needed (comes as array from JSON)
        if (Array.isArray(extra)) {
            extra = Buffer.from(extra);
            console.log(`[DEBUG] Converted extra array to Buffer: ${extra.length} bytes`);
        } else if (Buffer.isBuffer(extra)) {
            console.log(`[DEBUG] Extra is already a Buffer: ${extra.length} bytes`);
        } else {
            // Try to convert
            try {
                extra = Buffer.from(extra);
                console.log(`[DEBUG] Converted extra to Buffer: ${extra.length} bytes`);
            } catch (e) {
                console.error(`[REJECTED] Cannot convert extra to Buffer:`, e);
                return;
            }
        }
        
        if (extra.length < 1347) {
            console.error(`[REJECTED] Share rejected: extra too small (${extra.length} bytes, need 1347)`);
            return;
        }
        
        console.log(`[DEBUG] Extra validation passed: ${extra.length} bytes`);
        
        console.log(`[DEBUG] Share validation passed. Calling stratumClient.submitShare...`);
        console.log(`[DEBUG]   job_id: ${data.work.job_id}`);
        console.log(`[DEBUG]   nonce: 0x${data.nonce.toString(16)}`);
        console.log(`[DEBUG]   extra.length: ${extra.length} bytes`);
        
        // Submit to pool (use work.extra, not work.solution!)
        // Derive a per-client suffix: prefer miner-provided `worker`/`workerId`/`deviceId`,
        // otherwise use server-assigned client id.
        const clientInfo = this.clients.get(ws) || {};
        let deviceSuffix = null;
        if (data.worker && typeof data.worker === 'string') deviceSuffix = data.worker;
        else if (data.workerId) deviceSuffix = data.workerId;
        else if (data.deviceId) deviceSuffix = data.deviceId;
        else if (clientInfo.clientId) deviceSuffix = clientInfo.clientId;
        else if (clientInfo.id !== undefined) deviceSuffix = `c${clientInfo.id}`;
        if (typeof deviceSuffix === 'string') deviceSuffix = deviceSuffix.replace(/\s+/g, '_');

        console.log(`[DEBUG] Submitting share on behalf of worker suffix: ${deviceSuffix || '(none)'} (pool user base: ${config.poolUser})`);

        const submitResult = stratumClient.submitShare(data.work, data.nonce, extra, deviceSuffix, (res) => {
            // Send share_result back to originating client so UI updates counters
            try {
                ws.send(JSON.stringify({
                    type: 'share_result',
                    accepted: !!res.accepted,
                    reason: res.reason || null
                }));
            } catch (e) {
                console.error('[ERROR] Failed to send share_result to client:', e);
            }
        });

        if (submitResult) {
            console.log(`[DEBUG] submitShare returned true - share should be submitted to pool`);
        } else {
            console.error(`[ERROR] submitShare returned false - share was NOT submitted to pool!`);
        }
    }

    sendWork(ws, work) {
        // Use the nonce-range aware method if client is tracked
        const clientInfo = this.clients.get(ws);
        if (clientInfo) {
            this.sendWorkToClient(ws, clientInfo.id);
        } else {
            // Fallback for untracked clients
            ws.send(JSON.stringify({
                type: 'work',
                work: work
            }));
        }
    }

    broadcastWork(work) {
        // Track previous job before updating current
        // This allows shares for the previous job if it wasn't invalidated by a clean job
        if (this.currentWork && this.currentWork.job_id !== work.job_id) {
            this.previousJobId = this.currentWork.job_id;
            console.log(`[DEBUG] Previous job tracked: ${this.previousJobId} -> Current: ${work.job_id}`);
        }
        
        this.currentWork = work;
        
        // Send work to each client with their unique nonce range
        console.log(`[NONCE] Broadcasting new job ${work.job_id} to ${this.clients.size} clients with unique ranges`);
        this.clients.forEach((clientInfo, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                this.sendWorkToClient(ws, clientInfo.id);
            }
        });
    }

    broadcastInterrupt(newJobId) {
        // Track clean job - when a clean job arrives, all previous jobs are invalidated
        // IMPORTANT: This clean job invalidates all jobs that came BEFORE it
        // Only jobs >= this clean job ID are valid after this point
        this.lastCleanJobId = newJobId;
        console.log(`[DEBUG] Clean job recorded: ${newJobId} - all jobs before this are now invalid`);
        
        const message = JSON.stringify({
            type: 'interrupt',
            newJobId: newJobId
        });
        
        this.clients.forEach((clientInfo, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }
    
    // Helper method to compare job IDs (assumes they're hex strings that can be converted to integers)
    // Returns true if jobId1 came after jobId2 (or they're equal), false otherwise
    isJobIdAfter(jobId1, jobId2) {
        try {
            const id1 = parseInt(jobId1, 16);
            const id2 = parseInt(jobId2, 16);
            return !isNaN(id1) && !isNaN(id2) && id1 >= id2;
        } catch (e) {
            // If we can't parse as hex, do string comparison
            return jobId1 >= jobId2;
        }
    }
}

// Main
console.log('Verus Miner WebSocket Server');
console.log(`Pool: ${config.poolUrl}`);
console.log(`User: ${config.poolUser}`);
console.log(`WebSocket Port: ${config.wsPort}`);
console.log('');

// Create HTTP server to serve static files
const httpServer = http.createServer((req, res) => {
    // Get the file path, strip query parameters
    const urlPath = req.url.split('?')[0];
    let filePath = path.join(__dirname, '..', urlPath === '/' ? 'miner-client.html' : urlPath.substring(1));
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(path.join(__dirname, '..'))) {
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
            'Cache-Control': 'no-cache' // Prevent caching during development
        });
        
        // Stream the file
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

httpServer.listen(config.wsPort, '0.0.0.0', () => {
    console.log(`HTTP server listening on http://localhost:${config.wsPort}`);
});

const stratumClient = new StratumClient();
const wss = new WebSocketServer(httpServer);

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
