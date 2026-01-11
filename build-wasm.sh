#!/bin/bash
# Build script for WebAssembly version of Verus miner
# Requires Emscripten SDK to be installed and activated

echo "Building Verus Miner for WebAssembly..."

# Activate Emscripten SDK from ~/emsdk
EMSDK_DIR=""

# Find emsdk directory
if [ -d ~/emsdk ]; then
    EMSDK_DIR="$HOME/emsdk"
    echo "Found Emscripten SDK at ~/emsdk"
elif [ -d ./emsdk ]; then
    EMSDK_DIR="$(pwd)/emsdk"
    echo "Found Emscripten SDK at ./emsdk"
fi

if [ -n "$EMSDK_DIR" ]; then
    echo "Activating Emscripten SDK from $EMSDK_DIR..."
    
    # Debug: show what's in emsdk directory
    if [ "${DEBUG:-}" = "1" ]; then
        echo "Debug: Checking emsdk structure..."
        ls -la "$EMSDK_DIR" | head -10
        [ -d "$EMSDK_DIR/upstream" ] && echo "Debug: upstream directory exists" || echo "Debug: upstream directory NOT found"
        [ -d "$EMSDK_DIR/upstream/emscripten" ] && echo "Debug: upstream/emscripten directory exists" || echo "Debug: upstream/emscripten directory NOT found"
    fi
    
    # Find emcc in common locations
    EMCC_PATH=""
    if [ -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        EMCC_PATH="$EMSDK_DIR/upstream/emscripten/emcc"
        export PATH="$EMSDK_DIR/upstream/emscripten:$EMSDK_DIR/upstream/bin:$EMSDK_DIR:$PATH"
        export EMSDK="$EMSDK_DIR"
        export EMSCRIPTEN="$EMSDK_DIR/upstream/emscripten"
        echo "Found emcc at: $EMCC_PATH"
    elif [ -f "$EMSDK_DIR/emcc" ]; then
        EMCC_PATH="$EMSDK_DIR/emcc"
        export PATH="$EMSDK_DIR:$PATH"
        export EMSDK="$EMSDK_DIR"
        echo "Found emcc at: $EMCC_PATH"
    else
        # Search for emcc in the directory tree
        EMCC_PATH=$(find "$EMSDK_DIR" -name "emcc" -type f 2>/dev/null | head -1)
        if [ -n "$EMCC_PATH" ]; then
            EMCC_DIR=$(dirname "$EMCC_PATH")
            export PATH="$EMCC_DIR:$PATH"
            export EMSDK="$EMSDK_DIR"
            export EMSCRIPTEN="$EMCC_DIR"
            echo "Found emcc at: $EMCC_PATH (searched directory tree)"
        fi
    fi
    
    # Also try to source emsdk_env.sh if it exists (may set additional variables)
    if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        # Source in a subshell and extract environment variables
        ENV_VARS=$(cd "$EMSDK_DIR" && bash -c 'source ./emsdk_env.sh 2>/dev/null; env' | grep -E '^(PATH|EMSDK|EMCC|EMSCRIPTEN|EM_CONFIG|LLVM_ROOT|BINARYEN_ROOT|NODE_JS)=' || true)
        if [ -n "$ENV_VARS" ]; then
            while IFS= read -r line; do
                export "$line"
            done <<< "$ENV_VARS"
            echo "Emscripten environment variables loaded"
        fi
    fi
    
    # If we found emcc, set EMCC_CMD and add to PATH
    if [ -n "$EMCC_PATH" ] && [ -f "$EMCC_PATH" ]; then
        EMCC_CMD="$EMCC_PATH"
        # Also ensure it's in PATH
        export PATH="$(dirname "$EMCC_PATH"):$PATH"
        echo "Using emcc: $EMCC_CMD"
    fi
else
    echo "Warning: emsdk directory not found in ~/emsdk or ./emsdk"
fi

# Check if Emscripten is available after sourcing
# Try multiple methods to find emcc
if [ -z "$EMCC_CMD" ]; then
    if command -v emcc &> /dev/null; then
        EMCC_CMD="emcc"
    elif [ -n "$EMCC_PATH" ] && [ -f "$EMCC_PATH" ]; then
        EMCC_CMD="$EMCC_PATH"
    elif [ -n "$EMSDK_DIR" ] && [ -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        EMCC_CMD="$EMSDK_DIR/upstream/emscripten/emcc"
    elif [ -f "$HOME/emsdk/upstream/emscripten/emcc" ]; then
        EMCC_CMD="$HOME/emsdk/upstream/emscripten/emcc"
    fi
fi

# Final check - verify emcc exists
if [ -z "$EMCC_CMD" ]; then
    echo "Error: Could not locate emcc command"
    exit 1
fi

# Check if emcc file exists (could be a file or symlink)
if [ ! -e "$EMCC_CMD" ]; then
    echo "Error: Emscripten (emcc) not found!"
    echo ""
    echo "Troubleshooting:"
    echo "1. Check if emsdk is installed:"
    echo "   ls -la ~/emsdk"
    echo ""
    echo "2. Check if emscripten is installed:"
    echo "   ls -la ~/emsdk/upstream/emscripten/ 2>/dev/null || echo 'emscripten not found'"
    echo ""
    echo "3. If emsdk exists but emcc is missing, install/activate:"
    echo "   cd ~/emsdk"
    echo "   ./emsdk install latest"
    echo "   ./emsdk activate latest"
    echo ""
    echo "4. Or install from scratch:"
    echo "   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk"
    echo "   cd ~/emsdk"
    echo "   ./emsdk install latest"
    echo "   ./emsdk activate latest"
    exit 1
fi

# Verify Emscripten is working
echo "Using Emscripten: $EMCC_CMD"
if [ -e "$EMCC_CMD" ]; then
    echo "emcc found, testing..."
    "$EMCC_CMD" --version 2>&1 | head -1 || {
        echo "Warning: Could not get emcc version, but file exists"
        echo "File info: $(ls -la "$EMCC_CMD" 2>&1)"
    }
else
    echo "Error: emcc file does not exist at $EMCC_CMD"
    echo "Debug: Checking if path exists..."
    ls -la "$(dirname "$EMCC_CMD")" 2>&1 | head -5 || echo "Directory does not exist"
    exit 1
fi

# Path to parent directory with verus sources
PARENT_DIR="../cpu-miner-verus"

# Compiler flags
EMCC_FLAGS="-O3"
EMCC_FLAGS="$EMCC_FLAGS -msimd128"                    # Enable WASM SIMD
EMCC_FLAGS="$EMCC_FLAGS -s WASM=1"                    # Generate WASM
EMCC_FLAGS="$EMCC_FLAGS -s EXPORTED_FUNCTIONS=[_init_miner,_request_restart,_mine_work,_get_hashrate,_reset_miner,_cleanup_miner,_format_hashrate_string,_test_miner,_malloc,_free]"
EMCC_FLAGS="$EMCC_FLAGS -s EXPORTED_RUNTIME_METHODS=[ccall,cwrap,UTF8ToString,stringToUTF8,HEAP8,HEAP32,HEAPF64]"
EMCC_FLAGS="$EMCC_FLAGS -s ALLOW_MEMORY_GROWTH=1"     # Allow memory growth
EMCC_FLAGS="$EMCC_FLAGS -s INITIAL_MEMORY=64MB"       # Initial memory
EMCC_FLAGS="$EMCC_FLAGS -s MAXIMUM_MEMORY=512MB"      # Max memory
EMCC_FLAGS="$EMCC_FLAGS -s ASSERTIONS=0"              # Disable assertions in release
EMCC_FLAGS="$EMCC_FLAGS -s ERROR_ON_UNDEFINED_SYMBOLS=0"  # Allow some undefined symbols
EMCC_FLAGS="$EMCC_FLAGS -s MODULARIZE=1"              # Modular output
EMCC_FLAGS="$EMCC_FLAGS -s EXPORT_NAME=createVerusMinerModule"  # Module name

# Include directories (point to parent directory)
INCLUDES="-I$PARENT_DIR -I$PARENT_DIR/verus"

# Verus source files (use portable versions where available)
VERUS_SOURCES="$PARENT_DIR/verus/haraka_portable.c"
VERUS_SOURCES="$VERUS_SOURCES $PARENT_DIR/verus/verus_clhash_portable.cpp"
VERUS_SOURCES="$VERUS_SOURCES $PARENT_DIR/verus/verusscan_simple.cpp"

# Main WASM source
MAIN_SOURCE="cpu-miner-wasm.cpp"

# Output files
OUTPUT_JS="verus-miner.js"
OUTPUT_WASM="verus-miner.wasm"

echo "Compiling with flags: $EMCC_FLAGS"
echo "Sources: $MAIN_SOURCE $VERUS_SOURCES"

# Compile
set -e  # Enable error checking for compilation

# Use the found emcc command
if [ -z "$EMCC_CMD" ]; then
    EMCC_CMD="emcc"
fi

echo "Compiling with: $EMCC_CMD"
"$EMCC_CMD" $EMCC_FLAGS $INCLUDES \
    $MAIN_SOURCE \
    $VERUS_SOURCES \
    -o $OUTPUT_JS

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Build successful!"
    echo "  Output: $OUTPUT_JS and $OUTPUT_WASM"
    echo ""
    echo "To use in a web page:"
    echo "  <script src='$OUTPUT_JS'></script>"
    echo "  <script src='verus-miner-js.js'></script>"
else
    echo ""
    echo "✗ Build failed!"
    exit 1
fi
