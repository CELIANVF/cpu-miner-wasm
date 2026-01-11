#ifndef MINER_WASM_H
#define MINER_WASM_H

#include <stdint.h>
#include <stdbool.h>

// WASM-compatible work structure (passed from JavaScript)
struct wasm_work {
    uint32_t data[48];        // Block data
    uint32_t target[8];       // Target hash
    uint8_t solution[1344];    // Verus solution template
    uint8_t extra[1388];      // Verus extra data (contains full solution for submission)
    uint32_t start_nonce;     // Starting nonce for this worker
    uint32_t max_nonce;       // Maximum nonce to check
    char job_id[128];         // Job ID (for tracking)
    double targetdiff;        // Target difficulty
};

// WASM-compatible result structure (returned to JavaScript)
struct wasm_result {
    bool found;               // Whether a share was found
    uint32_t nonce;           // Nonce that found the share
    uint32_t hash[8];         // Hash result (if found)
    uint32_t next_nonce;      // Next nonce to start from
    unsigned long hashes_done;// Number of hashes computed
    double hashrate;          // Computed hashrate
    double elapsed_time;      // Time taken for this mining session
};

#ifdef __cplusplus
extern "C" {
#endif

// Initialize miner (call once at startup)
int init_miner();

// Request restart (call from JavaScript to interrupt mining)
void request_restart();

// Main mining function - call this from JavaScript
// Returns: 0 on success, non-zero on error
// Note: input is non-const because the solution is updated when a share is found
int mine_work(struct wasm_work *input, struct wasm_result *output);

// Get last computed hashrate
double get_hashrate();

// Reset miner state (useful for new jobs)
void reset_miner();

// Cleanup (call when done)
void cleanup_miner();

// Format hashrate as string (for debugging/logging)
void format_hashrate_string(double hashrate, char *output, size_t output_size);

// Test function to verify WASM module is working
int test_miner();

#ifdef __cplusplus
}
#endif

#endif // MINER_WASM_H
