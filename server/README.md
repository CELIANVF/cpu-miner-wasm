# Verus Miner WebSocket Server

WebSocket server that bridges mining pools (Stratum protocol) and web miners (WebSocket).

## Features

- **Stratum Client**: Connects to mining pools using Stratum protocol
- **WebSocket Server**: Provides WebSocket API for browser-based miners
- **Work Distribution**: Distributes mining work from pool to web miners
- **Share Submission**: Submits found shares from web miners to pool
- **Auto-reconnect**: Automatically reconnects to pool on connection loss

## Installation

### Node.js Version

```bash
cd server
npm install
```

### Python Version

```bash
pip install websockets
```

## Usage

### Node.js

```bash
node server.js --pool stratum+tcp://pool.verus.io:9999 --user YOUR_WALLET.name --pass x --port 8080
```

### Python

```bash
python server.py --pool stratum+tcp://pool.verus.io:9999 --user YOUR_WALLET.name --pass x --port 8080
```

### Environment Variables

You can also use environment variables:

```bash
export POOL_URL=stratum+tcp://pool.verus.io:9999
export POOL_USER=YOUR_WALLET.name
export POOL_PASS=x
export WS_PORT=8080
node server.js
```

## WebSocket Protocol

### Client → Server

#### Connect
WebSocket connection to `ws://172.21.112.214:8080`

#### Receive Work
```json
{
  "type": "work",
  "work": {
    "data": [/* 48 uint32 values */],
    "target": [/* 8 uint32 values */],
    "solution": [/* 1344 bytes */],
    "start_nonce": 0,
    "max_nonce": 4294967295,
    "job_id": "job123",
    "targetdiff": 1.0
  }
}
```

#### Submit Share
```json
{
  "type": "share",
  "work": {/* work object */},
  "nonce": 12345678
}
```

#### Ping
```json
{
  "type": "ping"
}
```

### Server → Client

#### Work Update
```json
{
  "type": "work",
  "work": {/* work object */}
}
```

#### Pong
```json
{
  "type": "pong"
}
```

## Integration with Web Miner

Example JavaScript code to connect to the server:

```javascript
const ws = new WebSocket('ws://172.21.112.214:8080');

ws.onopen = () => {
    console.log('Connected to mining server');
};

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    if (message.type === 'work') {
        // Mine the work
        const result = miner.mine(message.work);
        
        if (result.found) {
            // Submit share
            ws.send(JSON.stringify({
                type: 'share',
                work: message.work,
                nonce: result.nonce
            }));
        } else {
            // Continue mining from result.next_nonce
            message.work.start_nonce = result.next_nonce;
            // Mine again...
        }
    }
};
```

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ Mining Pool │◄───────►│ WebSocket   │◄───────►│ Web Miners  │
│  (Stratum)  │  TCP    │   Server    │  WS     │  (Browser)  │
└─────────────┘         └──────────────┘         └─────────────┘
                              │
                              │
                        ┌─────┴─────┐
                        │  Work     │
                        │  Manager  │
                        └───────────┘
```

## Configuration

### Command Line Arguments

- `--pool`: Pool URL (e.g., `stratum+tcp://pool.verus.io:9999`)
- `--user`: Mining username/wallet address
- `--pass`: Mining password (default: `x`)
- `--port`: WebSocket server port (default: `8080`)
- `--debug`: Enable debug logging

### Environment Variables

- `POOL_URL`: Pool URL
- `POOL_USER`: Mining username
- `POOL_PASS`: Mining password
- `WS_PORT`: WebSocket port
- `DEBUG`: Enable debug (set to `1`)

## Troubleshooting

### Connection Issues

1. **Cannot connect to pool**
   - Check pool URL format: `stratum+tcp://host:port`
   - Verify pool is accessible
   - Check firewall settings

2. **WebSocket connection refused**
   - Verify port is not in use
   - Check firewall allows connections on WebSocket port
   - Ensure server is running

### Share Submission Issues

1. **Shares rejected**
   - Verify job_id matches current job
   - Check nonce format (hex string)
   - Ensure work data is correct

2. **No shares found**
   - Check target difficulty
   - Verify work data format
   - Ensure WASM miner is working correctly

## Notes

- The server automatically handles reconnection to the pool
- Work is broadcast to all connected web miners when new jobs arrive
- Shares are submitted to the pool immediately when received
- The server maintains connection state and handles Stratum protocol messages
