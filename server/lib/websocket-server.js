/**
 * WebSocket Server for Web Miners
 * Handles mining work distribution and share collection
 */

const WebSocket = require('ws');
const { config } = require('./config');

class WebSocketServer {
    constructor(server) {
        this.wss = new WebSocket.Server({ server });
        this.clients = new Map();
        this.nextClientId = 0;
        this.currentWork = null;
        this.previousJobId = null;
        this.lastCleanJobId = null;
        this.submittedShares = new Set();
        this.shareCallback = null;
        
        // Sliding window of recent valid jobs (jobId -> timestamp)
        // Keeps jobs for 30 seconds to handle WASM latency + GC + tab throttling
        this.recentJobs = new Map();
        this.jobValidityWindow = 30000; // 30 seconds in milliseconds
        
        // Cleanup old jobs every 5 seconds
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldJobs();
        }, 5000);
        
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
    }

    setShareCallback(callback) {
        this.shareCallback = callback;
    }

    handleConnection(ws, req) {
        const clientAddr = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        const clientId = this.nextClientId++;
        
        this.clients.set(ws, { id: clientId, addr: clientAddr, clientId: `c${clientId}` });
        console.log(`Web miner connected: ${clientAddr} (client ${`c${clientId}`}, total: ${this.clients.size})`);

        if (this.currentWork) {
            this.sendWorkToClient(ws, clientId);
        }
        
        this.redistributeWork();

        ws.on('message', (message) => {
            this.handleMessage(ws, message);
        });

        ws.on('close', () => {
            const clientInfo = this.clients.get(ws);
            console.log(`Web miner disconnected: ${clientAddr} (client ${clientInfo?.clientId || clientInfo?.id}, remaining: ${this.clients.size - 1})`);
            this.clients.delete(ws);
            this.redistributeWork();
        });

        ws.on('error', (error) => {
            console.log(`WebSocket error: ${error.message}`);
        });
    }
    
    sendWorkToClient(ws, clientId) {
        if (!this.currentWork) return;
        
        const clientCount = this.clients.size || 1;
        const totalNonceSpace = 0xFFFFFFFF;
        const rangeSize = Math.floor(totalNonceSpace / clientCount);
        
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
                    if (data.clientId && typeof data.clientId === 'string') {
                        const info = this.clients.get(ws) || {};
                        info.clientId = data.clientId.replace(/\s+/g, '_');
                        this.clients.set(ws, info);
                        console.log(`[INFO] Client identified as ${info.clientId}`);
                        this.sendWorkToClient(ws, info.id);
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

        if (data.work && data.work.target) {
            console.log(`[SHARE DEBUG] Target array from worker: [${data.work.target.map((x, i) => `[${i}]=0x${x.toString(16).padStart(8,'0')}`).join(', ')}]`);
        }
        
        if (!data.work || data.nonce === undefined || data.nonce === null) {
            console.error(`[REJECTED] Share rejected: missing work or nonce data`);
            console.error(`[REJECTED]   hasWork: ${!!data.work}, hasNonce: ${data.nonce !== undefined && data.nonce !== null}`);
            return;
        }

        const shareJobId = data.work.job_id;

        if (!this.currentWork) {
            console.error(`[REJECTED] Share rejected: No current work set on server`);
            return;
        }
        
        const isCurrentJob = shareJobId === this.currentWork.job_id;
        const isRecentJob = this.recentJobs.has(shareJobId);
        const jobAge = isRecentJob ? (Date.now() - this.recentJobs.get(shareJobId)) : null;
        
        console.log(`[DEBUG] Share validation: shareJobId=${shareJobId}, currentJob=${this.currentWork.job_id}`);
        console.log(`[DEBUG]   isCurrentJob=${isCurrentJob}, isRecentJob=${isRecentJob}` + (jobAge !== null ? `, age=${jobAge}ms` : ''));
        console.log(`[DEBUG]   Recent jobs window: [${Array.from(this.recentJobs.keys()).join(', ')}]`);
        
        if (!isCurrentJob && !isRecentJob) {
            console.warn(`[REJECTED-STALE] Share for old job ${shareJobId} ignored (current: ${this.currentWork.job_id}, recent: ${Array.from(this.recentJobs.keys()).join(', ')})`);
            return;
        }
        
        if (isCurrentJob) {
            console.log(`[DEBUG] Share validation PASSED - current job share, will submit to pool`);
        } else if (isRecentJob) {
            console.log(`[DEBUG] Share validation PASSED - recent job share (age: ${jobAge}ms, acceptable within window), will submit to pool`);
        }
        
        if (config.debug && data.work && data.work.target) {
            console.log(`[SHARE DEBUG] Target validation:`);
            console.log(`  Target array: [${data.work.target.map(x => '0x' + x.toString(16).padStart(8, '0')).join(', ')}]`);
            console.log(`  Target MSB (index 7): 0x${data.work.target[7].toString(16)}`);
            console.log(`  Expected target MSB for diff=1: 0x00000020`);
            
            const targetMsb = data.work.target[7];
            const shareDifficulty = targetMsb > 0 ? (0x00000020 / targetMsb) : 0;
            console.log(`  Share difficulty required: ${shareDifficulty.toFixed(6)}`);
            
            if (targetMsb === 0) {
                console.error(`[ERROR] Target MSB is 0 - impossible to find share!`);
            } else if (targetMsb > 0x00000020) {
                console.error(`[ERROR] Target MSB (0x${targetMsb.toString(16)}) > 0x00000020 - share would be INVALID even if perfect!`);
            } else if (targetMsb === 0x00000020) {
                console.log(`  Target is base difficulty (diff=1)`);
            } else {
                console.log(`  Target is easier than base (diff>1)`);
            }
        }

        console.log(`[DEBUG] Share passed job_id validation (job: ${shareJobId}, current: ${this.currentWork.job_id}). Proceeding with submission...`);

        const shareKey = `${data.work.job_id}:${data.nonce}`;
        
        if (this.submittedShares.has(shareKey)) {
            console.log(`Duplicate share ignored: nonce=0x${data.nonce.toString(16)}, job_id=${data.work.job_id}`);
            return;
        }
        
        this.submittedShares.add(shareKey);
        
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
        
        let extra = data.work.extra || data.extra;
        if (!extra) {
            console.error(`[REJECTED] Share rejected: no extra data provided`);
            console.error(`[REJECTED]   data.work.extra: ${!!data.work.extra}, data.extra: ${!!data.extra}`);
            return;
        }
        
        if (Array.isArray(extra)) {
            extra = Buffer.from(extra);
            console.log(`[DEBUG] Converted extra array to Buffer: ${extra.length} bytes`);
        } else if (Buffer.isBuffer(extra)) {
            console.log(`[DEBUG] Extra is already a Buffer: ${extra.length} bytes`);
        } else {
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
        
        const clientInfo = this.clients.get(ws) || {};
        let deviceSuffix = null;
        if (data.worker && typeof data.worker === 'string') deviceSuffix = data.worker;
        else if (data.workerId) deviceSuffix = data.workerId;
        else if (data.deviceId) deviceSuffix = data.deviceId;
        else if (clientInfo.clientId) deviceSuffix = clientInfo.clientId;
        else if (clientInfo.id !== undefined) deviceSuffix = `c${clientInfo.id}`;
        if (typeof deviceSuffix === 'string') deviceSuffix = deviceSuffix.replace(/\s+/g, '_');

        console.log(`[DEBUG] Submitting share on behalf of worker suffix: ${deviceSuffix || '(none)'} (pool user base: ${config.poolUser})`);

        if (this.shareCallback) {
            const submitResult = this.shareCallback(data.work, data.nonce, extra, deviceSuffix, (res) => {
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
    }

    broadcastWork(work) {
        if (this.currentWork && this.currentWork.job_id !== work.job_id) {
            this.previousJobId = this.currentWork.job_id;
            // Add previous job to sliding window
            this.recentJobs.set(this.previousJobId, Date.now());
            console.log(`[DEBUG] Previous job tracked: ${this.previousJobId} -> Current: ${work.job_id}`);
        }
        
        this.currentWork = work;
        // Add current job to sliding window
        this.recentJobs.set(work.job_id, Date.now());
        
        console.log(`[NONCE] Broadcasting new job ${work.job_id} to ${this.clients.size} clients with unique ranges`);
        this.clients.forEach((clientInfo, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                this.sendWorkToClient(ws, clientInfo.id);
            }
        });
    }

    broadcastInterrupt(newJobId) {
        this.lastCleanJobId = newJobId;
        const now = Date.now();
        
        console.log(`[DEBUG] Clean job received: ${newJobId} (soft clean for web miners)`);
        
        // For web miners: keep a soft window instead of hard-invalidating
        // Remove jobs that are older than the clean job, but preserve a sliding window
        for (const [jobId, ts] of this.recentJobs.entries()) {
            if (!this.isJobIdAfter(jobId, newJobId)) {
                this.recentJobs.delete(jobId);
            }
        }
        
        // Ensure the new clean job is in the window
        this.recentJobs.set(newJobId, now);
        
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
    
    cleanupOldJobs() {
        const now = Date.now();
        let removed = 0;
        
        for (const [jobId, timestamp] of this.recentJobs.entries()) {
            if (now - timestamp > this.jobValidityWindow) {
                this.recentJobs.delete(jobId);
                removed++;
            }
        }
        
        if (removed > 0 && config.debug) {
            console.log(`[DEBUG] Cleaned up ${removed} old jobs from validity window`);
        }
    }

    isJobIdAfter(jobId1, jobId2) {
        try {
            const id1 = parseInt(jobId1, 16);
            const id2 = parseInt(jobId2, 16);
            return !isNaN(id1) && !isNaN(id2) && id1 >= id2;
        } catch (e) {
            return jobId1 >= jobId2;
        }
    }
}

module.exports = WebSocketServer;
