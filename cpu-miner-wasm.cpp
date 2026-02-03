// WebAssembly-Compatible CPU Verus Miner
// This version removes all networking/stratum code (handled by web server)
// and all pthread dependencies (parallelization handled by Web Workers in JS)

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include "../cpu-miner-verus/miner_simple.h"
#include "../cpu-miner-verus/verus/verusscan_simple.h"
#include "miner_wasm.h"

// Global variables required by verusscan_simple.cpp and other Verus sources
int opt_debug = 0;  // Disable debug logging in production
int opt_quiet = 0;
int verbose = 0;

struct work_restart *work_restart = NULL;

extern "C" EMSCRIPTEN_KEEPALIVE
void request_restart() {
    if (work_restart) work_restart->restart = 1;
}

#ifdef __EMSCRIPTEN__
static double emscripten_get_time() {
    return emscripten_get_now() / 1000.0;
}
#else
#include <sys/time.h>
static double emscripten_get_time() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1000000.0;
}
#endif

static struct work g_work;
static struct work_restart g_work_restart_single;
static bool g_initialized = false;
static double g_last_hashrate = 0.0;

extern "C" EMSCRIPTEN_KEEPALIVE
int init_miner() {
    if (g_initialized) return 0;
    memset(&g_work_restart_single, 0, sizeof(g_work_restart_single));
    work_restart = &g_work_restart_single;
    memset(&g_work, 0, sizeof(g_work));
    g_initialized = true;
    return 0;
}

static void wasm_to_work(const struct wasm_work *wasm_work, struct work *work) {
    memset(work, 0, sizeof(struct work));
    memcpy(work->data, wasm_work->data, sizeof(wasm_work->data));
    memcpy(work->target, wasm_work->target, sizeof(wasm_work->target));
    memcpy(work->solution, wasm_work->solution, sizeof(wasm_work->solution));
    memcpy(work->extra, wasm_work->extra, sizeof(wasm_work->extra));
    // Ensure the start_nonce is correctly placed in the data array
    // In Verus/Equihash, the nonce is typically at index 30 of the uint32 array
    work->data[30] = wasm_work->start_nonce; 
    work->targetdiff = wasm_work->targetdiff;
    strncpy(work->job_id, wasm_work->job_id, sizeof(work->job_id) - 1);
    work->job_id[sizeof(work->job_id) - 1] = '\0';
}

extern "C" EMSCRIPTEN_KEEPALIVE
int mine_work(struct wasm_work *input, struct wasm_result *output) {
    if (!g_initialized && init_miner() != 0) return -1;
    if (!input || !output) return -2;

    wasm_to_work(input, &g_work);
    g_work_restart_single.restart = 0;

    // Debug: Log work data to understand what we're hashing
    if (opt_debug) {
        printf("[DEBUG] Job: %s, Nonce: 0x%08x - 0x%08x\n", 
            input->job_id, input->start_nonce, input->max_nonce);
    }

    uint32_t current_nonce = input->start_nonce;
    uint32_t max_nonce = input->max_nonce;
    unsigned long total_hashes = 0;
    double start_time = emscripten_get_time();
    int found = 0;

    // We mine in chunks to keep the browser UI responsive
    // OPTIMIZED FOR SPEED: Increased to 500000 to find shares faster
    // and avoid stale job rejections (pool timeout ~20s)
    const uint32_t chunk_size = 100000; 
    
    while (current_nonce < max_nonce && !g_work_restart_single.restart) {
        // Calculate chunk end, ensuring we don't exceed max_nonce
        uint32_t chunk_end = (current_nonce + chunk_size > max_nonce) ? max_nonce : current_nonce + chunk_size;
        
        // scanhash_verus will update g_work.data[30] with the final nonce it checked
        g_work.data[30] = current_nonce;
        unsigned long chunk_hashes = 0;
        
        // scanhash_verus performs the actual VerusHash 2.2.1 calculation
        // Returns number of valid shares found (0 or 1+ for Verus)
        found = scanhash_verus(0, &g_work, chunk_end, &chunk_hashes);
        total_hashes += chunk_hashes;
        
        // Update current nonce for next iteration
        // scanhash_verus updates g_work.data[30] to the final nonce checked
        current_nonce = g_work.data[30];
        
        // If found, scanhash_verus will have:
        // - Set g_work.valid_nonces > 0
        // - Populated g_work.nonces[0] with the winning nonce
        // - Populated g_work.extra with the solution data
        // - Advanced current_nonce by 100000 (to prevent re-finding same share)
        if (found > 0) break;
    }

    double elapsed = emscripten_get_time() - start_time;
    
    // Fill output
    output->found = (found > 0);
    output->next_nonce = current_nonce;
    output->hashes_done = total_hashes;
    output->elapsed_time = elapsed;
    output->hashrate = (elapsed > 0) ? (total_hashes / elapsed) : 0;
    g_last_hashrate = output->hashrate;

    if (found > 0) {
        // CRITICAL: scanhash_verus stores the actual winning nonce in g_work.nonces[0]
        // NOT in g_work.data[30] (which just tracks iteration progress)
        output->nonce = g_work.nonces[0];
        
        // Debug output to verify nonce handling
        if (opt_debug) {
            printf("[WASM] Share found!\n");
            printf("[WASM]   nonce from work.nonces[0] = 0x%08x\n", g_work.nonces[0]);
            printf("[WASM]   nonce from work.data[30] = 0x%08x\n", g_work.data[30]);
            printf("[WASM]   valid_nonces = %d\n", g_work.valid_nonces);
            printf("[WASM]   Output->nonce = 0x%08x\n", output->nonce);
        }
        
        // Copy the nonce back to input->data[30] and input->nonces[0] so JS can access it
        input->data[30] = output->nonce;
        
        // Copy the solution (extra) that was built by scanhash_verus (1347 bytes)
        memcpy(input->extra, g_work.extra, 1347);
    } else {
        output->nonce = 0;
    }

    return 0;
}

// Get last computed hashrate
extern "C" EMSCRIPTEN_KEEPALIVE
double get_hashrate() {
    return g_last_hashrate;
}

// Reset miner state (useful for new jobs)
extern "C" EMSCRIPTEN_KEEPALIVE
void reset_miner() {
    memset(&g_work, 0, sizeof(g_work));
    g_work_restart_single.restart = 0;
}

// Cleanup (call when done)
extern "C" EMSCRIPTEN_KEEPALIVE
void cleanup_miner() {
    if (g_initialized) {
        free_verushash(0);
        work_restart = NULL;
        g_initialized = false;
    }
}

// Helper function to format hashrate (for debugging/logging)
extern "C" EMSCRIPTEN_KEEPALIVE
void format_hashrate_string(double hashrate, char *output, size_t output_size) {
    if (hashrate < 1000) {
        snprintf(output, output_size, "%.2f H/s", hashrate);
    } else if (hashrate < 1000000) {
        snprintf(output, output_size, "%.2f KH/s", hashrate / 1000);
    } else if (hashrate < 1000000000) {
        snprintf(output, output_size, "%.2f MH/s", hashrate / 1000000);
    } else {
        snprintf(output, output_size, "%.2f GH/s", hashrate / 1000000000);
    }
}

// Test function to verify WASM module is working
extern "C" EMSCRIPTEN_KEEPALIVE
int test_miner() {
    if (init_miner() != 0) {
        return -1;
    }
    
    // Create a simple test work
    struct wasm_work test_work;
    memset(&test_work, 0, sizeof(test_work));
    
    // Set easy target for testing
    memset(test_work.target, 0xFF, sizeof(test_work.target));
    test_work.target[7] = 0x7FFFFFFF; // Very easy target
    test_work.targetdiff = 0.001;
    
    // Set some test data
    for (int i = 0; i < 35; i++) {
        test_work.data[i] = i + 1;
    }
    
    // Set solution (required for Verus)
    test_work.solution[0] = 7; // Version
    for (int i = 1; i < 1344; i++) {
        test_work.solution[i] = i % 256;
    }
    
    test_work.start_nonce = 0;
    test_work.max_nonce = 100000; // Test with 100k nonces
    strcpy(test_work.job_id, "test");
    
    struct wasm_result result;
    memset(&result, 0, sizeof(result));
    
    int ret = mine_work(&test_work, &result);
    
    printf("Test mining: ret=%d, found=%d, hashes=%lu, hashrate=%.2f H/s\n",
           ret, result.found, result.hashes_done, result.hashrate);
    
    return ret;
}
