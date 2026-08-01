/**
 * signaling.js — WebSocket signaling client for Allowme.
 * Handles device discovery, room management, WebRTC signal relay,
 * TURN credential fetching, heartbeat, and reconnect with room restore.
 */

export class SignalingClient {
  constructor() {
    this.ws = null;
    this.peerId = null;
    this.room = null;
    this.roomCode = null;
    localStorage.removeItem('allowme_room');
    this.turnServers = null;
    this._handlers = {};
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._intentionalClose = false;
    this._lastDeviceInfo = null;
  }

  /**
   * Fetch TURN credentials from the server before connecting.
   */
  async fetchTurnCredentials() {
    try {
      const res = await fetch('/api/turn-credentials');
      const data = await res.json();
      this.turnServers = data.iceServers;
      console.log('⚡ TURN credentials loaded:', this.turnServers.length, 'servers');
      return this.turnServers;
    } catch (e) {
      console.warn('⚡ Failed to fetch TURN credentials, using defaults:', e);
      this.turnServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
      return this.turnServers;
    }
  }

  /**
   * Connect to the WebSocket signaling server.
   * @param {object} deviceInfo - Device info to register with server
   * @param {string} [room] - Optional room code to join
   */
  connect(deviceInfo, room) {
    this._intentionalClose = false;
    this._lastDeviceInfo = deviceInfo || this._lastDeviceInfo;
    this._pendingRoom = room;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('WebSocket connection failed:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('⚡ Signaling connected');
      this._reconnectDelay = 1000; // reset backoff
      this._emit('connected');

      // Auto-join with device info
      if (this._lastDeviceInfo) {
        this._send({ type: 'join', deviceInfo: this._lastDeviceInfo });
      }
      // Auto-join room if specified
      if (this._pendingRoom) {
        this._send({ type: 'join-room', roomCode: this._pendingRoom });
        this._pendingRoom = null;
      }
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      // Handle server heartbeat
      if (msg.type === 'ping') {
        this._send({ type: 'pong', ts: msg.ts });
        return;
      }

      // Store own peer ID when server confirms join
      if (msg.type === 'joined') {
        this.peerId = msg.peerId;
        this.room = msg.room;
      }
      if (msg.type === 'joined-room') {
        this.room = msg.room;
        this.roomCode = msg.roomCode;
        localStorage.setItem('allowme_room', msg.roomCode);
        localStorage.setItem('allowme_room', msg.roomCode);
      }
      if (msg.type === 'room-created') {
        this.roomCode = msg.roomCode;
      }

      this._emit(msg.type, msg);
    };

    this.ws.onclose = () => {
      console.log('⚡ Signaling disconnected');
      this._emit('disconnected');
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('⚡ Signaling error:', err);
    };
  }

  /**
   * Exponential backoff reconnection with room restore.
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) return;

    console.log(`⚡ Reconnecting in ${this._reconnectDelay / 1000}s...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
      this.connect();
    }, this._reconnectDelay);
  }

  /**
   * Send the initial join message with device info.
   */
  join(deviceInfo) {
    this._lastDeviceInfo = deviceInfo;
    this._send({ type: 'join', deviceInfo });
  }

  /**
   * Rejoin with stored device info (after reconnect).
   */
  rejoin() {
    if (this._lastDeviceInfo) {
      this.join(this._lastDeviceInfo);
    }
  }

  /**
   * Request the server to create a new room and return a code.
   */
  createRoom() {
    this._send({ type: 'create-room' });
  }

  /**
   * Join an existing room by its 6-digit code.
   */
  joinRoom(roomCode) {
    this._send({ type: 'join-room', roomCode });
  }

  /**
   * Leave the current room code and return to auto-discovery.
   */
  leaveRoom() {
    this.roomCode = null;
    this._send({ type: 'leave-room' });
  }

  /**
   * Send a WebRTC signaling message to a specific peer.
   */
  signal(targetId, signalData) {
    this._send({ type: 'signal', targetId, signal: signalData });
  }

  /**
   * Cleanly disconnect.
   */
  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Internal Helpers ──────────────────────────────────────

  /** Public API for sending messages */
  send(data) {
    this._send(data);
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this; // chainable
  }

  off(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== handler);
    }
    return this;
  }

  _emit(event, data) {
    const handlers = this._handlers[event];
    if (handlers) {
      handlers.forEach(h => {
        try {
          h(data);
        } catch (e) {
          console.error(`Handler error for event "${event}":`, e);
        }
      });
    }
  }
}
