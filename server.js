const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── Security: HTTP Rate Limiting ──────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ─── TURN Credentials ──────────────────────────────────────────────────────────
// Supports custom TURN via environment variables:
//   TURN_URL      — e.g. "turn:your-server.metered.live:443"
//   TURN_USERNAME — your TURN username
//   TURN_CREDENTIAL — your TURN credential
// Falls back to free public STUN + OpenRelay TURN if not set.

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

function getTurnServers() {
  const customUrl = process.env.TURN_URL;
  const customUser = process.env.TURN_USERNAME;
  const customCred = process.env.TURN_CREDENTIAL;

  if (customUrl && customUser && customCred) {
    console.log('  ⚡  Using custom TURN server:', customUrl);
    return [
      ...STUN_SERVERS,
      { urls: customUrl, username: customUser, credential: customCred },
      // Also try TCP/TLS variants for restrictive networks
      { urls: customUrl.replace(':443', ':443?transport=tcp'), username: customUser, credential: customCred },
    ];
  }

  // Fallback: free OpenRelay (unreliable, for development only)
  console.log('  ⚡  Using free TURN servers (set TURN_URL, TURN_USERNAME, TURN_CREDENTIAL for production)');
  return [
    ...STUN_SERVERS,
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

const TURN_SERVERS = getTurnServers();

// API endpoint: serve TURN credentials to clients
app.get('/api/turn-credentials', (req, res) => {
  res.json({ iceServers: TURN_SERVERS, ttl: 86400 });
});

// ─── Peer & Room Management ───────────────────────────────────────────────────

const peers = new Map();   // peerId → { ws, deviceInfo, room, lastPing }
const rooms = new Map();   // roomName → { peers: Set<peerId>, createdAt, lastActivity }
let stats = { totalConnections: 0, activeConnections: 0, roomsCreated: 0 };

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Derive a "room" name from the client IP so that devices on the
 * same local network are automatically grouped together.
 */
function getRoomFromIP(ip) {
  const cleaned = ip.replace('::ffff:', '');
  // All localhost variants go to the same room
  if (cleaned === '::1' || cleaned === '1' || cleaned.startsWith('127.')) {
    return 'local';
  }
  const parts = cleaned.split('.');
  if (parts.length === 4) {
    return 'net-' + parts.slice(0, 3).join('.');
  }
  return 'default';
}

function addToRoom(roomName, peerId) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, { peers: new Set(), createdAt: Date.now(), lastActivity: Date.now() });
    stats.roomsCreated++;
  }
  const room = rooms.get(roomName);
  room.peers.add(peerId);
  room.lastActivity = Date.now();
}

function removeFromRoom(roomName, peerId) {
  if (rooms.has(roomName)) {
    const room = rooms.get(roomName);
    room.peers.delete(peerId);
    if (room.peers.size === 0) {
      rooms.delete(roomName);
    }
  }
}

/**
 * Tell every peer in `roomName` about `newPeerId`, and tell
 * `newPeerId` about every existing peer in the room.
 */
function notifyRoom(roomName, newPeerId) {
  const room = rooms.get(roomName);
  if (!room) return;

  const existingPeers = [];

  for (const id of room.peers) {
    if (id === newPeerId) continue;
    const peer = peers.get(id);
    if (!peer) continue;

    existingPeers.push({ peerId: id, deviceInfo: peer.deviceInfo });

    // Notify existing peer about the newcomer
    safeSend(peer.ws, {
      type: 'peer-joined',
      peerId: newPeerId,
      deviceInfo: peers.get(newPeerId)?.deviceInfo,
    });
  }

  // Send full peer list to the newcomer
  const newPeer = peers.get(newPeerId);
  if (newPeer) {
    safeSend(newPeer.ws, { type: 'peers', peers: existingPeers });
  }
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    // ignore
  }
}

function broadcastLeft(roomName, peerId) {
  const room = rooms.get(roomName);
  if (!room) return;
  for (const otherId of room.peers) {
    const other = peers.get(otherId);
    if (other) {
      safeSend(other.ws, { type: 'peer-left', peerId });
    }
  }
}

// ─── Room Auto-Cleanup (every 5 minutes, expire rooms inactive >1 hour) ──────

setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  for (const [name, room] of rooms) {
    if (room.peers.size === 0 && now - room.lastActivity > ONE_HOUR) {
      rooms.delete(name);
      console.log(`🧹 Room expired: ${name}`);
    }
  }
}, 5 * 60 * 1000);

// ─── WebSocket Heartbeat (every 30s) ─────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

setInterval(() => {
  for (const [peerId, peer] of peers) {
    if (peer.ws.readyState !== 1) continue;
    if (peer.waitingPong) {
      // Didn't respond to last ping — terminate
      console.log(`💀 Peer ${peerId} heartbeat timeout — disconnecting`);
      peer.ws.terminate();
      continue;
    }
    peer.waitingPong = true;
    safeSend(peer.ws, { type: 'ping', ts: Date.now() });
  }
}, HEARTBEAT_INTERVAL);

// ─── WebSocket Handling ───────────────────────────────────────────────────────

// Security: IP-based connection and rate limiting
const ipConnections = new Map(); // IP -> connection count
const failedJoinAttempts = new Map(); // IP -> { count, lockedUntil }
const MAX_CONNS_PER_IP = 10;
const MAX_FAILED_JOINS = 5;
const LOCKOUT_DURATION = 5 * 60 * 1000; // 5 minutes

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  
  // IP Connection Limiting (Prevent DDoS/Spam)
  const currentConns = ipConnections.get(ip) || 0;
  if (currentConns >= MAX_CONNS_PER_IP) {
    console.warn(`[SECURITY] Blocked connection from ${ip}: Exceeded max connections (${MAX_CONNS_PER_IP})`);
    ws.close(1008, 'Too many connections from this IP');
    return;
  }
  ipConnections.set(ip, currentConns + 1);

  // Check if IP is locked out from brute forcing rooms
  const lockoutInfo = failedJoinAttempts.get(ip);
  if (lockoutInfo && lockoutInfo.lockedUntil > Date.now()) {
    console.warn(`[SECURITY] Blocked connection from ${ip}: Temporarily locked out due to brute force attempts`);
    ws.close(1008, 'Temporarily blocked due to too many failed room attempts');
    ipConnections.set(ip, ipConnections.get(ip) - 1); // Clean up on disconnect
    return;
  }

  const peerId = generateId();
  // Simulate completely isolated networks (Mobile vs PC) for testing Room Codes
  const autoRoom = 'isolated-' + crypto.randomBytes(8).toString('hex');

  stats.totalConnections++;
  stats.activeConnections++;

  console.log(`⚡ Peer connected: ${peerId} (IP: ${ip}, room: ${autoRoom}) [Active: ${stats.activeConnections}]`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // ── Heartbeat response ───────────────────────────────────────
      case 'pong': {
        const peer = peers.get(peerId);
        if (peer) {
          peer.waitingPong = false;
          peer.lastPing = Date.now();
        }
        break;
      }

      // ── Initial join ─────────────────────────────────────────────
      case 'join': {
        peers.set(peerId, { ws, deviceInfo: msg.deviceInfo, room: autoRoom, lastPing: Date.now(), waitingPong: false });
        addToRoom(autoRoom, peerId);

        safeSend(ws, { type: 'joined', peerId, room: autoRoom });
        notifyRoom(autoRoom, peerId);
        break;
      }

      // ── Join a specific room code (for QR / manual code) ────────
      case 'join-room': {
        const peer = peers.get(peerId);
        if (!peer) break;

        const newRoom = 'code-' + msg.roomCode;
        
        // Security: Check if room exists before allowing join to prevent brute force scraping
        if (!rooms.has(newRoom)) {
          let attempts = failedJoinAttempts.get(ip) || { count: 0, lockedUntil: 0 };
          attempts.count++;
          if (attempts.count >= MAX_FAILED_JOINS) {
            attempts.lockedUntil = Date.now() + LOCKOUT_DURATION;
            console.warn(`[SECURITY] IP ${ip} locked out for ${LOCKOUT_DURATION/1000}s due to too many invalid room attempts.`);
          }
          failedJoinAttempts.set(ip, attempts);
          
          safeSend(ws, { type: 'error', message: 'Invalid room code' });
          if (attempts.count >= MAX_FAILED_JOINS) {
             ws.close(1008, 'Temporarily blocked due to too many failed room attempts');
          }
          break;
        }

        // Reset failed attempts on successful join
        failedJoinAttempts.delete(ip);

        // Leave previous room
        removeFromRoom(peer.room, peerId);
        broadcastLeft(peer.room, peerId);

        peer.room = newRoom;
        addToRoom(newRoom, peerId);

        safeSend(ws, { type: 'joined-room', room: newRoom, roomCode: msg.roomCode });
        notifyRoom(newRoom, peerId);
        break;
      }

      // ── Leave room code and return to auto room ─────────────────
      case 'leave-room': {
        const peer2 = peers.get(peerId);
        if (!peer2) break;

        removeFromRoom(peer2.room, peerId);
        broadcastLeft(peer2.room, peerId);

        peer2.room = autoRoom;
        addToRoom(autoRoom, peerId);

        safeSend(ws, { type: 'joined', peerId, room: autoRoom });
        notifyRoom(autoRoom, peerId);
        break;
      }

      // ── WebRTC signaling relay ──────────────────────────────────
      case 'signal': {
        const target = peers.get(msg.targetId);
        console.log(`[SIGNAL] ${peerId} -> ${msg.targetId} : ${msg.signal?.type}`);
        if (target) {
          safeSend(target.ws, {
            type: 'signal',
            from: peerId,
            signal: msg.signal,
            deviceInfo: peers.get(peerId)?.deviceInfo,
          });
        } else {
          console.log(`[SIGNAL ERROR] Target ${msg.targetId} not found`);
        }
        break;
      }

      // ── Generate a room code ────────────────────────────────────
      case 'create-room': {
        const roomCode = generateRoomCode();
        const peer3 = peers.get(peerId);
        if (!peer3) break;

        removeFromRoom(peer3.room, peerId);
        broadcastLeft(peer3.room, peerId);

        const newRoom2 = 'code-' + roomCode;
        peer3.room = newRoom2;
        addToRoom(newRoom2, peerId);

        safeSend(ws, { type: 'room-created', roomCode });
        break;
      }

      // ── Bluetooth pairing request (Device A → Device B) ────────
      case 'bt-pair-request': {
        const targetPeer = peers.get(msg.targetId);
        if (targetPeer) {
          safeSend(targetPeer.ws, {
            type: 'bt-pair-request',
            from: peerId,
            deviceInfo: peers.get(peerId)?.deviceInfo,
          });
          console.log(`[BT] Pair request: ${peerId} → ${msg.targetId}`);
        }
        break;
      }

      // ── Bluetooth pairing response (Device B → Device A) ───────
      case 'bt-pair-response': {
        const requesterPeer = peers.get(msg.targetId);
        if (requesterPeer) {
          safeSend(requesterPeer.ws, {
            type: 'bt-pair-response',
            from: peerId,
            accepted: msg.accepted,
            deviceInfo: peers.get(peerId)?.deviceInfo,
          });
          console.log(`[BT] Pair response: ${peerId} → ${msg.targetId} (${msg.accepted ? 'ACCEPTED' : 'REJECTED'})`);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const peer = peers.get(peerId);
    if (peer) {
      removeFromRoom(peer.room, peerId);
      broadcastLeft(peer.room, peerId);
      peers.delete(peerId);
    }
    stats.activeConnections--;
    console.log(`⚡ Peer disconnected: ${peerId} [Active: ${stats.activeConnections}]`);
  });

  ws.on('error', () => {
    // handled by close
  });
});

// ─── Stats endpoint ────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    activePeers: peers.size,
    activeRooms: rooms.size,
    uptime: process.uptime(),
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ⚡ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ⚡  Allowme Server Running!');
  console.log(`  ⚡  Local:    http://localhost:${PORT}`);
  console.log('  ⚡  Features: TURN relay · Heartbeat · Auto-cleanup');
  console.log('  ⚡  Open this URL on any device to start sharing.');
  console.log('  ⚡ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
