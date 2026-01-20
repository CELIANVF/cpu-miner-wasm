// Web Worker for Verus mining
// This runs in a separate thread to keep the UI responsive

// Immediately try to log and send a message to verify the worker is executing
try {
    console.log('[Worker] Script file loaded and executing');
    
    // Send immediate message to parent to confirm worker is running
    self.postMessage({
        type: 'log',
        message: '[Worker] Worker script started successfully'
    });
} catch (e) {
    // If even this fails, try to send error message
    try {
        self.postMessage({
            type: 'error',
            error: `Worker initialization error: ${e.message || e}`
        });
    } catch (e2) {
        // Can't even send error message - worker is completely broken
        console.error('[Worker] Critical error during initialization:', e, e2);
    }
}

// Global error handler to catch any unhandled errors
try {
    self.onerror = function(message, source, lineno, colno, error) {
        const errorInfo = {
            message: message,
            source: source,
            lineno: lineno,
            colno: colno,
            error: error ? (error.message || error.toString()) : null
        };
        console.error('[Worker] Global error handler triggered:', errorInfo);
        try {
            self.postMessage({
                type: 'error',
                error: `Worker script error at ${source}:${lineno}:${colno} - ${message}`,
                details: errorInfo
            });
        } catch (postErr) {
            console.error('[Worker] Failed to send error message:', postErr);
        }
        return true; // Prevent default error handling
    };
    
    // Also add unhandled rejection handler
    self.addEventListener('unhandledrejection', function(event) {
        console.error('[Worker] Unhandled promise rejection:', event.reason);
        try {
            self.postMessage({
                type: 'error',
                error: `Unhandled promise rejection: ${event.reason}`
            });
        } catch (e) {}
    });
} catch (handlerErr) {
    console.error('[Worker] Failed to set up error handlers:', handlerErr);
}

let Module = null;
let mining = false;
let shouldStop = false;
let currentJobId = null;

console.log('[Worker] Variables initialized');

// Handle messages from main thread
self.onmessage = async function(e) {
    try {
        const msg = e.data;
        
        switch (msg.type) {
            case 'init':
                await initWasm(msg.data.workerId, msg.data.baseUrl);
                break;
            case 'mine':
            case 'work':
                // New work received - update work (stop old work if mining, start new work)
                // This is called when clean=false (normal update) or clean=true (after interrupt)
                const newWork = msg.data ? msg.data.work : msg.work;
                if (!newWork) {
                    self.postMessage({ 
                        type: 'error',
                        error: 'Mine message missing work data'
                    });
                    break;
                }
                
                // CRITICAL: Immediately update job ID so any shares found after this point
                // will be rejected if they use old work
                currentJobId = newWork.job_id;
                
                // If we're already mining, stop old work first
                if (mining) {
                    console.log(`[Worker] New work received while mining: job_id=${newWork.job_id}, stopping old work`);
                    shouldStop = true;
                    mining = false;
                    
                    // Request WASM to restart as well
                    if (Module && Module.ccall) {
                        try {
                            Module.ccall('request_restart', 'void', [], []);
                        } catch (e) {
                            // Ignore if function not available
                        }
                    }
                    
                    // Brief delay to let current chunk finish cleanly, then start new work
                    setTimeout(() => {
                        shouldStop = false;
                        runMiningLoop(newWork);
                    }, 50);
                } else {
                    // Not currently mining, start new work immediately
                    console.log(`[Worker] New work received (not mining): job_id=${newWork.job_id}, starting immediately`);
                    shouldStop = false; // CRITICAL: Reset stop flag before starting new work
                    runMiningLoop(newWork);
                }
                break;
            case 'stop':
                shouldStop = true;
                mining = false;
                currentJobId = null; // Clear job ID to prevent stale share submissions
                // Request WASM to restart as well
                if (Module && Module.ccall) {
                    try {
                        Module.ccall('request_restart', 'void', [], []);
                    } catch (e) {
                        // Ignore if function not available
                    }
                }
                break;
            case 'interrupt':
                // Immediate interruption - stop mining and clear job ID
                shouldStop = true;
                mining = false;
                currentJobId = null;
                // Request WASM to restart
                if (Module && Module.ccall) {
                    try {
                        Module.ccall('request_restart', 'void', [], []);
                    } catch (e) {
                        // Ignore if function not available
                    }
                }
                self.postMessage({ 
                    type: 'log', 
                    message: `Worker interrupted for new job: ${msg.newJobId || 'unknown'}` 
                });
                break;
            default:
                self.postMessage({ 
                    type: 'error',
                    error: `Unknown message type: ${msg.type}` 
                });
        }
    } catch (err) {
        const errorMsg = err ? (err.message || err.toString() || String(err)) : 'Unknown error';
        self.postMessage({ 
            type: 'error', 
            error: `Message handler error: ${errorMsg}` 
        });
    }
};

async function initWasm(workerId, baseUrl) {
    try {
        console.log(`[Worker ${workerId}] Initializing WASM...`);
        console.log(`[Worker ${workerId}] Worker location: ${self.location ? self.location.href : 'Blob URL'}`);
        console.log(`[Worker ${workerId}] Base URL: ${baseUrl || 'not provided'}`);
        
        // Load the Emscripten-generated module script
        try {
            console.log(`[Worker ${workerId}] Loading verus-miner.js...`);
            // Use absolute URL if baseUrl is provided (for Blob URL workers), otherwise use relative
            const verusMinerScript = baseUrl ? `${baseUrl}verus-miner.js` : './verus-miner.js';
            console.log(`[Worker ${workerId}] Loading from: ${verusMinerScript}`);
            importScripts(verusMinerScript);
            console.log(`[Worker ${workerId}] verus-miner.js loaded successfully`);
        } catch (scriptErr) {
            const scriptErrorMsg = scriptErr ? (scriptErr.message || scriptErr.toString() || String(scriptErr)) : 'Failed to load verus-miner.js';
            console.error(`[Worker ${workerId}] importScripts error:`, scriptErr);
            throw new Error(`Failed to load WASM script (verus-miner.js): ${scriptErrorMsg}`);
        }
        
        const createModule = self.createVerusMinerModule;
        if (!createModule) {
            throw new Error('createVerusMinerModule is not defined. verus-miner.js may not have loaded correctly, or the script is missing.');
        }
        if (typeof createModule !== 'function') {
            throw new Error(`createVerusMinerModule exists but is not a function (type: ${typeof createModule})`);
        }
        console.log(`[Worker ${workerId}] createVerusMinerModule found`);
        
        console.log(`[Worker ${workerId}] Creating WASM module...`);
        try {
            Module = await createModule({
                locateFile: (filePath) => {
                    if (filePath.endsWith('.wasm')) {
                        // Use absolute URL if baseUrl is provided (for Blob URL workers)
                        const wasmPath = baseUrl ? `${baseUrl}verus-miner.wasm` : './verus-miner.wasm';
                        console.log(`[Worker ${workerId}] locateFile requested: ${filePath} -> returning: ${wasmPath}`);
                        return wasmPath;
                    }
                    console.log(`[Worker ${workerId}] locateFile requested: ${filePath} -> returning as-is`);
                    return filePath;
                },
                print: (text) => console.log(`[WASM ${workerId}] ${text}`),
                printErr: (text) => console.error(`[WASM ${workerId}] ${text}`)
            });
        } catch (moduleErr) {
            const moduleErrorMsg = moduleErr ? (moduleErr.message || moduleErr.toString() || String(moduleErr)) : 'Failed to create module';
            console.error(`[Worker ${workerId}] createModule error:`, moduleErr);
            throw new Error(`Failed to create WASM module: ${moduleErrorMsg}`);
        }
        
        if (!Module) {
            throw new Error('WASM module creation returned null/undefined. The module may have failed to initialize.');
        }
        console.log(`[Worker ${workerId}] WASM module created, Module object:`, typeof Module);
        
        // Verify required functions exist
        if (!Module.ccall) {
            throw new Error('Module.ccall is not defined. The WASM module may not be properly initialized.');
        }
        if (!Module._malloc || !Module._free) {
            throw new Error('Module memory functions (_malloc/_free) are not defined.');
        }
        
        // Wait for module to be fully ready (memory views might not be available immediately)
        // Emscripten modules may need runtime initialization to complete
        if (Module.ready && typeof Module.ready === 'function') {
            console.log(`[Worker ${workerId}] Waiting for Module.ready()...`);
            await Module.ready;
        } else if (Module.onRuntimeInitialized) {
            // Module might use onRuntimeInitialized callback pattern
            console.log(`[Worker ${workerId}] Module uses onRuntimeInitialized callback`);
        }
        
        // Verify memory views are available (they should be set by updateMemoryViews after WASM init)
        // Try both HEAP32 and HEAPU32 (Emscripten provides both)
        const hasHeap32 = !!(Module.HEAP32 || Module.HEAPU32);
        const hasHeap8 = !!(Module.HEAP8 || Module.HEAPU8);
        const hasHeapF64 = !!Module.HEAPF64;
        
        if (!hasHeap32 || !hasHeap8 || !hasHeapF64) {
            console.error(`[Worker ${workerId}] Memory views status:`, {
                HEAP32: !!Module.HEAP32,
                HEAPU32: !!Module.HEAPU32,
                HEAP8: !!Module.HEAP8,
                HEAPU8: !!Module.HEAPU8,
                HEAPF64: !!Module.HEAPF64,
                ModuleKeys: Object.keys(Module).filter(k => k.includes('HEAP'))
            });
            throw new Error(`Module memory views not fully initialized. HEAP32/U32: ${hasHeap32}, HEAP8/U8: ${hasHeap8}, HEAPF64: ${hasHeapF64}`);
        }
        
        // Initialize the miner (this may be required before using it)
        if (Module.ccall && typeof Module.ccall === 'function') {
            try {
                const initResult = Module.ccall('init_miner', 'number', [], []);
                console.log(`[Worker ${workerId}] init_miner called, returned: ${initResult}`);
            } catch (initErr) {
                console.warn(`[Worker ${workerId}] init_miner call failed (may not be required): ${initErr.message}`);
            }
        }
        
        console.log(`[Worker ${workerId}] WASM initialized successfully`);
        console.log(`[Worker ${workerId}] Memory views: HEAP32=${!!Module.HEAP32}, HEAPU32=${!!Module.HEAPU32}, HEAP8=${!!Module.HEAP8}, HEAPU8=${!!Module.HEAPU8}, HEAPF64=${!!Module.HEAPF64}`);
        
        self.postMessage({ 
            type: 'initialized',
            workerId: workerId
        });
    } catch (err) {
        const errorMsg = err ? (err.message || err.toString() || String(err)) : 'Unknown error';
        const errorStack = err && err.stack ? `\nStack: ${err.stack}` : '';
        console.error(`[Worker ${workerId}] initWasm error:`, err);
        console.error(`[Worker ${workerId}] Error details: message=${errorMsg}, stack=${errorStack}`);
        self.postMessage({ 
            type: 'error',
            error: `Worker ${workerId} init failed: ${errorMsg}${errorStack}`
        });
        // Re-throw to trigger the outer catch handler
        throw err;
    }
}

let globalMaxNonce = 0xFFFFFFFF;
// currentJobId is already declared above at the top level

function runMiningLoop(work) {
    if (!Module) {
        self.postMessage({ type: 'error', error: 'WASM not initialized' });
        return;
    }
    
    // CRITICAL: Reset stop flag at the start of each new mining loop
    // This ensures we don't inherit a stale shouldStop=true from previous operations
    shouldStop = false;
    
    // CRITICAL: Store the work object in a way that can be checked for staleness
    // When new work arrives, shouldStop will be set, and any shares found will be skipped
    mining = true;
    currentJobId = work.job_id;
    const workJobId = work.job_id; // Capture job_id to verify later
    let nonce = work.start_nonce || 0;
    const maxNonce = work.max_nonce || 0xFFFFFFFF;
    const chunkSize = 100000; // Smaller chunks for faster interrupt response (was 500000)
    
    function doChunk() {
        // CRITICAL: Check stop flag FIRST before doing anything
        if (shouldStop) {
            mining = false;
            console.log(`[Worker] Stopped - shouldStop flag is true, abandoning work for job ${workJobId}`);
            return; // Stop silently if requested
        }
        
        // CRITICAL: Verify this work's job_id still matches currentJobId
        // If new work arrived, currentJobId will have been updated, and we should stop
        if (currentJobId !== workJobId) {
            console.log(`[Worker] Job ID mismatch: work.job_id=${workJobId}, currentJobId=${currentJobId}, stopping old work`);
            mining = false;
            return; // Stop if job ID changed (new work arrived)
        }
        
        if (nonce >= maxNonce) {
            self.postMessage({ type: 'log', message: 'Worker reached max nonce range' });
            mining = false;
            return; // Stop and wait for main thread to give new work/nonce range
        }
        
        // Save the starting nonce for this chunk (for logging/comparison)
        const chunkStartNonce = nonce;
        const endNonce = Math.min(nonce + chunkSize, maxNonce);
        const chunkStartTime = Date.now();
        
        // Mine this chunk
        const result = mineChunk(work, nonce, endNonce);
        
        if (result.found) {
            // CRITICAL: Check if worker was stopped or job changed BEFORE submitting share
            if (shouldStop) {
                console.log(`[Worker] Skipping share for job ${workJobId} (worker stopped)`);
                self.postMessage({ 
                    type: 'log', 
                    message: `Skipping share for job ${workJobId} (worker stopped)` 
                });
                mining = false;
                return;
            }
            
            // CRITICAL: Double-check job ID hasn't changed during mining
            if (currentJobId !== workJobId) {
                console.log(`[Worker] Skipping share for job ${workJobId} (job changed to ${currentJobId})`);
                self.postMessage({ 
                    type: 'log', 
                    message: `Skipping share for job ${workJobId} (job changed to ${currentJobId})` 
                });
                mining = false;
                return;
            }
            
            // Always submit found shares - use work.job_id (the job this share was found for)
            // The server will validate if the job is stale or still valid
            // Determine a reliable nonce to send: prefer result.nonce, otherwise use work.data[30]
            let sentNonce = (typeof result.nonce === 'number' && (result.nonce >>> 0) !== 0) ? (result.nonce >>> 0) : null;
            try {
                const workData30 = result.work && Array.isArray(result.work.data) ? (result.work.data[30] >>> 0) : null;
                if (!sentNonce && workData30) sentNonce = workData30;
            } catch (e) {
                // ignore
            }

            // Debug: print both result.nonce and work.data[30] (scanhash may write nonce there)
            try {
                const resNonce = (typeof result.nonce === 'number') ? (result.nonce >>> 0) : result.nonce;
                const workData30 = (result.work && Array.isArray(result.work.data)) ? (result.work.data[30] >>> 0) : null;
                console.log(`[Worker] Debug found nonce values: result.nonce=${resNonce}, work.data[30]=${workData30}`);
            } catch (e) {
                console.warn('[Worker] Failed to log debug nonce values', e);
            }
            console.log(`[Worker] Share found for job ${workJobId}, submitting...`);
            self.postMessage({ 
                type: 'found', 
                // result.nonce may be 0 in some builds; send a best-effort nonce and include work_nonce for diagnostics
                nonce: sentNonce !== null ? sentNonce : (result.nonce >>> 0),
                work_nonce: (result.work && Array.isArray(result.work.data)) ? (result.work.data[30] >>> 0) : null,
                extra: result.extra,
                job_id: workJobId,  // Use captured workJobId, not currentJobId
                hashes_done: result.hashes_done,
                hashrate: result.hashrate,
                work: result.work  // Include the full work object for validation
            });
            mining = false;
            return;
        }
        
        // Send progress update with hashrate
        // Use hashes_done from result - it should contain the actual number of hashes processed
        const hashesDone = result.hashes_done || 0;
        const elapsedSeconds = result.elapsed_time || ((Date.now() - chunkStartTime) / 1000);
        
        // Calculate hashrate - prefer result.hashrate, otherwise calculate from hashes/time
        let currentHashrate = result.hashrate || 0;
        if (currentHashrate === 0 && elapsedSeconds > 0 && hashesDone > 0) {
            currentHashrate = hashesDone / elapsedSeconds;
        }
        
        // Always send progress updates (even if 0, to keep UI updated)
        self.postMessage({
            type: 'progress',
            hashrate: currentHashrate,
            hashes_done: hashesDone,
            nonce: result.next_nonce !== undefined ? result.next_nonce : endNonce
        });
        
        // Update nonce - use next_nonce from result
        // The result.next_nonce should be work.data[30] which scanhash_verus updated
        if (result.next_nonce !== undefined && result.next_nonce !== null) {
            // Convert to unsigned 32-bit (in case it was read as signed)
            const nextNonce = result.next_nonce >>> 0;
            if (nextNonce > nonce && nextNonce <= maxNonce) {
                nonce = nextNonce;
            } else if (nextNonce > 0x7FFFFFFF) {
                // If it's a large value that looks like it might be a sign extension issue, try using work.data[30]
                const workData30 = result.work && result.work.data ? result.work.data[30] : null;
                if (workData30 !== null && workData30 > nonce && workData30 <= maxNonce) {
                    nonce = workData30;
                } else {
                    nonce = endNonce;
                }
            } else {
                // If next_nonce is not valid, use endNonce
                nonce = endNonce;
            }
        } else {
            // Fallback: use work.data[30] if available in result.work
            const workData30 = result.work && result.work.data ? result.work.data[30] : null;
            if (workData30 !== null && workData30 > nonce && workData30 <= maxNonce) {
                nonce = workData30;
            } else {
                // Last resort: advance by the chunk size
                nonce = endNonce;
            }
        }
        
        // Log the advancement (only if significant change to avoid spam)
        if (nonce !== chunkStartNonce && (nonce - chunkStartNonce) > 100) {
            console.log(`[Worker] Nonce advanced from 0x${chunkStartNonce.toString(16)} to 0x${nonce.toString(16)}`);
        }
        
        // Continue to next chunk (use requestIdleCallback if available, otherwise setTimeout)
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(doChunk, { timeout: 10 });
        } else {
            setTimeout(doChunk, 0);
        }
    }
    
    doChunk();
}

function mineChunk(work, startNonce, endNonce) {
    try {
        // Validate Module is ready
        if (!Module) {
            throw new Error('Module is not initialized');
        }
        
        // Use HEAP32 and convert to unsigned where needed (HEAPU32 may not be available)
        // When reading unsigned values, use >>> 0 to convert signed int32 to unsigned uint32
        const HEAP32 = Module.HEAP32;
        const HEAP8 = Module.HEAP8 || Module.HEAPU8;
        const HEAPU8 = Module.HEAPU8 || Module.HEAP8;
        const HEAPF64 = Module.HEAPF64;
        
        if (!HEAP32 || !HEAP8 || !HEAPF64) {
            const status = {
                HEAP32: !!Module.HEAP32,
                HEAPU32: !!Module.HEAPU32,
                HEAP8: !!Module.HEAP8,
                HEAPU8: !!Module.HEAPU8,
                HEAPF64: !!Module.HEAPF64
            };
            throw new Error('Module memory views not available: ' + JSON.stringify(status));
        }
        
        if (!Module._malloc || !Module._free) {
            throw new Error('Module memory allocation functions not available');
        }
        
        // Allocate memory for work structure
        const wasmWorkSize = 48*4 + 8*4 + 1344 + 1388 + 4 + 4 + 128 + 8;
        const wasmWorkPtr = Module._malloc(wasmWorkSize);
        if (!wasmWorkPtr || wasmWorkPtr === 0) {
            throw new Error('Failed to allocate memory for work structure');
        }
        
        // Allocate memory for result structure
        const wasmResultSize = 4 + 4 + 8*4 + 4 + 8 + 8 + 8;
        const wasmResultPtr = Module._malloc(wasmResultSize);
        if (!wasmResultPtr || wasmResultPtr === 0) {
            Module._free(wasmWorkPtr);
            throw new Error('Failed to allocate memory for result structure');
        }
        
        try {
            let offset = 0;
            
            // Write work structure to WASM memory (HEAP32 for uint32_t, HEAPU8 for uint8_t)
            // data[48] - uint32_t
            for (let i = 0; i < 48; i++) {
                HEAP32[(wasmWorkPtr >> 2) + i] = (work.data[i] || 0) >>> 0; // Convert to unsigned
            }
            offset += 48 * 4;
            
            // target[8] - uint32_t
            for (let i = 0; i < 8; i++) {
                const targetVal = (work.target[i] !== undefined && work.target[i] !== null) ? work.target[i] : 0xFFFFFFFF;
                HEAP32[(wasmWorkPtr >> 2) + 48 + i] = targetVal >>> 0; // Convert to unsigned
            }
            offset += 8 * 4;
            
            // solution[1344] - uint8_t
            for (let i = 0; i < 1344; i++) {
                HEAPU8[wasmWorkPtr + offset + i] = work.solution[i] || 0;
            }
            offset += 1344;
            
            // extra[1388] - uint8_t
            for (let i = 0; i < 1388; i++) {
                HEAPU8[wasmWorkPtr + offset + i] = work.extra[i] || 0;
            }
            offset += 1388;
            
            // start_nonce - uint32_t
            HEAP32[(wasmWorkPtr + offset) >> 2] = startNonce >>> 0; // Convert to unsigned
            offset += 4;
            
            // max_nonce - uint32_t
            HEAP32[(wasmWorkPtr + offset) >> 2] = endNonce >>> 0; // Convert to unsigned
            offset += 4;
            
            // job_id[128] - char
            const jobIdBytes = new TextEncoder().encode(work.job_id || '');
            for (let i = 0; i < Math.min(127, jobIdBytes.length); i++) {
                HEAPU8[wasmWorkPtr + offset + i] = jobIdBytes[i];
            }
            HEAPU8[wasmWorkPtr + offset + Math.min(127, jobIdBytes.length)] = 0;
            offset += 128;
            
            // targetdiff - double
            HEAPF64[(wasmWorkPtr + offset) >> 3] = work.targetdiff || 1.0;
            
            // Call mine_work
            const ret = Module.ccall(
                'mine_work',
                'number',
                ['number', 'number'],
                [wasmWorkPtr, wasmResultPtr]
            );
            
            if (ret !== 0) {
                self.postMessage({ 
                    type: 'error',
                    error: `mine_work returned ${ret}`
                });
                return { found: false };
            }
            
            // Read result structure from WASM memory (convert to unsigned where needed)
            // Structure layout: bool found (offset 0), uint32 nonce (offset 4), 
            // uint32 hash[8] (offset 8-40), uint32 next_nonce (offset 40),
            // unsigned long hashes_done (offset 44), double hashrate (offset 48),
            // double elapsed_time (offset 56)
            const found = HEAP32[wasmResultPtr >> 2] !== 0;
            const resultNonce = (HEAP32[(wasmResultPtr + 4) >> 2] >>> 0); // Convert to unsigned
            
            // Read hashes_done from result structure (standard layout: offset 44)
            let resultHashesDone = (HEAP32[(wasmResultPtr + 44) >> 2] >>> 0); // Convert to unsigned
            // If that's 0, try offset 40 (alternative layout)
            if (resultHashesDone === 0) {
                resultHashesDone = (HEAP32[(wasmResultPtr + 40) >> 2] >>> 0); // Convert to unsigned
            }
            
            const resultHashrate = HEAPF64[(wasmResultPtr + 48) >> 3];
            const resultElapsedTime = HEAPF64[(wasmResultPtr + 56) >> 3];
            
            // Read the updated nonce from work.data[30] - this is the most reliable source
            // scanhash_verus updates this directly, so it's always correct
            // Convert to unsigned to avoid sign extension issues
            const workData30 = (HEAP32[(wasmWorkPtr >> 2) + 30] >>> 0);
            
            // Use work.data[30] as next_nonce (it's the actual position scanhash_verus left off at)
            const actualNextNonce = workData30;
            
            // If hashes_done is still 0, calculate from nonce difference
            if (resultHashesDone === 0 && actualNextNonce > startNonce) {
                resultHashesDone = actualNextNonce - startNonce;
            }
            
            if (found) {
                // Read back the updated extra data
                const extraOffset = 48*4 + 8*4 + 1344;
                const updatedExtra = [];
                for (let i = 0; i < 1388; i++) {
                    updatedExtra.push(HEAP8[wasmWorkPtr + extraOffset + i]);
                }
                
                // Read back the updated data array (convert to unsigned to avoid sign extension)
                const updatedData = [];
                for (let i = 0; i < 48; i++) {
                    updatedData.push(HEAP32[(wasmWorkPtr >> 2) + i] >>> 0); // Convert to unsigned
                }
                
                // work.data[30] should already have the correct nonce from scanhash_verus
                // Don't overwrite it - it's already correct (either the found nonce or the next position)
                
                return {
                    found: true,
                    nonce: resultNonce,
                    extra: updatedExtra,
                    hashes_done: resultHashesDone,
                    hashrate: resultHashrate,
                    next_nonce: actualNextNonce,
                    elapsed_time: resultElapsedTime,
                    work: {
                        ...work,
                        data: updatedData,
                        extra: updatedExtra
                    }
                };
            } else {
                // For non-found case, we still need to read the updated work.data[30] to get next_nonce
                // Read back the updated data array to get work.data[30] (convert to unsigned)
                const updatedData = [];
                for (let i = 0; i < 48; i++) {
                    updatedData.push(HEAP32[(wasmWorkPtr >> 2) + i] >>> 0); // Convert to unsigned
                }
                
                return { 
                    found: false, 
                    hashes_done: resultHashesDone, 
                    hashrate: resultHashrate,
                    next_nonce: actualNextNonce,
                    elapsed_time: resultElapsedTime,
                    work: {
                        ...work,
                        data: updatedData // Include updated data so data[30] is available
                    }
                };
            }
            
        } finally {
            Module._free(wasmWorkPtr);
            Module._free(wasmResultPtr);
        }
    } catch (err) {
        self.postMessage({ 
            type: 'error',
            error: err.message
        });
        return { found: false };
    }
}

function mine(work) {
    // Legacy function - replaced by runMiningLoop
    runMiningLoop(work);
}
