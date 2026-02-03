#!/bin/bash

# Script to run the Verus Miner WebSocket Server
# This script starts both the HTTP web server and WebSocket server

echo "Starting Verus Miner WebSocket Server..."

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if we're in the correct directory
if [ ! -f "server.js" ]; then
    echo "Error: server.js not found. Please run this script from the server directory."
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Set default environment variables if not set
export POOL_URL=${POOL_URL:-"stratum+tcp://pool.verus.io:9999"}
export POOL_USER=${POOL_USER:-""}
export POOL_PASS=${POOL_PASS:-"x"}
export WS_PORT=${WS_PORT:-"8080"}

echo "Configuration:"
echo "  Pool URL: $POOL_URL"
echo "  Pool User: $POOL_USER"
echo "  Pool Pass: $POOL_PASS"
echo "  WebSocket Port: $WS_PORT"
echo ""

# Run the server
node server.js --debug