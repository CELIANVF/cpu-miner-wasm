@echo off
REM Build script for WebAssembly version of Verus miner (Windows)
REM Requires Emscripten SDK to be installed and activated

echo Building Verus Miner for WebAssembly...

REM Activate Emscripten SDK from home directory
if exist "%USERPROFILE%\emsdk\emsdk_env.bat" (
    echo Activating Emscripten SDK from %USERPROFILE%\emsdk...
    call "%USERPROFILE%\emsdk\emsdk_env.bat"
) else if exist "%HOME%\emsdk\emsdk_env.bat" (
    echo Activating Emscripten SDK from %HOME%\emsdk...
    call "%HOME%\emsdk\emsdk_env.bat"
) else if exist ".\emsdk\emsdk_env.bat" (
    echo Activating Emscripten SDK from .\emsdk...
    call ".\emsdk\emsdk_env.bat"
) else (
    echo Warning: emsdk_env.bat not found in %USERPROFILE%\emsdk or .\emsdk
)

REM Check if Emscripten is available after activation
where emcc >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Emscripten not found!
    echo Please install Emscripten SDK:
    echo   git clone https://github.com/emscripten-core/emsdk.git %USERPROFILE%\emsdk
    echo   cd %USERPROFILE%\emsdk
    echo   emsdk install latest
    echo   emsdk activate latest
    echo   emsdk_env.bat
    exit /b 1
)

REM Verify Emscripten is working
echo Using Emscripten:
where emcc
emcc --version

REM Path to parent directory with verus sources
set PARENT_DIR=..\cpu-miner-verus

REM Compiler flags
set EMCC_FLAGS=-O3
set EMCC_FLAGS=%EMCC_FLAGS% -msimd128
set EMCC_FLAGS=%EMCC_FLAGS% -s WASM=1
set EMCC_FLAGS=%EMCC_FLAGS% -s "EXPORTED_FUNCTIONS=[\"_init_miner\",\"_request_restart\",\"_mine_work\",\"_get_hashrate\",\"_reset_miner\",\"_cleanup_miner\",\"_format_hashrate_string\",\"_test_miner\",\"_malloc\",\"_free\"]"
set EMCC_FLAGS=%EMCC_FLAGS% -s "EXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"HEAP8\",\"HEAPU8\",\"HEAP32\",\"HEAPU32\",\"HEAPF64\",\"_malloc\",\"_free\"]"
set EMCC_FLAGS=%EMCC_FLAGS% -s ALLOW_MEMORY_GROWTH=1
set EMCC_FLAGS=%EMCC_FLAGS% -s INITIAL_MEMORY=64MB
set EMCC_FLAGS=%EMCC_FLAGS% -s MAXIMUM_MEMORY=512MB
set EMCC_FLAGS=%EMCC_FLAGS% -s ASSERTIONS=0
set EMCC_FLAGS=%EMCC_FLAGS% -s ERROR_ON_UNDEFINED_SYMBOLS=0
set EMCC_FLAGS=%EMCC_FLAGS% -s MODULARIZE=1
set EMCC_FLAGS=%EMCC_FLAGS% -s EXPORT_NAME=createVerusMinerModule

REM Include directories (point to parent directory)
set INCLUDES=-I%PARENT_DIR% -I%PARENT_DIR%\verus

REM Verus source files
set VERUS_SOURCES=%PARENT_DIR%\verus\haraka_portable.c %PARENT_DIR%\verus\verus_clhash_portable.cpp %PARENT_DIR%\verus\verusscan_simple.cpp

REM Main WASM source
set MAIN_SOURCE=cpu-miner-wasm.cpp

REM Output files
set OUTPUT_JS=verus-miner.js

echo Compiling...
emcc %EMCC_FLAGS% %INCLUDES% %MAIN_SOURCE% %VERUS_SOURCES% -o %OUTPUT_JS%

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Build successful!
    echo   Output: %OUTPUT_JS% and verus-miner.wasm
    echo.
    echo To use in a web page:
    echo   ^<script src='%OUTPUT_JS%'^>^</script^>
) else (
    echo.
    echo Build failed!
    exit /b 1
)
