/**
 * Stratum Protocol Client
 * Communicates with mining pool using Stratum protocol
 */

const net = require('net');
const crypto = require('crypto');
const { config } = require('./config');

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
        this.lastNotifyParams = null;
        this.authorizedWorkers = new Set();
        this.acceptedShares = 0;
        this.rejectedShares = 0;
        this.workCallback = null;
        this.interruptCallback = null;
    }

    setWorkCallback(callback) {
        this.workCallback = callback;
    }

    setInterruptCallback(callback) {
        this.interruptCallback = callback;
    }

    connect() {
        if (this.socket) {
            this.socket.destroy();
        }

        this.log(`Connecting to pool ${config.poolInfo.host}:${config.poolInfo.port}...`);
        this.socket = net.createConnection(config.poolInfo.port, config.poolInfo.host);

        this.socket.on('connect', () => {
            this.log('Connected to pool');
            this.connected = true;
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
            
            if (result && Array.isArray(result) && result.length >= 2) {
                this.sessionId = result[0];
                const extraNonce1 = result[1];
                this.xnonce1 = Buffer.from(extraNonce1, 'hex');
                this.xnonce1Size = this.xnonce1.length;
                this.xnonce2Size = result[2] || 4;
                this.log(`Session ID: ${this.sessionId}, xnonce1: ${extraNonce1}, xnonce2_size: ${this.xnonce2Size}`);
            }
            
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
        }, 30000);
    }

    handlePoolMessage(data) {
        const lines = data.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            this.log(`← Pool: ${line}`);
            
            try {
                const message = JSON.parse(line);
                
                if (message.id !== undefined && message.id !== null) {
                    const callback = this.pendingRequests.get(message.id);
                    if (callback) {
                        this.pendingRequests.delete(message.id);
                        if (message.error) {
                            const errorMsg = typeof message.error === 'string' 
                                ? message.error 
                                : (message.error.message || JSON.stringify(message.error));
                            callback(new Error(errorMsg), null);
                        } else {
                            callback(null, message.result);
                        }
                    }
                    continue;
                }
                
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

        const jobId = params[0];
        const version = params[1];
        const prevhash = params[2];
        const coinb1 = params[3];
        const coinb2 = params[4];
        const ntime = params[5];
        
        if (config.debug) {
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
        const poolClean = params[7] || false;
        const solution = params[8] || null;

        const clean = poolClean && (!this.currentJob || this.currentJob.jobId !== jobId);

        this.log(`New job: ${jobId} (clean: ${clean})`);
        
        if (config.debug) {
            this.log(`  version: ${version}`);
            this.log(`  nbits: ${nbits}`);
            this.log(`  solution length: ${solution ? Buffer.from(solution, 'hex').length : 0}`);
            this.log(`  difficulty: ${this.currentDifficulty}`);
        }

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

        this.incrementXnonce2();

        const work = this.buildWork(jobId, version, prevhash, coinb1, coinb2, ntime, nbits, clean, solution);
        
        this.currentJob = {
            jobId: jobId,
            work: work,
            clean: clean,
            timestamp: Date.now()
        };

        if (clean) {
            this.log(`clean_jobs=true: Interrupting all workers for new job ${jobId}`);
            if (this.interruptCallback) this.interruptCallback(jobId);
            setTimeout(() => {
                if (this.workCallback) this.workCallback(work);
            }, 100);
        } else {
            if (this.workCallback) this.workCallback(work);
        }
    }

    handleSetDifficulty(params) {
        if (params && params.length > 0) {
            const newDifficulty = parseFloat(params[0]);
            this.currentDifficulty = newDifficulty;
            this.log(`Difficulty set to: ${this.currentDifficulty}`);
            
            if (!this.currentTarget || this.currentTarget.length < 32) {
                const calculatedTarget = this.difficultyToTarget(newDifficulty);
                if (calculatedTarget) {
                    this.currentTarget = Buffer.alloc(32);
                    for (let i = 0; i < 8; i++) {
                        this.currentTarget.writeUInt32LE(calculatedTarget[i], i * 4);
                    }
                    this.log(`Target calculated from difficulty ${newDifficulty}: ${this.currentTarget.toString('hex')}`);
                    
                    if (this.currentJob && this.lastNotifyParams) {
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
                        
                        this.currentJob.work = updatedWork;
                        
                        this.log(`Broadcasting updated work with new difficulty ${newDifficulty}`);
                        if (this.workCallback) this.workCallback(updatedWork);
                    }
                }
            }
        }
    }

    difficultyToTarget(difficulty) {
        if (difficulty <= 0) return new Array(8).fill(0);
        
        const targetMsb = Math.floor(0x00000020 / difficulty);
        
        const target = new Array(8).fill(0);
        target[7] = targetMsb >>> 0;
        
        if (config.debug) {
            this.log(`Difficulty ${difficulty} -> target MSB: 0x${targetMsb.toString(16).padStart(8, '0')}`);
        }
        
        return target;
    }

    handleSetTarget(params) {
        if (params && params.length > 0) {
            const targetHex = params[0];
            this.currentTarget = Buffer.from(targetHex, 'hex');
            this.isEquihash = true;
            console.log(`[POOL] Target set (raw): ${targetHex}`);
            console.log(`[POOL] Target buffer length: ${this.currentTarget.length} bytes`);
            this.log(`Target set (raw): ${targetHex}`);
            this.log(`Target buffer length: ${this.currentTarget.length} bytes`);
            
            if (this.currentTarget.length >= 32) {
                const reversed = Buffer.alloc(32);
                for (let i = 0; i < 32; i++) {
                    reversed[i] = this.currentTarget[31 - i];
                }
                
                const targetArray = new Array(8);
                for (let i = 0; i < 8; i++) {
                    targetArray[i] = reversed.readUInt32LE(i * 4);
                }
                
                console.log(`[POOL] Target array after reversal and LE reading: [${targetArray.map(x => '0x' + x.toString(16).padStart(8, '0')).join(', ')}]`);
                console.log(`[POOL] Target[7] (MSB): 0x${targetArray[7].toString(16)}`);
                
                const calcDiff = this.calculateDifficultyFromTarget(targetArray);
                console.log(`[POOL] Calculated difficulty from target: ${calcDiff.toFixed(6)}`);
                
                if (this.currentJob && this.currentJob.work) {
                    this.currentJob.work.target = targetArray;
                    this.currentJob.work.targetdiff = calcDiff;
                    
                    this.log(`Target array updated: [${targetArray.map(x => '0x' + x.toString(16).padStart(8, '0')).join(', ')}]`);
                    this.log(`Target difficulty: ${calcDiff}`);
                    
                    if (this.workCallback) this.workCallback(this.currentJob.work);
                } else {
                    this.log(`[INFO] Target set but no current job yet - will apply when next job arrives`);
                }
            }
        }
    }

    calculateDifficultyFromTarget(targetArray) {
        if (!targetArray || targetArray.length < 8) return 1.0;
        
        const targetBin = Buffer.alloc(32);
        for (let i = 0; i < 8; i++) {
            const uint32 = targetArray[7 - i];
            targetBin.writeUInt32BE(uint32, i * 4);
        }
        
        const targetBe = Buffer.alloc(32);
        let bitsStart = null;
        for (let i = 0; i < 32; i++) {
            targetBe[31 - i] = targetBin[i];
            if (targetBin[i] !== 0 && bitsStart === null) {
                bitsStart = i;
            }
        }
        
        if (bitsStart === null) return 1.0;
        
        const padding = 31 - bitsStart;
        const exponent = Math.ceil((padding * 8 + 1) / 8);
        
        const offset = exponent - 3;
        let coefficient = 0;
        if (offset >= 0 && offset + 2 < 32) {
            coefficient = (targetBe[offset] & 0xFF) | 
                         ((targetBe[offset + 1] & 0xFF) << 8) |
                         ((targetBe[offset + 2] & 0xFF) << 16);
        }
        
        const targetBits = coefficient | (exponent << 24);
        
        const exponentByte = (targetBits >>> 24) & 0xFF;
        const significand = targetBits & 0xFFFFFF;
        
        if (significand === 0) return 1.0;
        
        const exponentDiff = 8 * (0x20 - exponentByte);
        const diff = (0x0f0f0f / significand) * Math.pow(2, exponentDiff);
        
        if (config.debug) {
            this.log(`calculateDifficultyFromTarget: padding=${padding}, exponent=0x${exponent.toString(16)}, targetBits=0x${targetBits.toString(16)}, significand=0x${significand.toString(16)}, exponentDiff=${exponentDiff}, diff=${diff.toFixed(6)}`);
        }
        
        return diff;
    }

    incrementXnonce2() {
        for (let i = 0; i < this.xnonce2.length; i++) {
            this.xnonce2[i]++;
            if (this.xnonce2[i] !== 0) break;
        }
    }

    buildWork(jobId, version, prevhash, coinb1, coinb2, ntime, nbits, clean, solution) {
        const prevhashBuf = Buffer.from(prevhash, 'hex');
        const coinb1Buf = Buffer.from(coinb1, 'hex');
        const coinb2Buf = Buffer.from(coinb2, 'hex');
        const versionBuf = Buffer.from(version, 'hex');
        const nbitsBuf = Buffer.from(nbits, 'hex');
        const ntimeBuf = Buffer.from(ntime, 'hex');
        
        const data = new Array(48).fill(0);
        
        data[0] = versionBuf.readUInt32LE(0);
        
        for (let i = 0; i < 8; i++) {
            data[1 + i] = prevhashBuf.readUInt32LE(i * 4);
        }
        
        for (let i = 0; i < 8; i++) {
            data[9 + i] = coinb1Buf.readUInt32LE(i * 4);
        }
        
        for (let i = 0; i < 8; i++) {
            data[17 + i] = coinb2Buf.readUInt32LE(i * 4);
        }
        
        data[25] = ntimeBuf.readUInt32LE(0);
        
        data[26] = nbitsBuf.readUInt32LE(0);
        
        const xnonce1Words = Math.min(8, Math.ceil(this.xnonce1Size / 4));
        for (let i = 0; i < xnonce1Words; i++) {
            if (this.xnonce1 && i * 4 < this.xnonce1.length) {
                data[27 + i] = this.xnonce1.readUInt32LE(i * 4);
            }
        }
        
        const xnonce2Words = Math.min(8, Math.ceil(this.xnonce2Size / 4));
        const xnonce2Start = 27 + xnonce1Words;
        for (let i = 0; i < xnonce2Words; i++) {
            if (i * 4 < this.xnonce2.length) {
                data[xnonce2Start + i] = this.xnonce2.readUInt32LE(i * 4);
            }
        }
        
        data[35] = 0x80;
        
        let solutionBuf;
        if (solution && typeof solution === 'string') {
            solutionBuf = Buffer.from(solution, 'hex');
        } else {
            solutionBuf = Buffer.alloc(1347);
        }
        
        const target = new Array(8).fill(0);
        
        if (this.currentTarget && this.currentTarget.length >= 32) {
            const reversed = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) {
                reversed[i] = this.currentTarget[31 - i];
            }
            
            for (let i = 0; i < 8; i++) {
                target[i] = reversed.readUInt32LE(i * 4);
            }
            
            if (config.debug) {
                this.log(`Target from mining.set_target: ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
                this.log(`Target MSB (index 7): 0x${target[7].toString(16)}`);
            }
        } 
        else if (this.currentDifficulty > 0) {
            const diffTarget = this.difficultyToTarget(this.currentDifficulty);
            if (diffTarget) {
                for (let i = 0; i < 8; i++) {
                    target[i] = diffTarget[i];
                }
                this.log(`Target from difficulty ${this.currentDifficulty}: ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
            }
        }
        else if (nbitsBuf && nbitsBuf.length === 4) {
            const nbitsValue = nbitsBuf.readUInt32LE(0);
            const exponent = (nbitsValue >>> 24) & 0xFF;
            const mantissa = nbitsValue & 0x00FFFFFF;
            
            if (exponent <= 3) {
                const shift = 3 - exponent;
                const value = mantissa >>> (shift * 8);
                target[7] = value >>> 0;
            } else {
                const offset = exponent - 3;
                if (offset <= 29) {
                    let value = 0;
                    if (offset <= 29) value |= (mantissa >>> 16) & 0xFF;
                    if (offset <= 30) value |= (mantissa >>> 8) & 0xFF;
                    if (offset <= 31) value |= mantissa & 0xFF;
                    target[7 - offset] = value;
                }
            }
            this.log(`WARNING: Using NETWORK target from nbits (VERY HARD!): ${target.map(x => x.toString(16).padStart(8, '0')).join(' ')}`);
        }

        const solutionArrayOriginal = Array.from(solutionBuf);
        
        if (config.debug) {
            this.log(`Building work: solution from pool is ${solutionArrayOriginal.length} bytes`);
            this.log(`First 32 bytes of solution: ${Buffer.from(solutionArrayOriginal.slice(0, 32)).toString('hex')}`);
        }
        
        const extraArray = new Array(1388).fill(0);
        extraArray[0] = 0xfd;
        extraArray[1] = 0x40;
        extraArray[2] = 0x05;
        for (let i = 0; i < solutionArrayOriginal.length && i < 1344; i++) {
            extraArray[3 + i] = solutionArrayOriginal[i];
        }
        
        if (config.debug) {
            this.log(`Extra array initialized with ${solutionArrayOriginal.length} bytes of template`);
            this.log(`First 32 bytes of extra: ${Buffer.from(extraArray.slice(0, 32)).toString('hex')}`);
        }
        
        // Build FIXED 15-byte pool nonce field to match verusscan.cpp exactly
        // Structure: pool nonce (4 bytes) + round/xnonce2 (4 bytes) + thread id (1 byte) + padding (2 bytes) + counting nonce (4 bytes)
        const VERUS_NONCE_SIZE = 15;
        const poolNonce = Buffer.alloc(VERUS_NONCE_SIZE, 0);
        
        // Bytes 0-3: xnonce1 (pool nonce, typically 4 bytes)
        if (this.xnonce1 && this.xnonce1.length > 0) {
            const xnonce1Len = Math.min(this.xnonce1.length, 4);
            this.xnonce1.copy(poolNonce, 0, 0, xnonce1Len);
        }
        
        // Bytes 4-7: xnonce2 (round, typically 4 bytes)
        if (this.xnonce2 && this.xnonce2.length > 0) {
            const xnonce2Len = Math.min(this.xnonce2.length, 4);
            this.xnonce2.copy(poolNonce, 4, 0, xnonce2Len);
        }
        
        // Bytes 8-10: thread id (1 byte) + padding (2 bytes) - leave as 0 for web miners
        // poolNonce[8] = 0;  // thread id
        // poolNonce[9] = 0;  // padding byte 1  
        // poolNonce[10] = 0; // padding byte 2
        
        // Bytes 11-14: counting nonce placeholder (will be updated at submitShare)
        // Leave as zeros for now
        
        // Copy the 15-byte pool nonce field into extra array at position 1332
        for (let i = 0; i < VERUS_NONCE_SIZE; i++) {
            if (1332 + i < extraArray.length) {
                extraArray[1332 + i] = poolNonce[i];
            }
        }
        
        if (config.debug) {
            console.log(`[POOL NONCE] Initialized at extra[1332] with FIXED ${VERUS_NONCE_SIZE}-byte Verus format:`);
            console.log(`[POOL NONCE]   Bytes 0-3 (xnonce1): ${poolNonce.slice(0, 4).toString('hex')}`);
            console.log(`[POOL NONCE]   Bytes 4-7 (xnonce2): ${poolNonce.slice(4, 8).toString('hex')}`);
            console.log(`[POOL NONCE]   Bytes 8-10 (thread+padding): ${poolNonce.slice(8, 11).toString('hex')}`);
            console.log(`[POOL NONCE]   Bytes 11-14 (nonce placeholder): ${poolNonce.slice(11, 15).toString('hex')} (will be updated at submit)`);
            console.log(`[POOL NONCE]   Full poolNonce: ${poolNonce.toString('hex')}`);
        }
        
        const solutionArray = Array(1344).fill(0);
        for (let i = 0; i < Math.min(solutionBuf.length, 1344); i++) {
            solutionArray[i] = solutionBuf[i];
        }
        
        if (config.debug) {
            this.log(`Solution padded to 1344 bytes (original: ${solutionBuf.length})`);
        }
        
        const workDifficulty = this.calculateDifficultyFromTarget(target);
        
        // Store xnonce1 and xnonce2 values at time of work creation
        // These MUST be used when submitting, not the current values
        const xnonce1Copy = this.xnonce1 ? Buffer.from(this.xnonce1) : Buffer.alloc(4);
        const xnonce2Copy = this.xnonce2 ? Buffer.from(this.xnonce2) : Buffer.alloc(4);
        
        const work = {
            data: data,
            target: target,
            solution: solutionArray,
            extra: extraArray,
            start_nonce: 0,
            max_nonce: 0xFFFFFFFF,
            job_id: jobId,
            targetdiff: workDifficulty,
            ntime: ntime,
            xnonce1: Array.from(xnonce1Copy),  // Store as array for JSON serialization
            xnonce2: Array.from(xnonce2Copy),  // Store as array for JSON serialization
            xnonce1Size: this.xnonce1Size,
            xnonce2Size: this.xnonce2Size
        };

        this.log(`Work built: job=${jobId}, target[7]=0x${target[7].toString(16)}, diff≈${workDifficulty.toFixed(6)}`);
        
        return work;
    }

    calculateMerkleRoot(coinbase, merkleBranches) {
        const hash1 = crypto.createHash('sha256');
        hash1.update(coinbase);
        let merkle = hash1.digest();
        
        if (merkleBranches && Array.isArray(merkleBranches)) {
            for (const branch of merkleBranches) {
                const branchBuf = Buffer.from(branch, 'hex');
                const combined = Buffer.concat([merkle, branchBuf]);
                const hash2 = crypto.createHash('sha256');
                hash2.update(combined);
                merkle = hash2.digest();
            }
        }
        
        const hash3 = crypto.createHash('sha256');
        hash3.update(merkle);
        const hash4 = crypto.createHash('sha256');
        hash4.update(hash3.digest());
        return hash4.digest();
    }

    submitShare(work, nonce, extra, worker, resultCallback) {
        if (!this.authorized) {
            console.error(`[ERROR] submitShare: Not authorized with pool`);
            return false;
        }

        if (!work) {
            console.error(`[ERROR] submitShare: work object is null or undefined`);
            return false;
        }

        if (!work.job_id) {
            console.error(`[ERROR] submitShare: work.job_id is missing`);
            return false;
        }

        if (nonce === undefined || nonce === null) {
            console.error(`[ERROR] submitShare: nonce is missing or null`);
            return false;
        }

        if (!extra || extra.length < 1347) {
            this.log(`Warning: work.extra is empty or too small (${extra ? extra.length : 0} bytes, need 1347)`);
            return false;
        }

        if (!work.data || !Array.isArray(work.data) || work.data.length < 26) {
            console.error(`[ERROR] submitShare: work.data is invalid (need array with at least 26 elements)`);
            return false;
        }

        let extraForSolution = Buffer.from(extra);
        
        // Build the pool nonce field - ALWAYS 15 bytes (Verus requirement)
        // CRITICAL: Use xnonce1/xnonce2 from the WORK OBJECT, not current values!
        // The xnonce2 is incremented on each new job, so we must use the value
        // that was active when this specific job was created.
        
        // Get xnonce values from work object (stored at job creation time)
        const workXnonce1 = work.xnonce1 ? Buffer.from(work.xnonce1) : (this.xnonce1 || Buffer.alloc(4));
        const workXnonce2 = work.xnonce2 ? Buffer.from(work.xnonce2) : (this.xnonce2 || Buffer.alloc(4));
        const workXnonce1Size = work.xnonce1Size || this.xnonce1Size || 4;
        const workXnonce2Size = work.xnonce2Size || this.xnonce2Size || 4;
        
        console.log(`[SUBMIT] Using xnonce1/xnonce2 from work object (job ${work.job_id}):`);
        console.log(`[SUBMIT]   work.xnonce1: ${workXnonce1.toString('hex')}`);
        console.log(`[SUBMIT]   work.xnonce2: ${workXnonce2.toString('hex')}`);
        console.log(`[SUBMIT]   current this.xnonce2: ${this.xnonce2 ? this.xnonce2.toString('hex') : '(none)'}`);
        
        const VERUS_NONCE_SIZE = 15;
        const poolNonceField = Buffer.alloc(VERUS_NONCE_SIZE, 0);
        
        // Bytes 0-3: xnonce1 (pool nonce, max 4 bytes) - from work object
        if (workXnonce1 && workXnonce1.length > 0) {
            const xnonce1Len = Math.min(workXnonce1.length, 4);
            workXnonce1.copy(poolNonceField, 0, 0, xnonce1Len);
        }
        
        // Bytes 4-7: xnonce2 (round, max 4 bytes) - from work object
        if (workXnonce2 && workXnonce2.length > 0) {
            const xnonce2Len = Math.min(workXnonce2.length, 4);
            workXnonce2.copy(poolNonceField, 4, 0, xnonce2Len);
        }
        
        // Bytes 8-10: thread id (1 byte) + padding (2 bytes) = 0 for web miners
        poolNonceField[8] = 0;  // thread id
        poolNonceField[9] = 0;  // padding byte 1
        poolNonceField[10] = 0; // padding byte 2
        
        // Bytes 11-14: counting nonce (4 bytes, little-endian)
        poolNonceField.writeUInt32LE(nonce >>> 0, 11);
        
        // DEBUG LOGGING: Show pool nonce field construction
        console.log(`[POOL_NONCE] Constructing ${VERUS_NONCE_SIZE}-byte pool nonce field (Verus format):`);
        console.log(`[POOL_NONCE]   Bytes 0-3 (xnonce1):     ${poolNonceField.slice(0, 4).toString('hex')}`);
        console.log(`[POOL_NONCE]   Bytes 4-7 (xnonce2):     ${poolNonceField.slice(4, 8).toString('hex')}`);
        console.log(`[POOL_NONCE]   Bytes 8-10 (thrd+pad):   ${poolNonceField.slice(8, 11).toString('hex')}`);
        console.log(`[POOL_NONCE]   Bytes 11-14 (nonce):     0x${nonce.toString(16).padStart(8, '0')} -> LE: ${poolNonceField.slice(11, 15).toString('hex')}`);
        console.log(`[POOL_NONCE]   Full field (15 bytes):   ${poolNonceField.toString('hex')}`);
        
        // Copy the pool nonce field into the solution at position 1332
        // This is where verusscan.cpp places the nonce data in the solution
        const solutionNonceStart = 1332;
        for (let i = 0; i < VERUS_NONCE_SIZE; i++) {
            if (solutionNonceStart + i < extraForSolution.length) {
                extraForSolution[solutionNonceStart + i] = poolNonceField[i];
            }
        }
        
        // Also update the block header nonce field (work.data[30]) with the counting nonce
        // This ensures the hash calculation uses the correct nonce
        if (work.data && work.data.length > 30) {
            work.data[30] = nonce >>> 0;
            console.log(`[POOL_NONCE]   Updated work.data[30] (header nonce) = 0x${(nonce >>> 0).toString(16).padStart(8, '0')}`);
        }
        
        console.log(`[POOL_NONCE]   Solution bytes ${solutionNonceStart}-${solutionNonceStart + VERUS_NONCE_SIZE - 1}: ${extraForSolution.slice(solutionNonceStart, solutionNonceStart + VERUS_NONCE_SIZE).toString('hex')}`);
        console.log(`[POOL_NONCE]   Full solution size: ${extraForSolution.length} bytes`);
        
        let solutionHex = extraForSolution.slice(0, 1347).toString('hex');
        
        // Restore bytes from work.solution if available
        if (work.solution && Array.isArray(work.solution) && work.solution.length >= 72) {
            const restoreBytes = Buffer.from(work.solution.slice(8, 72));
            const restoreHex = restoreBytes.toString('hex');
            const hexPosition = 6 + 16;
            solutionHex = solutionHex.substring(0, hexPosition) + restoreHex + solutionHex.substring(hexPosition + 128);
        }
        
        // Get ntime
        let ntimeHex = null;
        if (work.data && Array.isArray(work.data) && work.data.length > 25) {
            const ntimeValue = work.data[25];
            const ntimeSwapped = 
                ((ntimeValue & 0xFF) << 24) |
                (((ntimeValue >>> 8) & 0xFF) << 16) |
                (((ntimeValue >>> 16) & 0xFF) << 8) |
                ((ntimeValue >>> 24) & 0xFF);
            ntimeHex = (ntimeSwapped >>> 0).toString(16).padStart(8, '0');
        } else if (work.ntime && typeof work.ntime === 'string' && work.ntime.length === 8) {
            ntimeHex = work.ntime.toLowerCase();
        }
        
        if (!ntimeHex || ntimeHex.length !== 8) {
            this.log(`ERROR: ntime is missing or invalid: ${ntimeHex}`);
            return false;
        }
        
        let submitUser = config.poolUser;
        if (worker && typeof worker === 'string' && worker.length) {
            const base = config.poolUser ? String(config.poolUser).split('.')[0] : '';
            submitUser = base ? `${base}.${worker}` : worker;
        }
        
        // Build noncestr - this is the nonce field WITHOUT the xnonce1 prefix
        // Per ccminer equi-stratum.cpp:
        //   nonce_len = 32 - stratum.xnonce1_size
        //   noncestr = bin2hex(&nonce[stratum.xnonce1_size], nonce_len)
        // So for xnonce1_size=4, we need 28 bytes of nonce data
        // CRITICAL: Use xnonce values from work object, not current values!
        const nonceLen = 32 - workXnonce1Size;
        const nonceBuf = Buffer.alloc(nonceLen, 0);
        
        // The nonce field in Verus block header is at work.data[27] (byte offset 108)
        // Structure: xnonce1 (at start) + xnonce2 + thread_id + padding + counting_nonce
        // We need to submit everything AFTER xnonce1
        
        let offset = 0;
        
        // xnonce2 (typically 4 bytes) - USE FROM WORK OBJECT
        if (workXnonce2 && workXnonce2.length > 0) {
            const xn2Len = Math.min(workXnonce2.length, workXnonce2Size);
            workXnonce2.copy(nonceBuf, offset, 0, xn2Len);
            offset += workXnonce2Size;  // Use declared size, not actual
        } else {
            offset += workXnonce2Size;
        }
        
        // Thread id (1 byte) + padding (2 bytes) - typically 0 for web miners
        nonceBuf[offset] = 0;      // thread id
        nonceBuf[offset + 1] = 0;  // padding 1
        nonceBuf[offset + 2] = 0;  // padding 2
        offset += 3;
        
        // Counting nonce (4 bytes, little-endian)
        nonceBuf.writeUInt32LE(nonce >>> 0, offset);
        offset += 4;
        
        // Remaining bytes (if any) stay as 0
        
        const nonceHex = nonceBuf.toString('hex');
        
        console.log(`[NONCE] Building nonce for submission (Verus format):`);
        console.log(`[NONCE]   xnonce1Size: ${workXnonce1Size}, nonceLen: ${nonceLen} bytes`);
        console.log(`[NONCE]   xnonce2 (bytes 0-${workXnonce2Size-1}): ${nonceBuf.slice(0, workXnonce2Size).toString('hex')}`);
        console.log(`[NONCE]   thread+pad (bytes ${workXnonce2Size}-${workXnonce2Size+2}): ${nonceBuf.slice(workXnonce2Size, workXnonce2Size+3).toString('hex')}`);
        console.log(`[NONCE]   counting nonce (bytes ${workXnonce2Size+3}-${workXnonce2Size+6}): ${nonceBuf.slice(workXnonce2Size+3, workXnonce2Size+7).toString('hex')}`);
        console.log(`[NONCE]   full nonceHex (${nonceLen} bytes): ${nonceHex}`);
        
        // Verus/Equihash mining.submit format: [worker, job_id, ntime, noncestr, solution]
        // Per equi-stratum.cpp: noncestr = full nonce minus xnonce1 prefix
        const params = [
            submitUser,
            work.job_id,
            ntimeHex,
            nonceHex,
            solutionHex
        ];
        
        if (config.debug) {
            console.log(`[DEBUG] Pool nonce field (15 bytes): ${poolNonceField.toString('hex')}`);
            console.log(`[DEBUG]   xnonce1 (bytes 0-3):   ${poolNonceField.slice(0, 4).toString('hex')}`);
            console.log(`[DEBUG]   xnonce2 (bytes 4-7):   ${poolNonceField.slice(4, 8).toString('hex')}`);
            console.log(`[DEBUG]   thrd+pad (bytes 8-10): ${poolNonceField.slice(8, 11).toString('hex')}`);
            console.log(`[DEBUG]   nonce (bytes 11-14):   ${poolNonceField.slice(11, 15).toString('hex')}`);
        }
        
        const doSubmit = () => {
            this.sendRequest('mining.submit', params, (error, result) => {
                let accepted = false;
                let reason = null;
                if (error) {
                    console.error(`[ERROR] Share submission error from pool:`, error.message);
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
                }
                console.log(`[STATS] Shares accepted: ${this.acceptedShares} / rejected: ${this.rejectedShares}`);
                try {
                    if (typeof resultCallback === 'function') {
                        resultCallback({ accepted, reason });
                    }
                } catch (cbErr) {
                    console.error('[ERROR] resultCallback threw:', cbErr);
                }
            });
        };
        
        if (submitUser && submitUser !== config.poolUser && !this.authorizedWorkers.has(submitUser)) {
            this.sendRequest('mining.authorize', [submitUser, config.poolPass], (err, res) => {
                if (err) {
                    console.error(`[WARN] Per-worker authorize failed for ${submitUser}:`, err.message || err);
                }
                if (res === true) {
                    this.authorizedWorkers.add(submitUser);
                }
                doSubmit();
            });
        } else {
            doSubmit();
        }
        
        return true;
    }

    log(message) {
        if (config.debug) {
            console.log(`[Stratum] ${new Date().toISOString()} ${message}`);
        }
    }
}

module.exports = StratumClient;
