// miner-worker.js - Web Worker for WASM mining
// This runs in a separate thread and communicates with main page via postMessage

let Module = null;
let workerId = -1;
let currentWork = null;
let mining = false;
let baseUrl = '';
let currentMiningPromise = null; // Track current mining operation

// Message handler
self.onmessage = async function(e) {
    const msg = e.data;
    
    switch (msg.type) {
        case 'init':
            try {
                workerId = msg.data.workerId;
                baseUrl = msg.data.baseUrl || '';
                await initWasm();
                self.postMessage({ type: 'initialized' });
            } catch (err) {
                self.postMessage({ 
                    type: 'error', 
                    error: `Failed to initialize WASM: ${err.message || err}`
                });
            }
            break;
            
        case 'mine':
            if (!Module) {
                self.postMessage({ type: 'error', error: 'WASM not initialized' });
                return;
            }
            try {
                // Stop any current mining operation
                if (currentMiningPromise) {
                    console.log(`[Worker ${workerId}] Stopping previous mining operation for new job`);
                    mining = false;
                    // Wait for previous operation to complete and cleanup
                    await currentMiningPromise;
                }
                
                currentWork = msg.data.work;
                mining = true;
                console.log(`[Worker ${workerId}] Starting mining for job ${currentWork.job_id}`);
                
                // Reset WASM miner state for clean job transition
                if (Module && Module._reset_miner) {
                    Module._reset_miner();
                    console.log(`[Worker ${workerId}] WASM miner state reset for new job`);
                }
                
                currentMiningPromise = mineWork(currentWork);
                await currentMiningPromise;
                currentMiningPromise = null;
            } catch (err) {
                currentMiningPromise = null;
                self.postMessage({ 
                    type: 'error', 
                    error: `Mining error: ${err.message || err}`
                });
            }
            break;
            
        case 'stop':
            mining = false;
            currentMiningPromise = null;
            if (Module && Module._request_restart) {
                Module._request_restart();
            }
            self.postMessage({ type: 'stopped' });
            break;
    }
};

async function initWasm() {
    // Import the WASM module factory
    // Use baseUrl if provided, otherwise try relative path
    const scriptUrl = baseUrl ? `${baseUrl}verus-miner.js` : './verus-miner.js';
    
    // Import the module factory
    importScripts(scriptUrl);
    
    if (typeof createVerusMinerModule === 'undefined') {
        throw new Error('createVerusMinerModule not found after importing verus-miner.js');
    }
    
    // Initialize the WASM module - it returns a Promise that resolves when ready
    Module = await createVerusMinerModule({
        locateFile: (path) => {
            // Help locate the .wasm file
            if (path.endsWith('.wasm')) {
                return baseUrl ? `${baseUrl}${path}` : `./${path}`;
            }
            return path;
        }
    });
    
    // The module should now be fully initialized
    // Verify we have the functions we need
    if (!Module._init_miner) {
        throw new Error('_init_miner function not found in WASM module');
    }
    
    if (!Module._malloc || !Module._free) {
        throw new Error('malloc/free functions not found in WASM module');
    }
    
    // Initialize miner
    const initResult = Module._init_miner();
    if (initResult !== 0) {
        throw new Error(`init_miner failed with code ${initResult}`);
    }
    
    console.log(`[Worker ${workerId}] WASM initialized successfully`);
    console.log(`[Worker ${workerId}] Module keys: ${Object.keys(Module).slice(0, 20).join(', ')}`);
}

async function mineWork(work) {
    if (!work || !Module) return;
    
    console.log(`[Worker ${workerId}] Starting mineWork for job ${work.job_id}`);
    
    // Check if mining was cancelled before we even start
    if (!mining) {
        console.log(`[Worker ${workerId}] Mining cancelled before start for job ${work.job_id}`);
        return;
    }
    
    // Get memory views from Module
    const HEAP8 = Module.HEAP8;
    const HEAPU8 = Module.HEAP8 ? new Uint8Array(Module.HEAP8.buffer) : null;
    const HEAP32 = Module.HEAP32;
    const HEAPU32 = Module.HEAP32 ? new Uint32Array(Module.HEAP32.buffer) : null;
    const HEAPF64 = Module.HEAPF64;
    
    if (!HEAPU32 || !HEAPU8 || !HEAPF64) {
        throw new Error('Cannot access WASM memory heaps');
    }
    
    // Allocate memory for input (wasm_work struct)
    const workSize = 4*48 + 4*8 + 1344 + 1388 + 4 + 4 + 128 + 8;
    const workPtr = Module._malloc(workSize);
    
    // Allocate memory for output (wasm_result struct)  
    const resultSize = 1 + 4 + 4*8 + 4 + 8 + 8 + 8;
    const resultPtr = Module._malloc(resultSize);
    
    try {
        // Fill work struct in WASM memory
        let offset = 0;
        
        // data[48] - uint32 array
        for (let i = 0; i < 48; i++) {
            const value = work.data[i] || 0;
            HEAPU32[(workPtr >> 2) + i] = value;
        }
        offset += 48 * 4;
        
        // target[8] - uint32 array (OPTIMIZED: use native set() instead of loop)
        if (work.target instanceof Uint32Array) {
            HEAPU32.set(work.target, (workPtr >> 2) + 48);
        } else {
            for (let i = 0; i < 8; i++) {
                HEAPU32[(workPtr >> 2) + 48 + i] = work.target[i] || 0;
            }
        }
        offset += 8 * 4;
        
        // solution[1344] - uint8 array (OPTIMIZED: use native set() instead of loop)
        if (work.solution instanceof Uint8Array) {
            HEAPU8.set(work.solution, workPtr + offset);
        } else {
            for (let i = 0; i < 1344; i++) {
                HEAPU8[workPtr + offset + i] = work.solution[i] || 0;
            }
        }
        offset += 1344;
        
        // extra[1388] - uint8 array (OPTIMIZED: use native set() instead of loop)
        if (work.extra instanceof Uint8Array) {
            HEAPU8.set(work.extra, workPtr + offset);
        } else {
            for (let i = 0; i < 1388; i++) {
                HEAPU8[workPtr + offset + i] = work.extra[i] || 0;
            }
        }
        offset += 1388;
        
        // start_nonce - uint32
        HEAPU32[(workPtr + offset) >> 2] = work.start_nonce || 0;
        offset += 4;
        
        // max_nonce - uint32
        HEAPU32[(workPtr + offset) >> 2] = work.max_nonce || 0xFFFFFFFF;
        offset += 4;
        
        // job_id[128] - char array
        const jobIdBytes = new TextEncoder().encode(work.job_id || '');
        for (let i = 0; i < Math.min(127, jobIdBytes.length); i++) {
            HEAPU8[workPtr + offset + i] = jobIdBytes[i];
        }
        HEAPU8[workPtr + offset + 127] = 0; // null terminator
        offset += 128;
        
        // targetdiff - double
        HEAPF64[(workPtr + offset) >> 3] = work.targetdiff || 1.0;
        
        // Mine in a loop with progress updates
        let currentNonce = work.start_nonce || 0;
        const chunkSize = 2000000; // 2M nonces per iteration (fast processing to avoid stale jobs)
        
        let sampleHashCount = 0;
        while (mining && currentNonce < work.max_nonce) {
            // Check if mining was cancelled (new job arrived)
            if (!mining) {
                console.log(`[Worker ${workerId}] Mining cancelled mid-operation for job ${work.job_id}`);
                break;
            }
            // Update start_nonce for this chunk
            const startNonceOffset = 4*48 + 4*8 + 1344 + 1388;
            HEAPU32[(workPtr + startNonceOffset) >> 2] = currentNonce;
            
            // Calculate chunk end
            const maxChunk = Math.min(currentNonce + chunkSize, work.max_nonce);
            const maxNonceOffset = startNonceOffset + 4;
            HEAPU32[(workPtr + maxNonceOffset) >> 2] = maxChunk;
            
            // Call WASM mining function
            const ret = Module._mine_work(workPtr, resultPtr);
            
            if (ret !== 0) {
                throw new Error(`mine_work returned error code ${ret}`);
            }
            
            // Read result struct
            let resultOffset = 0;
            const found = HEAPU8[resultPtr + resultOffset] !== 0;
            resultOffset += 4; // bool is padded to 4 bytes
            
            const nonce = HEAPU32[(resultPtr + resultOffset) >> 2];
            resultOffset += 4;
            
            // Skip hash[8] - it's not populated by mine_work() and we don't need individual hash values
            // scanhash_verus only returns hashes when a share is found (found=true)
            for (let i = 0; i < 8; i++) {
                resultOffset += 4;  // Just skip over the hash array
            }
            
            // Read result fields in order
            const nextNonce = HEAPU32[(resultPtr + resultOffset) >> 2];
            resultOffset += 4;
            
            const hashesDone = HEAPU32[(resultPtr + resultOffset) >> 2];
            resultOffset += 8; // unsigned long, skip high 32 bits
            
            const hashrate = HEAPF64[(resultPtr + resultOffset) >> 3];
            resultOffset += 8;
            
            const elapsedTime = HEAPF64[(resultPtr + resultOffset) >> 3];
            
            // Send progress update
            self.postMessage({
                type: 'progress',
                hashrate: hashrate,
                hashes: hashesDone
            });
            
            if (found) {
                console.log(`[Worker ${workerId}] SHARE FOUND!`);
                console.log(`[Worker ${workerId}] result.nonce = 0x${nonce.toString(16)}`);
                console.log(`[Worker ${workerId}] work.nonces[0] from WASM = 0x${nonce.toString(16)}`);
                
                // CRITICAL FIX: scanhash_verus returns the nonce in result.nonce
                // This is populated from work->nonces[0] which contains the actual winning nonce
                // Use this directly - it's more reliable than work.data[30]
                const actualNonce = nonce;
                console.log(`[Worker ${workerId}] Using nonce = 0x${actualNonce.toString(16)}`);
                
                // Read updated work data array (may have changed)
                const updatedData = [];
                for (let i = 0; i < 48; i++) {
                    updatedData[i] = HEAPU32[(workPtr >> 2) + i];
                }
                
                // Read updated extra array (contains the solution)
                const extraOffset = 4*48 + 4*8 + 1344;
                const updatedExtra = [];
                for (let i = 0; i < 1388; i++) {
                    updatedExtra[i] = HEAPU8[workPtr + extraOffset + i];
                }
                
                // Verify extra has the solution prefix (fd4005)
                console.log(`[Worker ${workerId}] Extra prefix: ${updatedExtra[0].toString(16).padStart(2,'0')}${updatedExtra[1].toString(16).padStart(2,'0')}${updatedExtra[2].toString(16).padStart(2,'0')}`);
                
                // Send share found message with the winning nonce
                self.postMessage({
                    type: 'found',
                    nonce: actualNonce,
                    extra: updatedExtra,
                    job_id: work.job_id,
                    hashes_done: hashesDone,
                    work: {
                        ...work,
                        data: updatedData,
                        extra: updatedExtra
                    }
                });
                
                // CRITICAL: Stop mining immediately after finding a share
                // Don't continue the loop - let the main thread handle the next job
                mining = false;
                break;
            }
            
            // Update current nonce for next iteration
            currentNonce = nextNonce;
            
            // Check if we've exhausted our range
            if (nextNonce >= work.max_nonce) {
                console.log(`[Worker ${workerId}] Reached max_nonce, stopping mining for this job`);
                break;
            }
        }
        
    } finally {
        // Free allocated memory
        Module._free(workPtr);
        Module._free(resultPtr);
        console.log(`[Worker ${workerId}] Completed mineWork for job ${work.job_id} - memory freed`);
    }
}

// Log function for debugging
function log(message) {
    self.postMessage({ 
        type: 'log', 
        message: `[Worker ${workerId}] ${message}` 
    });
}