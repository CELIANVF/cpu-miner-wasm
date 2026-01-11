# WebAssembly-Compatible Verus Miner

## Overview

This directory contains a WebAssembly-compatible version of the Verus CPU miner. Unlike the original `cpu-miner.cpp` which includes networking and threading, this version focuses solely on the core mining algorithm, making it suitable for compilation to WebAssembly.

**Note:** This version requires the parent `cpu-miner-verus` directory for the Verus algorithm source files.

## Files

### Core WASM Code
- **`cpu-miner-wasm.cpp`** - Main WASM-compatible miner implementation
  - Removes all networking/stratum code (handled by web server)
  - Removes pthread dependencies (parallelization via Web Workers)
  - Exposes simple C functions callable from JavaScript
  - Uses Emscripten-compatible time functions

- **`miner_wasm.h`** - Header file with WASM-compatible structures and function declarations

### Build Scripts
- **`build-wasm.sh`** - Linux/macOS build script
- **`build-wasm.bat`** - Windows build script

### JavaScript Integration
- **`verus-miner-js-example.js`** - JavaScript wrapper class for easy integration
  - Provides `VerusMiner` class with simple API
  - Handles memory management between JS and WASM
  - Example usage included

### Documentation
- **`WASM_BUILD_INSTRUCTIONS.md`** - Detailed build and usage instructions

## Key Differences from Original

| Feature | Original (`cpu-miner.cpp`) | WASM Version (`cpu-miner-wasm.cpp`) |
|---------|---------------------------|-------------------------------------|
| Networking | libcurl/stratum | Removed (handled by web server) |
| Threading | pthread | Removed (use Web Workers in JS) |
| System Calls | POSIX (unistd, sys/time) | Emscripten polyfills |
| Entry Point | `main()` function | Exported C functions |
| Work Source | Stratum pool | Passed from JavaScript |
| Share Submission | Direct to pool | Returned to JavaScript |

## Quick Start

### 1. Install Emscripten SDK

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

### 2. Build WASM Module

```bash
cd cpu-miner-wasm
chmod +x build-wasm.sh
./build-wasm.sh  # or build-wasm.bat on Windows
```

This creates:
- `verus-miner.js` - JavaScript loader
- `verus-miner.wasm` - WebAssembly binary

### 3. Use in Web Application

```html
<script src="verus-miner.js"></script>
<script src="verus-miner-js-example.js"></script>
<script>
createVerusMinerModule().then(module => {
    const miner = new VerusMiner(module);
    
    // Mine a work unit
    const work = {
        data: [/* 48 uint32 values */],
        target: [/* 8 uint32 values */],
        solution: new Uint8Array(1344),
        start_nonce: 0,
        max_nonce: 1000000,
        job_id: 'job-1',
        targetdiff: 1.0
    };
    
    const result = miner.mine(work);
    console.log(result);
});
</script>
```

## API

### VerusMiner Class

```javascript
// Initialize
const miner = new VerusMiner(module);

// Mine a work unit
const result = miner.mine({
    data: Uint32Array,      // 48 elements - block data
    target: Uint32Array,     // 8 elements - target hash
    solution: Uint8Array,    // 1344 bytes - Verus solution
    start_nonce: number,     // Starting nonce
    max_nonce: number,       // Maximum nonce to check
    job_id: string,          // Job identifier
    targetdiff: number       // Target difficulty
});

// Result object:
{
    found: boolean,         // Whether share was found
    nonce: number,          // Nonce that found share (if found)
    hash: Uint32Array,      // 8 elements - hash result
    next_nonce: number,     // Continue from here
    hashes_done: number,    // Number of hashes computed
    hashrate: number,       // Hashes per second
    elapsed_time: number    // Time taken (seconds)
}

// Other methods
miner.getHashrate()        // Get last hashrate
miner.reset()              // Reset state
miner.cleanup()            // Free resources
miner.test()               // Test miner
```

## Integration with Web Server

The web server should:

1. **Connect to Mining Pool** - Handle Stratum protocol
2. **Receive Mining Jobs** - Parse `mining.notify` messages
3. **Distribute Work** - Send work units to browser clients
4. **Receive Shares** - Accept found shares from clients
5. **Submit Shares** - Submit to pool via Stratum

Example flow:

```
Pool → Web Server → Browser → WASM Miner → Browser → Web Server → Pool
      (Stratum)    (HTTP/WS)  (Mining)     (Result)  (HTTP/WS)   (Stratum)
```

## Performance

- **Single-threaded**: ~50-80% of native performance
- **With SIMD**: ~2-4x speedup (if browser supports WASM SIMD)
- **Parallelization**: Use multiple Web Workers (one per CPU core)
- **Memory**: ~64-128MB per worker

## Browser Compatibility

- **Chrome 91+**: Full support (SIMD, SharedArrayBuffer with headers)
- **Firefox 89+**: Full support (SIMD, SharedArrayBuffer with headers)
- **Safari 16.4+**: SIMD support, SharedArrayBuffer restrictions
- **Edge 91+**: Full support (same as Chrome)

## Notes

- Networking is completely removed - web server handles all pool communication
- Threading is removed - use Web Workers in JavaScript for parallelization
- All POSIX system calls use Emscripten polyfills
- The core VerusHash algorithm remains unchanged
- SIMD support requires modern browsers and `-msimd128` build flag
- Requires parent `cpu-miner-verus` directory for Verus algorithm sources
