#!/usr/bin/env python3
"""
Verus Miner WebSocket Server (Python version)

Bridges mining pool (Stratum protocol) and web miners (WebSocket)

Usage:
    python server.py --pool stratum+tcp://pool.verus.io:9999 --user WALLET_ADDRESS.name --pass x --port 8080
"""

import asyncio
import websockets
import socket
import json
import hashlib
import struct
import argparse
import sys
from typing import Optional, Set, Dict, Any
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

class StratumClient:
    """Stratum protocol client for connecting to mining pool"""
    
    def __init__(self, pool_host: str, pool_port: int, user: str, password: str):
        self.pool_host = pool_host
        self.pool_port = pool_port
        self.user = user
        self.password = password
        
        self.socket: Optional[socket.socket] = None
        self.connected = False
        self.subscribed = False
        self.authorized = False
        
        self.session_id: Optional[str] = None
        self.xnonce1: Optional[bytes] = None
        self.xnonce1_size = 0
        self.xnonce2_size = 4
        self.xnonce2 = bytearray(4)
        self.message_id = 0
        self.pending_requests: Dict[int, asyncio.Future] = {}
        
        self.current_job: Optional[Dict[str, Any]] = None
        self.current_target: Optional[bytes] = None
        self.current_difficulty = 1.0
        self.is_equihash = False
        
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        
    async def connect(self):
        """Connect to mining pool"""
        try:
            logger.info(f"Connecting to pool {self.pool_host}:{self.pool_port}...")
            self.reader, self.writer = await asyncio.open_connection(
                self.pool_host, self.pool_port
            )
            self.connected = True
            logger.info("Connected to pool")
            await self.subscribe()
            asyncio.create_task(self._read_loop())
        except Exception as e:
            logger.error(f"Connection error: {e}")
            self.connected = False
            await asyncio.sleep(5)
            await self.connect()
    
    async def _read_loop(self):
        """Read messages from pool"""
        try:
            while self.connected:
                line = await self.reader.readline()
                if not line:
                    break
                await self.handle_pool_message(line.decode().strip())
        except Exception as e:
            logger.error(f"Read error: {e}")
            self.connected = False
            await asyncio.sleep(5)
            await self.connect()
    
    def send(self, message: dict) -> bool:
        """Send message to pool"""
        if not self.writer or not self.connected:
            return False
        json_str = json.dumps(message) + '\n'
        logger.debug(f"→ Pool: {json_str.strip()}")
        self.writer.write(json_str.encode())
        return True
    
    def send_request(self, method: str, params: list, callback=None):
        """Send request to pool"""
        self.message_id += 1
        message = {
            'id': self.message_id,
            'method': method,
            'params': params
        }
        if callback:
            future = asyncio.Future()
            self.pending_requests[self.message_id] = future
            asyncio.create_task(self._handle_response(future, callback))
        return self.send(message)
    
    async def _handle_response(self, future: asyncio.Future, callback):
        """Handle response from pool"""
        try:
            result = await asyncio.wait_for(future, timeout=30)
            if callback:
                callback(None, result)
        except asyncio.TimeoutError:
            if callback:
                callback(Exception("Timeout"), None)
        except Exception as e:
            if callback:
                callback(e, None)
    
    async def subscribe(self):
        """Subscribe to pool"""
        def on_subscribe(error, result):
            if error:
                logger.error(f"Subscribe failed: {error}")
                return
            logger.info("Subscribed to pool")
            self.subscribed = True
            
            if result and len(result) >= 2:
                self.session_id = result[0]
                extra_nonce1 = result[1]
                self.xnonce1 = bytes.fromhex(extra_nonce1)
                self.xnonce1_size = len(self.xnonce1)
                if len(result) > 2:
                    self.xnonce2_size = result[2]
                logger.info(f"Session ID: {self.session_id}, xnonce1: {extra_nonce1}, xnonce2_size: {self.xnonce2_size}")
            
            self.authorize()
        
        self.send_request('mining.subscribe', ['verus-miner-ws/1.0'], on_subscribe)
    
    def authorize(self):
        """Authorize with pool"""
        def on_authorize(error, result):
            if error:
                logger.error(f"Authorization failed: {error}")
                return
            if result is True:
                logger.info(f"Authorized as {self.user}")
                self.authorized = True
            else:
                logger.error(f"Authorization rejected: {result}")
        
        self.send_request('mining.authorize', [self.user, self.password], on_authorize)
    
    async def handle_pool_message(self, line: str):
        """Handle message from pool"""
        logger.debug(f"← Pool: {line}")
        
        try:
            message = json.loads(line)
            
            # Handle responses
            if 'id' in message and message['id'] is not None:
                request_id = message['id']
                if request_id in self.pending_requests:
                    future = self.pending_requests.pop(request_id)
                    if 'error' in message:
                        future.set_exception(Exception(message['error'].get('message', 'Unknown error')))
                    else:
                        future.set_result(message.get('result'))
                return
            
            # Handle notifications
            if 'method' in message:
                await self.handle_pool_notification(message)
        except Exception as e:
            logger.error(f"Failed to parse pool message: {e}")
    
    async def handle_pool_notification(self, message: dict):
        """Handle notification from pool"""
        method = message.get('method')
        params = message.get('params', [])
        
        if method == 'mining.notify':
            self.handle_mining_notify(params)
        elif method == 'mining.set_difficulty':
            if params:
                self.current_difficulty = float(params[0])
                logger.info(f"Difficulty set to: {self.current_difficulty}")
        elif method == 'mining.set_target':
            if params:
                target_hex = params[0]
                self.current_target = bytes.fromhex(target_hex)
                self.is_equihash = True
                logger.info(f"Target set: {target_hex}")
                if self.current_job:
                    self.current_job['work']['target'] = list(self.current_target)
        elif method == 'mining.pong':
            pass  # Pool responded to ping
        elif method == 'client.show_message':
            logger.info(f"Pool message: {params}")
    
    def handle_mining_notify(self, params: list):
        """Handle mining.notify from pool"""
        if len(params) < 6:
            logger.error("Invalid mining.notify parameters")
            return
        
        job_id = params[0]
        prevhash = params[1]
        coinb1 = params[2]
        coinb2 = params[3]
        merkle_branches = params[4]
        version = params[5]
        nbits = params[6] if len(params) > 6 else ''
        ntime = params[7] if len(params) > 7 else ''
        clean = params[8] if len(params) > 8 else False
        solution = params[9] if len(params) > 9 else None
        
        logger.info(f"New job: {job_id} (clean: {clean})")
        
        # Increment extranonce2
        self.increment_xnonce2()
        
        # Build work
        work = self.build_work(job_id, prevhash, coinb1, coinb2, merkle_branches, 
                              version, nbits, ntime, solution)
        
        self.current_job = {
            'job_id': job_id,
            'work': work,
            'clean': clean,
            'timestamp': asyncio.get_event_loop().time()
        }
        
        # Broadcast to web miners (will be set by WebSocketServer)
        if hasattr(self, 'broadcast_work'):
            self.broadcast_work(work)
    
    def increment_xnonce2(self):
        """Increment extranonce2"""
        for i in range(len(self.xnonce2)):
            self.xnonce2[i] = (self.xnonce2[i] + 1) % 256
            if self.xnonce2[i] != 0:
                break
    
    def build_work(self, job_id: str, prevhash: str, coinb1: str, coinb2: str,
                   merkle_branches: list, version: str, nbits: str, ntime: str, solution: Optional[str]) -> dict:
        """Build work object for WASM miner"""
        # Convert hex strings to bytes
        prevhash_buf = bytes.fromhex(prevhash)
        coinb1_buf = bytes.fromhex(coinb1)
        coinb2_buf = bytes.fromhex(coinb2)
        version_buf = bytes.fromhex(version)
        nbits_buf = bytes.fromhex(nbits) if nbits else b'\x00' * 4
        ntime_buf = bytes.fromhex(ntime) if ntime else b'\x00' * 4
        
        # Build coinbase
        coinbase = coinb1_buf + self.xnonce1 + bytes(self.xnonce2[:self.xnonce2_size]) + coinb2_buf
        
        # Calculate merkle root
        merkle_root = self.calculate_merkle_root(coinbase, merkle_branches)
        
        # Build block data (48 uint32 values)
        data = [0] * 48
        
        # Version (little-endian)
        data[0] = struct.unpack('<I', version_buf[:4])[0]
        
        # Previous hash (8 uint32, little-endian)
        for i in range(8):
            data[1 + i] = struct.unpack('<I', prevhash_buf[i*4:(i+1)*4])[0]
        
        # Merkle root (8 uint32, little-endian)
        for i in range(8):
            data[9 + i] = struct.unpack('<I', merkle_root[i*4:(i+1)*4])[0]
        
        # ntime (little-endian)
        if ntime_buf:
            data[25] = struct.unpack('<I', ntime_buf[:4])[0]
        
        # nbits (little-endian)
        if nbits_buf:
            data[26] = struct.unpack('<I', nbits_buf[:4])[0]
        
        # xnonce1 (up to 8 bytes)
        xnonce1_words = min(8, (self.xnonce1_size + 3) // 4)
        for i in range(xnonce1_words):
            chunk = self.xnonce1[i*4:(i+1)*4]
            if len(chunk) < 4:
                chunk += b'\x00' * (4 - len(chunk))
            data[27 + i] = struct.unpack('<I', chunk)[0]
        
        # Padding
        data[35] = 0x80
        
        # Solution (1344 bytes)
        solution_buf = bytes.fromhex(solution) if solution else b'\x00' * 1344
        solution_buf = solution_buf[:1344]
        
        # Build target
        if self.current_target:
            target = [struct.unpack('<I', self.current_target[i*4:(i+1)*4])[0] 
                      for i in range(8)]
        else:
            target = [0xFFFFFFFF] * 8
        
        # Build work object
        work = {
            'data': data,
            'target': target,
            'solution': list(solution_buf),
            'start_nonce': 0,
            'max_nonce': 0xFFFFFFFF,
            'job_id': job_id,
            'targetdiff': self.current_difficulty
        }
        
        return work
    
    def calculate_merkle_root(self, coinbase: bytes, merkle_branches: list) -> bytes:
        """Calculate merkle root"""
        # Simplified merkle root calculation
        merkle = hashlib.sha256(coinbase).digest()
        
        if merkle_branches:
            for branch_hex in merkle_branches:
                branch = bytes.fromhex(branch_hex)
                combined = merkle + branch
                merkle = hashlib.sha256(combined).digest()
        
        # Double SHA256
        return hashlib.sha256(hashlib.sha256(merkle).digest()).digest()
    
    def submit_share(self, work: dict, nonce: int, extranonce2: bytes):
        """Submit share to pool"""
        if not self.authorized:
            return False
        
        params = [
            self.user,
            work['job_id'],
            extranonce2.hex(),
            '',  # ntime (would need to extract from work)
            f"{nonce:08x}"
        ]
        
        def on_submit(error, result):
            if error:
                logger.error(f"Share submission error: {error}")
            elif result is True:
                logger.info(f"✓ Share accepted! Nonce: {nonce:08x}")
            else:
                logger.warning(f"✗ Share rejected: {result}")
        
        self.send_request('mining.submit', params, on_submit)
        return True


class WebSocketServer:
    """WebSocket server for web miners"""
    
    def __init__(self, port: int, stratum_client: StratumClient):
        self.port = port
        self.stratum_client = stratum_client
        self.clients: Set[websockets.WebSocketServerProtocol] = set()
        self.current_work: Optional[dict] = None
        
        # Set callback for stratum client
        stratum_client.broadcast_work = self.broadcast_work
    
    async def handle_client(self, websocket, path):
        """Handle new WebSocket client"""
        client_id = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
        logger.info(f"Web miner connected: {client_id}")
        self.clients.add(websocket)
        
        # Send current work if available
        if self.current_work:
            await self.send_work(websocket, self.current_work)
        
        try:
            async for message in websocket:
                await self.handle_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            logger.info(f"Web miner disconnected: {client_id}")
            self.clients.discard(websocket)
    
    async def handle_message(self, websocket, message: str):
        """Handle message from web miner"""
        try:
            data = json.loads(message)
            
            if data.get('type') == 'share':
                await self.handle_share(data)
            elif data.get('type') == 'ping':
                await websocket.send(json.dumps({'type': 'pong'}))
        except Exception as e:
            logger.error(f"Failed to parse message: {e}")
    
    async def handle_share(self, data: dict):
        """Handle share submission from web miner"""
        work = data.get('work')
        nonce = data.get('nonce')
        
        if not work or nonce is None:
            return
        
        logger.info(f"Share received: nonce={nonce:08x}, job_id={work.get('job_id')}")
        
        # Submit to pool
        if (self.stratum_client.current_job and 
            self.stratum_client.current_job['job_id'] == work.get('job_id')):
            extranonce2 = bytes(self.stratum_client.xnonce2[:self.stratum_client.xnonce2_size])
            self.stratum_client.submit_share(work, nonce, extranonce2)
        else:
            logger.warning("Share rejected: job_id mismatch")
    
    async def send_work(self, websocket, work: dict):
        """Send work to web miner"""
        await websocket.send(json.dumps({
            'type': 'work',
            'work': work
        }))
    
    def broadcast_work(self, work: dict):
        """Broadcast work to all connected web miners"""
        self.current_work = work
        message = json.dumps({
            'type': 'work',
            'work': work
        })
        
        # Schedule broadcast
        asyncio.create_task(self._broadcast(message))
    
    async def _broadcast(self, message: str):
        """Broadcast message to all clients"""
        disconnected = set()
        for client in self.clients:
            try:
                await client.send(message)
            except:
                disconnected.add(client)
        
        # Remove disconnected clients
        self.clients -= disconnected
    
    async def start(self):
        """Start WebSocket server"""
        logger.info(f"WebSocket server listening on port {self.port}")
        async with websockets.serve(self.handle_client, "0.0.0.0", self.port):
            await asyncio.Future()  # Run forever


def parse_pool_url(url: str) -> tuple:
    """Parse pool URL"""
    import re
    match = re.match(r'stratum\+tcp://([^:]+):(\d+)', url)
    if not match:
        raise ValueError(f"Invalid pool URL: {url}")
    return match.group(1), int(match.group(2))


async def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Verus Miner WebSocket Server')
    parser.add_argument('--pool', default='stratum+tcp://pool.verus.io:9999',
                       help='Pool URL (default: stratum+tcp://pool.verus.io:9999)')
    parser.add_argument('--user', required=True, help='Mining username/wallet')
    parser.add_argument('--pass', dest='password', default='x', help='Mining password (default: x)')
    parser.add_argument('--port', type=int, default=8080, help='WebSocket port (default: 8080)')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    pool_host, pool_port = parse_pool_url(args.pool)
    
    logger.info("Verus Miner WebSocket Server")
    logger.info(f"Pool: {args.pool}")
    logger.info(f"User: {args.user}")
    logger.info(f"WebSocket Port: {args.port}")
    logger.info("")
    
    # Create stratum client
    stratum_client = StratumClient(pool_host, pool_port, args.user, args.password)
    
    # Create WebSocket server
    ws_server = WebSocketServer(args.port, stratum_client)
    
    # Connect to pool
    await stratum_client.connect()
    
    # Start WebSocket server
    await ws_server.start()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("\nShutting down...")
        sys.exit(0)
